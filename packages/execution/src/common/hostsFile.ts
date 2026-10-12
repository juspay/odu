/**
 * Where a hosts.json comes from — the resolution chain, and nothing else.
 *
 * `$ODU_HOSTS → ~/.config/odu/hosts.json → ~/.config/justci/hosts.json`, the
 * first that exists — or, with `$ODU_CONFIG_DIR` set, `$ODU_HOSTS →
 * $ODU_CONFIG_DIR/hosts.json` and nothing else. Here in `common/` rather than beside the parser
 * (`coordinator/hosts.ts`) because a face needs the chain too: `odu
 * cloudflare setup` sizes its Worker from the declared cloudflare hosts, and
 * a public client may not reach the coordinator (cli/src/authority.test.ts).
 * One chain, so the two can never read different files.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** A resolution-chain slot: the label the operator sees and the path we probe
 *  (null for `$ODU_HOSTS` when it is unset — the slot still shows in the
 *  refusal so the chain reads in full). One source of truth for both the
 *  lookup in `loadHosts` and the named chain in the no-config refusal. */
export interface HostsCandidate {
  label: string;
  path: string | null;
}

/**
 * @param override the CALLER's `$ODU_HOSTS`, when the caller is not this
 *   process. Three readings, the same three the wire carries: a path uses that
 *   file; `""` means the caller's shell had none, so the chain starts at
 *   `~/.config`; `undefined` means nobody said, so this process's own
 *   environment answers. A per-user singleton runs work on behalf of callers
 *   whose environment is not its own, and that is exactly when it matters.
 */
export function hostsCandidates(override?: string): HostsCandidate[] {
  const oduHosts = override ?? process.env.ODU_HOSTS;
  const explicitDir = configDirOverride();
  const fromEnv: HostsCandidate = {
    label: "$ODU_HOSTS",
    path: oduHosts !== undefined && oduHosts !== "" ? oduHosts : null,
  };
  // A separate config directory is a separate world: it does not fall back to
  // the interactive user's files, or a CI box would silently pick up a
  // developer's hosts.
  if (explicitDir !== null) {
    return [fromEnv, { label: "$ODU_CONFIG_DIR/hosts.json", path: join(explicitDir, "hosts.json") }];
  }
  return [
    fromEnv,
    {
      label: "~/.config/odu/hosts.json",
      path: join(homedir(), ".config", "odu", "hosts.json"),
    },
    {
      label: "~/.config/justci/hosts.json",
      path: join(homedir(), ".config", "justci", "hosts.json"),
    },
  ];
}

function configDirOverride(): string | null {
  const dir = process.env.ODU_CONFIG_DIR;
  return dir !== undefined && dir !== "" ? dir : null;
}

/** odu's per-user configuration directory: `$ODU_CONFIG_DIR`, else
 *  `~/.config/odu`. The override exists so one user can keep two worlds
 *  apart — a CI coordinator with its own hosts and Cloudflare lane next to
 *  the interactive service reading the live files. */
export function oduConfigDir(): string {
  return configDirOverride() ?? join(homedir(), ".config", "odu");
}
