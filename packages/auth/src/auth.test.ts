/**
 * THE DOOR, HELD TO ITS PROMISES — config, GitHub, and the row's own rules.
 *
 * Three groups, and each is a claim the feature would be lying about otherwise:
 *
 *   - **the environment** is absent, complete, or REFUSED — never half set;
 *   - **GitHub** is asked with no `scope`, and an EXPIRING user token is refused
 *     with a sentence naming the App setting rather than stored;
 *   - **the row** mints a session that a cookie resolves to, refuses a `member`
 *     an owner's verb, ends a connection when its token is revoked or its
 *     session expires, and lets the ROOT TOKEN bootstrap the first owner and
 *     nothing else.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import { implementSurface } from "@kolu/surface/server";
import type { SurfaceClientOf } from "@kolu/surface/project";
import {
  admissionFor,
  CurrentPrincipal,
  makeLease,
  type Admission,
} from "@odu/cordis/principal";
import { openAuthRepo } from "./db";
import {
  authorizeUrl,
  exchangeCode,
  membership,
  readAllow,
  readGithubConfig,
  type GithubConfig,
} from "./github";
import { authServer, bearerValue, SESSION_COOKIE, type AuthServer } from "./server";
import { AuthRefused, oduAuthSurface } from "./surface";

type AuthClient = SurfaceClientOf<(typeof oduAuthSurface)["spec"]>;

const ALLOW = "org:juspay";
const readAllowOrThrow = (spec: string) => {
  const reading = readAllow(spec);
  if (!reading.ok) throw new Error(reading.message);
  return reading.rules;
};

const CONFIG: GithubConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  allow: ALLOW,
  rules: readAllowOrThrow(ALLOW),
  origin: "https://github.test",
  api: "https://api.github.test",
  publicOrigin: "https://odu.test",
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-auth-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The row, with a real database under a temp root. */
function row(over: { rootToken?: string | null; now?: () => number } = {}) {
  const repo = openAuthRepo(join(scratch, "auth.sqlite"));
  const server = authServer({
    config: CONFIG,
    repo,
    rootToken: over.rootToken ?? null,
    ...(over.now === undefined ? {} : { now: over.now }),
  });
  const runtime = implementSurface(oduAuthSurface, server.deps);
  const client = buildSurfaceFace(
    oduAuthSurface,
    directDispatch(runtime),
  ) as unknown as AuthClient;
  return { server, client, repo };
}

/** One call as a given admission. */
function as<A>(
  effect: Effect.Effect<A, unknown>,
  admission: Admission,
): Promise<{ ok: true; value: A } | { ok: false; error: unknown }> {
  return Effect.runPromise(
    Effect.map(
      Effect.result(Effect.provideService(effect, CurrentPrincipal, admission)),
      (result) =>
        result._tag === "Success"
          ? { ok: true as const, value: result.success }
          : { ok: false as const, error: result.failure },
    ),
  );
}

const admit = (login: string, role: "owner" | "admin" | "member"): Admission =>
  admissionFor(makeLease({ kind: "user", login, role }).lease);

const refusal = (error: unknown): AuthRefused => {
  if (error instanceof AuthRefused) return error;
  throw new Error(`expected an AuthRefused, got ${String(error)}`);
};

// ── the environment ─────────────────────────────────────────────────────────

describe("the authorization header", () => {
  // THE PARSER DECIDES WHETHER A REQUEST IS SIGNED IN, so its edges are
  // promises: the scheme is case-insensitive, the gap is one or more spaces
  // (a proxy may re-fold them), and anything else is nobody.
  it("takes the token after the scheme, whatever the spacing", () => {
    expect(bearerValue("Bearer abc")).toBe("abc");
    expect(bearerValue("bearer abc")).toBe("abc");
    expect(bearerValue("Bearer    abc")).toBe("abc");
    expect(bearerValue("Bearer\tabc")).toBe("abc");
    expect(bearerValue("  Bearer abc  ")).toBe("abc");
  });

  it("answers null for anything that is not a bearer token", () => {
    expect(bearerValue(undefined)).toBeNull();
    expect(bearerValue("")).toBeNull();
    expect(bearerValue("Bearer")).toBeNull();
    expect(bearerValue("Bearerabc")).toBeNull();
    expect(bearerValue("Basic abc")).toBeNull();
  });
});

describe("the door's configuration", () => {
  const origins = { publicOrigin: "https://odu.test", boundOrigin: "http://127.0.0.1:18440" };

  it("is absent when nothing is configured — loopback mode", () => {
    expect(readGithubConfig({}, origins).kind).toBe("absent");
  });

  it("refuses a HALF-set environment, naming what is missing", () => {
    const reading = readGithubConfig({ ODU_GITHUB_CLIENT_ID: "id" }, origins);
    expect(reading.kind).toBe("refused");
    if (reading.kind !== "refused") return;
    expect(reading.message).toContain("ODU_GITHUB_CLIENT_SECRET_FILE");
    expect(reading.message).toContain("ODU_GITHUB_ALLOW");
  });

  it("refuses a MALFORMED allow entry, naming it", () => {
    const secret = join(scratch, "secret");
    writeFileSync(secret, "shhh\n");
    const read = (allow: string) =>
      readGithubConfig(
        {
          ODU_GITHUB_CLIENT_ID: "id",
          ODU_GITHUB_CLIENT_SECRET_FILE: secret,
          ODU_GITHUB_ALLOW: allow,
        },
        origins,
      );
    for (const bad of ["team:juspay", "org:", "team:/platform", "not a login!"]) {
      const reading = read(bad);
      expect(reading.kind, bad).toBe("refused");
      if (reading.kind !== "refused") continue;
      expect(reading.message).toContain(bad.split(",")[0] as string);
    }
    expect(read("org:juspay,team:juspay/platform,srid").kind).toBe("config");
  });

  it("reads a complete one, with the public origin as the callback's", () => {
    const secret = join(scratch, "secret");
    writeFileSync(secret, "shhh\n");
    const reading = readGithubConfig(
      {
        ODU_GITHUB_CLIENT_ID: "id",
        ODU_GITHUB_CLIENT_SECRET_FILE: secret,
        ODU_GITHUB_ALLOW: "org:juspay, srid",
      },
      origins,
    );
    expect(reading.kind).toBe("config");
    if (reading.kind !== "config") return;
    expect(reading.config.clientSecret).toBe("shhh");
    expect(reading.config.publicOrigin).toBe("https://odu.test");
    expect(reading.config.origin).toBe("https://github.com");
    expect(reading.config.api).toBe("https://api.github.com");
    // PARSED ONCE, at startup: the config carries the rules a sign-in acts on.
    expect(reading.config.rules).toEqual([
      { kind: "org", org: "juspay" },
      { kind: "login", login: "srid" },
    ]);
  });
});

// ── GitHub ──────────────────────────────────────────────────────────────────

/** A GitHub that answers exactly one canned thing per URL. */
function stubFetch(answer: (url: string) => { status?: number; body: unknown }) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const { status = 200, body } = answer(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("the GitHub App's flow", () => {
  it("sends NO scope — the App's permissions are the scope", () => {
    const url = new URL(authorizeUrl(CONFIG, "nonce.mac"));
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("state")).toBe("nonce.mac");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://odu.test/auth/github/callback",
    );
  });

  it("refuses an EXPIRING user token, naming the App setting", async () => {
    const exchange = await exchangeCode(
      CONFIG,
      "code",
      stubFetch(() => ({ body: { access_token: "t", expires_in: 28_800 } })),
    );
    expect(exchange.ok).toBe(false);
    if (exchange.ok) return;
    expect(exchange.message).toContain("Expire user authorization tokens");
  });

  it("accepts a token that does not expire", async () => {
    const exchange = await exchangeCode(
      CONFIG,
      "code",
      stubFetch(() => ({ body: { access_token: "t", token_type: "bearer" } })),
    );
    expect(exchange).toEqual({ ok: true, token: "t" });
  });

  it("asks org and team membership with the PERSON's token", async () => {
    const asked: string[] = [];
    const request = stubFetch((url) => {
      asked.push(url);
      return url.includes("/teams/")
        ? { body: { state: "active" } }
        : { status: 404, body: {} };
    });
    const answer = await membership(
      {
        ...CONFIG,
        allow: "org:other, team:juspay/platform",
        rules: readAllowOrThrow("org:other, team:juspay/platform"),
      },
      "user-token",
      "srid",
      request,
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.rule).toEqual({ kind: "team", org: "juspay", slug: "platform" });
    expect(asked.some((url) => url.includes("/user/memberships/orgs/other"))).toBe(true);
    expect(asked.some((url) => url.includes("/orgs/juspay/teams/platform/memberships/srid"))).toBe(
      true,
    );
  });

  it("refuses a login the list does not name, and quotes the list", async () => {
    const answer = await membership(CONFIG, "user-token", "someone", stubFetch(() => ({ status: 404, body: {} })));
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.message).toContain("org:juspay");
  });
});

// ── the row ─────────────────────────────────────────────────────────────────

describe("the row's authority", () => {
  it("mints a session a cookie resolves to, and ends it on sign-out", () => {
    const { server } = row();
    const { cookie } = server.signIn({ login: "srid", agent: "test" });
    const lease = server.resolver.acquire({ cookie: `${SESSION_COOKIE}=${cookie}` });
    expect(lease?.principal).toEqual({ kind: "user", login: "srid", role: "member" });

    let ended = 0;
    lease?.watch(() => {
      ended += 1;
    });
    expect(server.signOut(cookie)).toBe(true);
    expect(ended).toBe(1);
    // The cookie is dead: a second connection carrying it is refused NOTHING,
    // which is the gate's cue to serve it anonymously.
    expect(server.resolver.acquire({ cookie: `${SESSION_COOKIE}=${cookie}` })).toBeNull();
  });

  it("resolves a personal token presented on the upgrade", async () => {
    const { server, client } = row();
    const minted = await as(
      client.surface.token.create({ name: "laptop" }),
      admit("srid", "member"),
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const lease = server.resolver.acquire({
      authorization: `Bearer ${minted.value.token}`,
    });
    expect(lease?.principal).toEqual({ kind: "user", login: "srid", role: "member" });
  });

  it("revoking a token ends the connections it opened", async () => {
    const { server, client } = row();
    const minted = await as(
      client.surface.token.create({ name: "laptop" }),
      admit("srid", "member"),
    );
    if (!minted.ok) throw new Error("mint failed");
    const lease = server.resolver.acquire({ authorization: `Bearer ${minted.value.token}` });
    let ended = 0;
    lease?.watch(() => {
      ended += 1;
    });
    const revoked = await as(
      client.surface.token.revoke({ id: minted.value.facts.id }),
      admit("srid", "member"),
    );
    expect(revoked.ok).toBe(true);
    expect(ended).toBe(1);
    expect(server.resolver.acquire({ authorization: `Bearer ${minted.value.token}` })).toBeNull();
  });

  it("an expired session stops being one, and the sweep ends its connection", () => {
    let now = 1_000_000;
    const { server } = row({ now: () => now });
    const { cookie } = server.signIn({ login: "srid", agent: null });
    const lease = server.resolver.acquire({ cookie: `${SESSION_COOKIE}=${cookie}` });
    let ended = 0;
    lease?.watch(() => {
      ended += 1;
    });
    now += 40 * 24 * 60 * 60 * 1000;
    expect(server.resolver.acquire({ cookie: `${SESSION_COOKIE}=${cookie}` })).toBeNull();
    server.sweep();
    expect(ended).toBe(1);
  });

  it("refuses a member the owner's grant, and refuses an anonymous caller without the root token", async () => {
    const { client } = row({ rootToken: "operator" });
    const member = await as(
      client.surface.user.grant({ login: "other", role: "admin", rootToken: "" }),
      admit("srid", "member"),
    );
    expect(member.ok).toBe(false);
    if (member.ok) return;
    expect(refusal(member.error).code).toBe("not_permitted");

    const anonymous = await as(
      client.surface.user.grant({ login: "other", role: "admin", rootToken: "wrong" }),
      admissionFor(null),
    );
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) return;
    expect(refusal(anonymous.error).code).toBe("not_permitted");
  });

  it("refuses the ROOT TOKEN for anything but the first OWNER", async () => {
    const { client } = row({ rootToken: "operator" });

    // A role that is not `owner`, before anybody owns the daemon.
    const admin = await as(
      client.surface.user.grant({ login: "alice", role: "admin", rootToken: "operator" }),
      admissionFor(null),
    );
    expect(admin.ok).toBe(false);
    if (admin.ok) return;
    expect(refusal(admin.error).code).toBe("not_permitted");
    expect(refusal(admin.error).message).toContain("first OWNER");

    // …and once an owner exists, the root token is spent — for an owner grant
    // too, which is the second grant a bootstrap script is tempted to make.
    const first = await as(
      client.surface.user.grant({ login: "srid", role: "owner", rootToken: "operator" }),
      admissionFor(null),
    );
    expect(first.ok).toBe(true);
    const again = await as(
      client.surface.user.grant({ login: "alice", role: "owner", rootToken: "operator" }),
      admissionFor(null),
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(refusal(again.error).message).toContain("already has an owner");

    // An owner's session still grants, which is what the root token handed over.
    const byOwner = await as(
      client.surface.user.grant({ login: "alice", role: "admin", rootToken: "" }),
      admit("srid", "owner"),
    );
    expect(byOwner.ok).toBe(true);
  });

  it("matches a grant however the login is typed", async () => {
    const { client, server } = row();
    const granted = await as(
      client.surface.user.grant({ login: "Srid", role: "member", rootToken: "operator" }),
      admit("srid", "owner"),
    );
    expect(granted.ok && granted.value.login).toBe("srid");
    const { cookie } = server.signIn({ login: "srid", agent: null });
    expect(
      server.resolver.acquire({ cookie: `${SESSION_COOKIE}=${cookie}` })?.principal,
    ).toEqual({ kind: "user", login: "srid", role: "member" });
  });

  it("the ROOT TOKEN bootstraps the first owner, and that is its one job", async () => {
    const { client, server } = row({ rootToken: "operator" });
    const bootstrapped = await as(
      client.surface.user.grant({ login: "srid", role: "owner", rootToken: "operator" }),
      admissionFor(null),
    );
    expect(bootstrapped.ok).toBe(true);
    if (!bootstrapped.ok) return;
    expect(bootstrapped.value).toEqual({ login: "srid", role: "owner" });

    // …and the role is what the next connection arrives with.
    const { cookie } = server.signIn({ login: "srid", agent: null });
    const lease = server.resolver.acquire({ cookie: `${SESSION_COOKIE}=${cookie}` });
    expect(lease?.principal).toEqual({ kind: "user", login: "srid", role: "owner" });
  });

  it("whoami answers ANONYMOUS on a connection with no session — not an error", async () => {
    const { client } = row();
    const answer = await as(client.surface.user.whoami(), admissionFor(null));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.who).toEqual({ kind: "anonymous" });
  });

  it("grant.list answers who is in — grants AND signed-in logins — to an owner", async () => {
    const { client, server } = row({ rootToken: "operator" });
    await as(
      client.surface.user.grant({ login: "srid", role: "owner", rootToken: "operator" }),
      admissionFor(null),
    );
    await as(
      client.surface.user.grant({ login: "alice", role: "admin", rootToken: "" }),
      admit("srid", "owner"),
    );
    // Allowed in by GitHub, never granted: the person an owner opens the page
    // to promote, and the reason this is not just the grant table.
    server.signIn({ login: "bob", agent: null });
    server.signIn({ login: "srid", agent: null });

    const answer = await as(client.surface.grant.list(), admit("srid", "owner"));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.people.map(({ login, role, granted }) => ({ login, role, granted }))).toEqual([
      { login: "alice", role: "admin", granted: true },
      { login: "bob", role: "member", granted: false },
      { login: "srid", role: "owner", granted: true },
    ]);
    expect(answer.value.people.find((one) => one.login === "alice")?.lastSeen).toBeNull();
    expect(answer.value.people.find((one) => one.login === "bob")?.lastSeen).toBeNumber();
  });

  it("grant.list refuses an admin, and a connection with no session", async () => {
    const { client } = row({ rootToken: "operator" });
    const admin = await as(client.surface.grant.list(), admit("alice", "admin"));
    expect(admin.ok).toBe(false);
    if (admin.ok) return;
    expect(refusal(admin.error).code).toBe("not_permitted");

    const nobody = await as(client.surface.grant.list(), admissionFor(null));
    expect(nobody.ok).toBe(false);
    if (nobody.ok) return;
    expect(refusal(nobody.error).code).toBe("unauthenticated");
  });

  it("a member may list and revoke only their own tokens", async () => {
    const { client } = row();
    const first = await as(client.surface.token.create({ name: "a" }), admit("srid", "member"));
    if (!first.ok) throw new Error("mint failed");
    const other = await as(
      client.surface.token.revoke({ id: first.value.facts.id }),
      admit("someone-else", "member"),
    );
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(refusal(other.error).code).toBe("unknown");
  });
});
