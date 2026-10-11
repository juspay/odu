/**
 * Where a hosts.json comes from — the resolution chain, and nothing else.
 *
 * `$ODU_HOSTS → ~/.config/odu/hosts.json → ~/.config/justci/hosts.json`, the
 * first that exists. Here in `common/` rather than beside the parser
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
  return [
    {
      label: "$ODU_HOSTS",
      path: oduHosts !== undefined && oduHosts !== "" ? oduHosts : null,
    },
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
