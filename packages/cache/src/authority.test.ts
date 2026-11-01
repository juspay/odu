/**
 * THE ROW'S AUTHORITY RULE, held at the row.
 *
 * The cache decides who may administer a bucket; the host only says who is
 * asking. Two rules, and exactly one applies:
 *
 *   - **loopback**: the operator's root token, compared with `$ODU_ROOT_TOKEN`.
 *     This is the rule that must not move — every existing CLI and browser test
 *     runs under it.
 *   - **signed in**: the caller's ROLE. An `admin` or an `owner` may; a `member`
 *     may not, and is refused with `not_permitted` before the engine is asked.
 *     A daemon with an identity provider mounted need not have a root token at
 *     all, which is why `viaRole` is an arm of its own rather than a special
 *     token value.
 *
 * Reads are not administration: `bucket.describe` and `bucket.paths` answer for
 * a member, because a bucket's URL, key and path list are what the substituter
 * already publishes to anyone who can read it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import { implementSurface } from "@kolu/surface/server";
import { CurrentPrincipal, type Principal } from "@odu/cordis/principal";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { createCache } from "./cache";
import { cacheServer } from "./server";
import { CacheRefused, oduCacheSurface } from "./surface";

/** The cache's spec-precise client — the shape `odu cache` holds. */
type CacheClient = SurfaceClientOf<(typeof oduCacheSurface)["spec"]>;

const ROOT = "operator-root";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-cache-authority-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The cache's procedures, dialled the in-process way a face does — so what is
 *  exercised is the surface's own dispatch, not a private handle. */
function face(rootToken: string | null) {
  const cache = createCache({ stateRoot: scratch, rootToken });
  const server = cacheServer({
    cache,
    publicOrigin: "http://cache.test",
    mount: "/cache",
  });
  const runtime = implementSurface(oduCacheSurface, server.deps);
  return {
    // The same cast the CLI makes at its own client: the framework's spec-
    // precise face is built over the spec-erased dispatch.
    client: buildSurfaceFace(
      oduCacheSurface,
      directDispatch(runtime),
    ) as unknown as CacheClient,
    close: () => {
      server.detach();
      return cache.close();
    },
  };
}

/** One call, with an admission when there is a person behind it. */
function ask<A>(
  effect: Effect.Effect<A, unknown>,
  principal?: Principal,
): Promise<{ ok: true; value: A } | { ok: false; error: unknown }> {
  const admission =
    principal === undefined
      ? undefined
      : { principal, live: () => true, ended: Effect.never };
  const provided =
    admission === undefined
      ? effect
      : Effect.provideService(effect, CurrentPrincipal, admission);
  return Effect.runPromise(
    Effect.map(Effect.result(provided), (result) =>
      result._tag === "Success"
        ? { ok: true as const, value: result.success }
        : { ok: false as const, error: result.failure },
    ),
  );
}

/** The refusal a call carried, proved to be the cache's own tagged error —
 *  which is the shape a face branches on. */
function refusedWith(error: unknown): CacheRefused {
  if (error instanceof CacheRefused) return error;
  throw new Error(`expected a CacheRefused, got ${String(error)}`);
}

const bucketInput = {
  name: "team-app",
  public: true,
  retentionDays: 90,
};

const signedIn = (role: "owner" | "admin" | "member"): Principal => ({
  kind: "user",
  login: "srid",
  role,
});

describe("loopback: the root token is still the rule", () => {
  it("refuses an administrator whose token does not match", async () => {
    const { client, close } = face(ROOT);
    try {
      const answer = await ask(client.surface.bucket.create({ ...bucketInput, rootToken: "nope" }));
      expect(answer.ok).toBe(false);
      if (answer.ok) return;
      expect(refusedWith(answer.error).code).toBe("no_root_token");
    } finally {
      await close();
    }
  });

  it("creates for the operator's token, and refuses when the daemon has none", async () => {
    const withToken = face(ROOT);
    try {
      const answer = await ask(withToken.client.surface.bucket.create({ ...bucketInput, rootToken: ROOT }));
      expect(answer.ok).toBe(true);
    } finally {
      await withToken.close();
    }
    const without = face(null);
    try {
      const answer = await ask(without.client.surface.bucket.create({ ...bucketInput, rootToken: "" }));
      expect(answer.ok).toBe(false);
    } finally {
      await without.close();
    }
  });
});

describe("signed in: the role is the rule", () => {
  it("refuses a role authority the row did not mint", async () => {
    // THE SEAL, not the discriminant: `kind: "role"` is a string any in-package
    // caller can write, and the engine must not take the word for the thing.
    // (`Authority` never crosses the surface — this is the engine's own
    // boundary, which is exactly where the seal has to hold.)
    const cache = createCache({ stateRoot: scratch, rootToken: null });
    try {
      const forged = { kind: "role", login: "srid" } as unknown as Parameters<
        typeof cache.admin.create
      >[0]["authority"];
      const answer = await cache.admin.create({
        ...bucketInput,
        upstreamKeys: [],
        authority: forged,
      });
      expect(answer.ok).toBe(false);
      if (answer.ok) return;
      expect(answer.code).toBe("no_root_token");
    } finally {
      await cache.close();
    }
  });

  it("refuses a member, naming the role", async () => {
    // NO ROOT TOKEN AT ALL: with an identity provider mounted the daemon need
    // not have one, so a role-authorised call cannot be a token in disguise.
    const { client, close } = face(null);
    try {
      const answer = await ask(
        client.surface.bucket.create({ ...bucketInput, rootToken: "" }),
        signedIn("member"),
      );
      expect(answer.ok).toBe(false);
      if (answer.ok) return;
      const refusal = refusedWith(answer.error);
      expect(refusal.code).toBe("not_permitted");
      expect(refusal.message).toContain("is a member");
    } finally {
      await close();
    }
  });

  it("creates for an admin and for an owner, with no root token set", async () => {
    for (const role of ["admin", "owner"] as const) {
      const { client, close } = face(null);
      try {
        const answer = await ask(
          client.surface.bucket.create(
            { ...bucketInput, name: `team-${role}`, rootToken: "" },
          ),
          signedIn(role),
        );
        expect(answer.ok, `${role} was refused`).toBe(true);
      } finally {
        await close();
      }
    }
  });

  it("a member may LIST buckets — the board is not an admin's to read", async () => {
    const { client, close } = face(ROOT);
    try {
      const created = await ask(client.surface.bucket.create({ ...bucketInput, rootToken: ROOT }));
      expect(created.ok).toBe(true);
      const listed = await ask(
        client.surface.bucket.list({ rootToken: "" }),
        signedIn("member"),
      );
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.buckets.map((bucket) => bucket.name)).toEqual([bucketInput.name]);
      // …while ADMINISTRATION stays refused at the same role.
      const refused = await ask(
        client.surface.bucket.create({ ...bucketInput, name: "team-two", rootToken: "" }),
        signedIn("member"),
      );
      expect(refused.ok).toBe(false);
    } finally {
      await close();
    }
  });

  it("a member may still read a bucket's public identity", async () => {
    const { client, close } = face(ROOT);
    try {
      const created = await ask(
        client.surface.bucket.create({ ...bucketInput, rootToken: ROOT }),
      );
      expect(created.ok).toBe(true);
      const described = await ask(
        client.surface.bucket.describe({ bucket: bucketInput.name }),
        signedIn("member"),
      );
      expect(described.ok).toBe(true);
    } finally {
      await close();
    }
  });
});
