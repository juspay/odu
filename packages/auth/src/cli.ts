/**
 * `odu auth` — the door's argv face.
 *
 * Three kinds of command, and the split is the same one the cache's CLI keeps:
 *
 *   - **administration** (`whoami`, `token …`, `grant`, `people`) is a client
 *     of the auth ROW's surface over the same connection every other command uses;
 *   - **`login`** writes a credential for an origin to this machine's disk and
 *     touches the service not at all — it is how a person who was given a token
 *     by the profile page (or by an admin) hands it to every other command;
 *   - **nothing** here reads an environment except where a credential comes
 *     from: which token to present, and where `~` is, are the caller's facts.
 *
 * The dial is a PORT, bound by the root, for the reason the cache's CLI gives:
 * starting a service is `@odu/host`'s job and a row never names the host.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceClientOf } from "@kolu/surface/project";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { composedClients } from "@odu/cordis/compose";
import { Effect } from "effect";
import { readAuthToken, saveAuthToken } from "./credentials";
import { serviceOrigin } from "@odu/service-client/endpoint";
import {
  AUTH_KEY,
  AuthRefused,
  oduAuthSurface,
  type AuthPerson,
  type AuthToken,
} from "./surface";

/** The credential store, for the root that dials on this machine's behalf. */
export {
  authCredentialsPath,
  authorizationHeaders,

  TOKEN_ENV,
} from "./credentials";

/** The auth row's typed client over a dispatch the caller already holds. */
export type AuthClient = SurfaceClientOf<(typeof oduAuthSurface)["spec"]>;

function authClientOver(dispatch: SurfaceDispatch): AuthClient {
  return composedClients(
    { [AUTH_KEY]: oduAuthSurface },
    dispatch,
  ).auth as unknown as AuthClient;
}

/** What the root binds: the way to the daemon, and nothing else. */
export interface AuthCliPorts {
  connect(origin: string | undefined): Promise<{
    dispatch: SurfaceDispatch;
    dispose: () => Promise<void>;
  }>;
}

export const AUTH_USAGE = `usage: odu auth <login|whoami|token|grant|people> [args]

login <origin> [--token T]    save this machine's personal access token for an
                              origin, in ~/.config/odu/auth/credentials (0600).
                              Reads the token from stdin when --token is absent
whoami [-o json]              who this machine is, as this daemon sees it.
                              Prints the answer and exits 1 when it is
                              \`anonymous\`: exit 0 would read as "you have a
                              session"
token create <name>           mint a personal access token. Shown ONCE
token list [-o json]          the tokens this machine's login owns
token revoke <id>             revoke one token, ending its connections at once
grant <login> <owner|admin|member>
                              set a person's role. An owner's verb — or the
                              operator's root token ($ODU_ROOT_TOKEN) on a
                              daemon with no owner yet, which is its one job.
                              The board's people page is the same control
people [-o json]              who is in: every grant, and every login that has
                              signed in, with the role each holds. An owner's
                              verb — the board's people page reads the same list

These verbs exist ONLY on a daemon with a door (\`ODU_GITHUB_*\` configured); with
none there is no auth row to call, and every caller is the daemon's local owner.

--origin URL names the server (default $ODU_WEB_ORIGIN or http://127.0.0.1:18440).
A token for that origin, or $ODU_TOKEN, is sent as \\\`Authorization: Bearer\\\` on
the websocket upgrade, so every other \\\`odu\\\` command reaches the server too.
`;

const REFUSED = 1;

async function withService(
  ports: AuthCliPorts,
  origin: string | undefined,
  use: (client: AuthClient) => Promise<number>,
): Promise<number> {
  let connection: Awaited<ReturnType<AuthCliPorts["connect"]>>;
  try {
    connection = await ports.connect(origin);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return REFUSED;
  }
  try {
    return await use(authClientOver(connection.dispatch));
  } finally {
    await connection.dispose();
  }
}

async function call<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<{ ok: true; value: A } | { ok: false; refusal: AuthRefused | null; error?: unknown }> {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (outcome._tag === "Success") return { ok: true, value: outcome.success };
  return outcome.failure instanceof AuthRefused
    ? { ok: false, refusal: outcome.failure }
    : { ok: false, refusal: null, error: outcome.failure };
}

function reportFailure(
  answer: { refusal: AuthRefused | null; error?: unknown },
  json: boolean,
): number {
  const message =
    answer.refusal !== null
      ? `odu: ${answer.refusal.message}`
      : `odu: the call did not complete — ${String(answer.error)}`;
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        answer.refusal === null
          ? { ok: false, error: message }
          : { ok: false, code: answer.refusal.code, message: answer.refusal.message },
        null,
        2,
      )}\n`,
    );
    return REFUSED;
  }
  process.stderr.write(`${message}\n`);
  return REFUSED;
}

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** One line from stdin, for a token typed by a person. */
async function readSecret(): Promise<string> {
  if (process.stdin.isTTY !== true) {
    // A PIPE THAT HAS ALREADY FINISHED IS AT EOF BEFORE AN ASYNC ITERATOR
    // ATTACHES, and Bun's iterator over such a stream yields NOTHING: a token
    // pasted by `Bun.spawnSync(…, { stdin: Buffer })` — exactly how the e2e
    // test and a script feed this command — read as no token at all. A
    // synchronous read of fd 0 drains whatever is there, finished or not.
    return readFileSync(0, "utf8").trim();
  }
  // A TERMINAL NEVER SENDS EOF, so the line is the end of the token.
  process.stderr.write("token: ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
    if (chunks.some((one) => one.includes("\n"))) break;
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

const originOption = { type: "string" } as const;
const outputOption = { type: "string", short: "o" } as const;

export async function authCommand(
  sub: string | undefined,
  rest: string[],
  ports: AuthCliPorts,
): Promise<number> {
  switch (sub) {
    case "login":
      return loginCommand(rest);
    case "whoami":
      return whoamiCommand(rest, ports);
    case "token":
      return tokenCommand(rest, ports);
    case "grant":
      return grantCommand(rest, ports);
    case "people":
      return peopleCommand(rest, ports);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(AUTH_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown auth sub-command "${sub}"\n${AUTH_USAGE}`);
      return 1;
  }
}

async function loginCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { token: { type: "string" } },
  });
  const origin = positionals[0];
  if (origin === undefined) {
    process.stderr.write(`odu: auth login needs an origin\n${AUTH_USAGE}`);
    return 1;
  }
  if (values.token !== undefined) {
    // A token in argv is a token in the shell's history and in every `ps` on
    // the machine. `--token` stays (a script may have nowhere else to put it),
    // and it says so once.
    process.stderr.write(
      "odu: `--token` puts the token in your shell history — omit it and paste " +
        "the token on stdin instead\n",
    );
  }
  const token = values.token ?? (await readSecret());
  if (token === "") {
    process.stderr.write("odu: no token given\n");
    return 1;
  }
  const path = await saveAuthToken(process.env, origin, token);
  process.stdout.write(`saved a token for ${origin} in ${path}\n`);
  return 0;
}

async function whoamiCommand(rest: string[], ports: AuthCliPorts): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { origin: originOption, output: outputOption },
  });
  const json = values.output === "json";
  return withService(ports, values.origin, async (client) => {
    const answer = await call(client.surface.user.whoami());
    if (!answer.ok) return reportFailure(answer, json);
    const who = answer.value.who;
    // THE ANSWER IS PRINTED, AND THE EXIT CODE SAYS WHETHER IT IS A PERSON.
    // `anonymous` is a real answer — a page before it signs in is one — but a
    // caller that exits 0 on it believes it has a session. `local` is a
    // principal (the owner of a daemon with no door) and exits 0.
    const signedIn = who.kind !== "anonymous";
    if (json) {
      emitJson(who);
      return signedIn ? 0 : 1;
    }
    process.stdout.write(
      who.kind === "user"
        ? `${who.login} (${who.role})\n`
        : who.kind === "local"
          ? "local owner (this daemon has no sign-in configured)\n"
          : "anonymous — this machine holds no credential for that server\n",
    );
    return signedIn ? 0 : 1;
  });
}

async function tokenCommand(rest: string[], ports: AuthCliPorts): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "create": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { origin: originOption, output: outputOption },
      });
      const name = positionals[0];
      if (name === undefined) {
        process.stderr.write(`odu: auth token create needs a name\n${AUTH_USAGE}`);
        return 1;
      }
      const json = values.output === "json";
      return withService(ports, values.origin, async (client) => {
        const answer = await call(client.surface.token.create({ name }));
        if (!answer.ok) return reportFailure(answer, json);
        if (json) {
          emitJson(answer.value);
          return 0;
        }
        process.stdout.write(
          `${answer.value.token}\n# shown once; keep it somewhere safe\n`,
        );
        return 0;
      });
    }
    case "list": {
      const { values } = parseArgs({
        args,
        options: { origin: originOption, output: outputOption },
      });
      const json = values.output === "json";
      return withService(ports, values.origin, async (client) => {
        const answer = await call(client.surface.token.list());
        if (!answer.ok) return reportFailure(answer, json);
        if (json) {
          emitJson(answer.value);
          return 0;
        }
        if (answer.value.tokens.length === 0) process.stdout.write("no tokens\n");
        for (const token of answer.value.tokens) printToken(token);
        return 0;
      });
    }
    case "revoke": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { origin: originOption },
      });
      const id = positionals[0];
      if (id === undefined) {
        process.stderr.write(`odu: auth token revoke needs a token id\n${AUTH_USAGE}`);
        return 1;
      }
      return withService(ports, values.origin, async (client) => {
        const answer = await call(client.surface.token.revoke({ id }));
        if (!answer.ok) return reportFailure(answer, false);
        process.stdout.write(`revoked ${id}\n`);
        return 0;
      });
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(AUTH_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown auth token sub-command "${sub}"\n${AUTH_USAGE}`);
      return 1;
  }
}

async function grantCommand(rest: string[], ports: AuthCliPorts): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { origin: originOption },
  });
  const [login, role] = positionals;
  if (login === undefined || (role !== "owner" && role !== "admin" && role !== "member")) {
    process.stderr.write(
      `odu: auth grant needs a login and a role (owner|admin|member)\n${AUTH_USAGE}`,
    );
    return 1;
  }
  // THE ROOT TOKEN TRAVELS ONLY WHEN IT IS THE CREDENTIAL. A caller holding a
  // personal token is an owner as far as this call is concerned; sending the
  // operator's secret with it would put the most powerful token on the wire for
  // no reason.
  const held = await readAuthToken(process.env, values.origin ?? serviceOrigin());
  return withService(ports, values.origin, async (client) => {
    const answer = await call(
      client.surface.user.grant({
        login,
        role,
        rootToken: held === null ? (process.env.ODU_ROOT_TOKEN ?? "") : "",
      }),
    );
    if (!answer.ok) return reportFailure(answer, false);
    process.stdout.write(`${answer.value.login} is now ${answer.value.role}\n`);
    return 0;
  });
}

async function peopleCommand(rest: string[], ports: AuthCliPorts): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { origin: originOption, output: outputOption },
  });
  const json = values.output === "json";
  return withService(ports, values.origin, async (client) => {
    const answer = await call(client.surface.grant.list());
    if (!answer.ok) return reportFailure(answer, json);
    if (json) {
      emitJson(answer.value);
      return 0;
    }
    if (answer.value.people.length === 0) process.stdout.write("nobody is in yet\n");
    for (const person of answer.value.people) printPerson(person);
    return 0;
  });
}

function printPerson(person: AuthPerson): void {
  process.stdout.write(
    `${person.login}  ${person.role}${person.granted ? "" : " (default)"}  ${
      person.lastSeen === null
        ? "never signed in"
        : `last seen ${new Date(person.lastSeen).toISOString().slice(0, 16)}`
    }\n`,
  );
}

function printToken(token: AuthToken): void {
  process.stdout.write(
    `${token.id}  ${token.name}  ` +
      `${
        token.revoked
          ? "revoked"
          : token.expires === null
            ? "no expiry"
            : `expires ${new Date(token.expires).toISOString().slice(0, 10)}`
      }  ${
        token.lastUsed === null
          ? "never used"
          : `last used ${new Date(token.lastUsed).toISOString().slice(0, 16)}`
      }\n`,
  );
}
