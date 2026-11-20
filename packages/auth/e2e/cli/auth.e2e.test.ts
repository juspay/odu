import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  buildOduBinary,
  makeFixture,
  removeNow,
  suitePortFor,
} from "../../../../tests/e2e/harness";
import {
  startWebService,
  type WebWorld,
} from "../../../../tests/e2e/webHarness";
import { startGithubStub, type GithubStub } from "../../../web-acceptance/support/githubStub";
import { openAuthRepo, sha256 } from "../../src/db";

const ROOT_TOKEN = "e2e-auth-root";
const LOGIN = "srid";
const CLIENT_ID = "e2e-client-id";
const CLIENT_SECRET = "e2e-client-secret";

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
      ODU_PUBLIC_ORIGIN: origin,
      ODU_GITHUB_CLIENT_ID: CLIENT_ID,
      ODU_GITHUB_CLIENT_SECRET_FILE: secretFile,
      ODU_GITHUB_ALLOW: "org:juspay",
      ODU_GITHUB_ORIGIN: stub.origin,
      ODU_GITHUB_API: stub.origin,
    },
    port,
  );

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
}, 900_000);

afterAll(() => {
  world?.dispose();
  void stub?.close();
  if (secretDir !== undefined) rmSync(secretDir, { recursive: true, force: true });
});

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

function verb(row: string, name: string, input?: unknown, env: NodeJS.ProcessEnv = {}) {
  return cli(
    [
      "surface",
      row,
      name,
      ...(input === undefined ? [] : ["--input", JSON.stringify(input)]),
      "--json",
    ],
    env,
  );
}

describe("$ODU_TOKEN drives a command against a server with a door", () => {
  it("answers whoami as the token's person", () => {
    const answer = verb("auth", "user_whoami", undefined, { ODU_TOKEN: token });
    expect(answer.stderr).toBe("");
    expect(answer.status).toBe(0);
    const { who } = JSON.parse(answer.stdout) as {
      who: { kind: string; login: string; role: string };
    };
    expect(who).toEqual({ kind: "user", login: LOGIN, role: "owner" });
  });

  it("lets an owner administer the cache, which no token-less caller can", () => {
    const denied = verb("cache", "bucket_list", { rootToken: "" });
    expect(denied.status).toBe(1);

    const allowed = verb("cache", "bucket_list", { rootToken: "" }, { ODU_TOKEN: token });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ buckets: [] });
  });

  it("answers anonymous for a token this daemon never minted", () => {
    const answer = verb("auth", "user_whoami", undefined, { ODU_TOKEN: "odu_not_a_token" });
    expect(answer.status).toBe(0);
    expect(JSON.parse(answer.stdout)).toEqual({ who: { kind: "anonymous" } });
  });
});

describe("odu auth login stores the token, and --origin uses it", () => {
  it("writes a credential for the origin and reaches the server with it", () => {
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

      const whoami = Bun.spawnSync(
        [odu, "surface", "auth", "user_whoami", "--origin", world.origin, "--json"],
        { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" },
      );
      expect(whoami.exitCode, whoami.stderr.toString()).toBe(0);
      expect(JSON.parse(whoami.stdout.toString())).toEqual({
        who: { kind: "user", login: LOGIN, role: "owner" },
      });
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

describe("the door's HTTP legs", () => {
  it("answers an anonymous browser with the sign-in page on every shell path", async () => {
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

  it("advertises the door's eight verbs beside the shared ones", async () => {
    const client = await bridge({ ...world.env, ODU_TOKEN: token });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("auth_")).sort()).toEqual([
        "auth_grant_list",
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
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("odu ci run --checkout against a server with a door", () => {
  let fixture: string;
  let head: string;

  beforeAll(() => {
    fixture = makeFixture("pass");
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture,
      encoding: "utf-8",
    }).trim();
  });

  afterAll(() => {
    if (fixture !== undefined) removeNow(fixture);
  });

  function runThere(sha: string, extra: string[] = []) {
    return cli(
      [
        "ci",
        "run",
        "--checkout",
        fixture,
        "--sha",
        sha,
        "--origin",
        world.origin,
        "--no-post",
        "--no-wait",
        "-o",
        "json",
        ...extra,
      ],
      { ODU_TOKEN: token },
    );
  }

  it("refuses a commit the named checkout is not on", () => {
    const moved = runThere("0".repeat(40));
    expect(moved.status).not.toBe(0);
    expect(`${moved.stdout}${moved.stderr}`).toContain("moved since you read it");
  });

  it("starts the run there, and the run says who started it", () => {
    const started = runThere(head);
    expect(started.status, started.stderr).toBe(0);
    const receipt = JSON.parse(started.stdout) as { runId: string; accepted: boolean };
    expect(receipt.accepted).toBe(true);

    const read = cli(
      ["surface", "run_read", "--input", JSON.stringify({ runId: receipt.runId }), "--json"],
      { ODU_TOKEN: token },
    );
    expect(read.status, read.stderr).toBe(0);
    const answer = JSON.parse(read.stdout) as { actor?: string };
    expect(answer.actor).toBe(LOGIN);
  });
});
