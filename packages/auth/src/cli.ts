/**
 * `odu auth login` — the one thing about the door that needs a shell.
 *
 * A credential is a FILE ON THIS MACHINE'S DISK. The profile page mints a
 * personal access token, and this is how that token reaches every other `odu`
 * command on the machine that was given it: `@odu/cli`'s wire reads the entry
 * this writes (`./credentials`) and sends it on the websocket upgrade. There is
 * nothing here for a browser to do, and no verb that could do it from the other
 * end of a socket — the same argument that keeps `odu cache login`.
 *
 * THE REST OF THE DOOR'S VOCABULARY IS THE BOARD'S AND THE API'S. Who am I,
 * personal tokens, roles and the list of people are controls on the profile and
 * people pages, and verbs on the surface — `odu surface auth user_whoami`,
 * `auth token_create`, `auth token_list`, `auth token_revoke`,
 * `auth user_grant`, `auth grant_list` — which `odu mcp` serves an agent under
 * the same names. A fresh daemon's first owner is granted the same way, with
 * the operator's root token as a field of the input:
 *
 *   odu surface auth user_grant --json \
 *     --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","login":"srid","role":"owner"}'
 *
 * so the bootstrap needs no argv face of its own, and this module dials
 * nothing: it takes no port, and names neither a host nor a surface.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { saveAuthToken } from "./credentials";

export const AUTH_USAGE = `usage: odu auth login <origin> [--token T]

login <origin> [--token T]    save this machine's personal access token for an
                              origin, in ~/.config/odu/auth/credentials (0600).
                              Reads the token from stdin when --token is absent

Who you are, personal tokens, roles and the list of people are the board's
profile and people pages, or the API: \`odu surface auth user_whoami\`,
\`auth token_create\`, \`auth token_list\`, \`auth token_revoke\`,
\`auth user_grant\`, \`auth grant_list\` — the same verbs \`odu mcp\` serves an
agent. They exist ONLY on a daemon with a door (\`ODU_GITHUB_*\` configured);
with none there is no auth row to call, and every caller is the daemon's local
owner.

The origin named here is the server a stored token belongs to (the default
every other command dials is $ODU_WEB_ORIGIN or http://127.0.0.1:18440). That
token, or $ODU_TOKEN, is sent as \\\`Authorization: Bearer\\\` on the websocket
upgrade, so every other \\\`odu\\\` command reaches the server too.
`;

export async function authCommand(
  sub: string | undefined,
  rest: string[],
): Promise<number> {
  switch (sub) {
    case "login":
      return loginCommand(rest);
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
