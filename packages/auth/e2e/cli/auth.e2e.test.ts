/**
 * THE DOOR, THROUGH THE COMMAND LINE AND AN AGENT — a black-box run.
 *
 * What only a process-level test can show, and a browser scenario cannot:
 *
 *   - `$ODU_TOKEN` (or a token `odu auth login` stored) is what makes
 *     `odu … --origin` work against a server with a door — the credential rides
 *     the websocket UPGRADE, so a face that forgot it would see an empty board
 *     rather than an error;
 *   - an anonymous `/mcp` POST is `401` at the HTTP door;
 *   - the stdio bridge `odu mcp` inherits the same refusal: with no token its
 *     tool calls fail, with `$ODU_TOKEN` they answer as the person.
 *
 * The session itself (which needs a browser to complete) is the browser suite's
 * business; this file seeds one personal token directly into `auth.sqlite` —
 * the file the row documents — and tests the machine-facing half.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  buildOduBinary,
  suitePortFor,
} from "../../../../tests/e2e/harness";
import {
  startWebService,
  type WebWorld,
} from "../../../../tests/e2e/webHarness";
import { startGithubStub, type GithubStub } from "../../../web-acceptance/support/githubStub";
import { openAuthRepo } from "../../src/db";

const ROOT_TOKEN = "e2e-auth-root";
const LOGIN = "srid";
/** The App's credentials the stub does not check. */
const CLIENT_ID = "e2e-client-id";
const CLIENT_SECRET = "e2e-client-secret";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

let odu: string;
let world: WebWorld;
let stub: GithubStub;
let secretDir: string;
let token: string;

beforeAll(async () => {
  odu = buildOduBinary();
  stub = await startGithubStub(suitePortFor("authStub"));
  secretDir = mkdtempSync(join(tmpdir(), "odu-e2e-auth-"));
  const secretFile = join(secretDir, "client-secret");
  writeFileSync(secretFile, `${CLIENT_SECRET}\n`, { mode: 0o600 });

  const port = suitePortFor("authCli");
  const origin = `http://127.0.0.1:${port}`;
  world = await startWebService(
    odu,
    {
      ODU_ROOT_TOKEN: ROOT_TOKEN,
      // The terminator names the public origin: the callback URL is this
      // daemon's own loopback address.
      ODU_PUBLIC_ORIGIN: origin,
      ODU_GITHUB_CLIENT_ID: CLIENT_ID,
      ODU_GITHUB_CLIENT_SECRET_FILE: secretFile,
      ODU_GITHUB_ALLOW: "org:juspay",
      ODU_GITHUB_ORIGIN: stub.origin,
      ODU_GITHUB_API: stub.origin,
    },
    port,
  );

  // THE FIRST OWNER, and a personal token for them — the two facts a person
  // obtains through the browser, written straight into the row's own file so
  // this suite can test the machine-facing half without a browser.
  const state = world.env.ODU_STATE_DIR;
  if (state === undefined) throw new Error("e2e: the world has no ODU_STATE_DIR");
  const repo = openAuthRepo(join(state, "auth", "auth.sqlite"));
  token = `odu_${randomBytes(32).toString("base64url")}`;
  repo.setGrant({ login: LOGIN, role: "owner", created: Date.now() });
  repo.putToken({
    id: "e2e-seed",
    hash: sha256(token),
    login: LOGIN,
    name: "e2e",
    created: Date.now(),
    lastUsed: null,
    expires: null,
    revoked: false,
  });
  repo.close();
}, 900_000); // nix build, cold cache

afterAll(() => {
  world?.dispose();
  void stub?.close();
  if (secretDir !== undefined) rmSync(secretDir, { recursive: true, force: true });
});

/** `odu …` against the door's world, with whatever credential the caller names. */
function cli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const answer = Bun.spawnSync([odu, ...argv], {
    env: { ...world.env, ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: answer.exitCode,
    stdout: answer.stdout.toString(),
    stderr: answer.stderr.toString(),
  };
}

describe("$ODU_TOKEN drives a command against a server with a door", () => {
  it("answers whoami as the token's person", () => {
    const answer = cli(["auth", "whoami", "-o", "json"], { ODU_TOKEN: token });
    expect(answer.stderr).toBe("");
    expect(answer.status).toBe(0);
    const who = JSON.parse(answer.stdout) as { kind: string; login: string; role: string };
    expect(who).toEqual({ kind: "user", login: LOGIN, role: "owner" });
  });

  it("lets an owner administer the cache, which no token-less caller can", () => {
    const denied = cli(["cache", "list", "-o", "json"]);
    expect(denied.status).toBe(1);

    const allowed = cli(["cache", "list", "-o", "json"], { ODU_TOKEN: token });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ buckets: [] });
  });

  it("refuses a token this daemon never minted", () => {
    const answer = cli(["auth", "whoami", "-o", "json"], { ODU_TOKEN: "odu_not_a_token" });
    expect(answer.status).toBe(1);
    // ANONYMOUS is an ANSWER, not an error: the door says who you are, and this
    // connection is nobody. A caller that got exit 0 here would believe it had
    // a session.
    expect(answer.stdout).toContain("anonymous");
  });
});

describe("odu auth login stores the token, and --origin uses it", () => {
  it("writes a credential for the origin and reaches the server with it", () => {
    // A PRIVATE config home, so the run cannot touch the developer's own
    // `~/.config/odu/auth/credentials`.
    const configHome = mkdtempSync(join(tmpdir(), "odu-e2e-auth-home-"));
    const env = { ...world.env, XDG_CONFIG_HOME: configHome };
    try {
      const login = Bun.spawnSync([odu, "auth", "login", world.origin], {
        env: env as Record<string, string>,
        stdin: Buffer.from(`${token}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(login.exitCode, login.stderr.toString()).toBe(0);

      // NO `ODU_TOKEN`: the credential the login wrote is the only thing this
      // call has, and `--origin` is what picks it.
      const whoami = Bun.spawnSync(
        [odu, "auth", "whoami", "--origin", world.origin, "-o", "json"],
        { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" },
      );
      expect(whoami.exitCode, whoami.stderr.toString()).toBe(0);
      expect(JSON.parse(whoami.stdout.toString())).toEqual({
        kind: "user",
        login: LOGIN,
        role: "owner",
      });
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

describe("the door's HTTP legs", () => {
  it("answers an anonymous browser with the sign-in page on every shell path", async () => {
    // THE SERVING LAYER owns "which requests are the shell" (a `GET /*`
    // catch-all), so the gate no longer keeps its own two paths. What proves
    // the door over HTTP is therefore every path the shell would answer —
    // including the ones only the client's router knows (`/runs`) and a typo.
    for (const path of ["/", "/index.html", "/runs", "/cache/", "/no-such-page"]) {
      const response = await fetch(new URL(path, world.origin));
      expect(response.status, path).toBe(200);
      const body = await response.text();
      expect(body, path).toContain("Sign in to odu");
      expect(body, path).not.toContain("/assets/");
    }
  });

  it("still answers the cache's protocol paths as the protocol, not as the page", async () => {
    const response = await fetch(new URL("/cache/main/nix-cache-info", world.origin));
    // No bucket `main` on this daemon: the DAEMON's empty 404, untouched by the
    // door — the gate replaces an HTML 200 and nothing else.
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Sign in to odu");
  });
});

describe("the MCP door", () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0.0.0" },
    },
  };

  it("answers 401 to an anonymous POST", async () => {
    const response = await fetch(new URL("/mcp", world.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: world.origin,
        host: new URL(world.origin).host,
      },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(401);
  });

  it("admits one carrying the token", async () => {
    const response = await fetch(new URL("/mcp", world.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: world.origin,
        host: new URL(world.origin).host,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { result?: { serverInfo?: { name: string } } };
    expect(answer.result?.serverInfo?.name).toBe("odu");
  });
});

describe("odu mcp inherits the credential", () => {
  async function bridge(env: NodeJS.ProcessEnv) {
    const transport = new StdioClientTransport({
      command: odu,
      args: ["mcp", "--origin", world.origin],
      env: env as Record<string, string>,
    });
    const client = new Client({ name: "odu-e2e", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  it("answers a tool call as the person when $ODU_TOKEN is set", async () => {
    const client = await bridge({ ...world.env, ODU_TOKEN: token });
    try {
      const result = (await client.callTool({
        name: "auth_user_whoami",
        arguments: {},
      })) as { isError?: boolean; content?: { text?: string }[] };
      expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
      expect(result.content?.[0]?.text ?? "").toContain(LOGIN);
    } finally {
      await client.close();
    }
  });

  it("advertises the door's seven verbs beside the shared ones", async () => {
    // A DAEMON WITH A DOOR composes this row and the `/mcp` door advertises its
    // expose map beside the runs' and the cache's. The bridge ASKS the daemon
    // (`/_odu/door`) before it composes, so a loopback daemon's bridge does not
    // offer these seven — which is why this assertion lives here, at the door,
    // and not in the loopback suites.
    const client = await bridge({ ...world.env, ODU_TOKEN: token });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("auth_")).sort()).toEqual([
        "auth_session_end",
        "auth_session_list",
        "auth_token_create",
        "auth_token_list",
        "auth_token_revoke",
        "auth_user_grant",
        "auth_user_whoami",
      ]);
    } finally {
      await client.close();
    }
  });

  it("refuses a tool call when it is not", async () => {
    const client = await bridge(world.env);
    try {
      const result = (await client.callTool({
        name: "run_list",
        arguments: {},
      })) as { isError?: boolean };
      // The bridge itself connects (stdio), but the WIRE upgrade carries no
      // session and the gate serves it nothing but the identity reads — so the
      // call fails rather than answering with an empty board.
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
