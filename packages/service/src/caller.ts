/**
 * WHO IS ASKING — the one per-caller fact the ports receive today.
 *
 * The service is a per-user singleton, so its own environment is a fact about
 * the shell that started it — never about the person asking for this run. The
 * one such fact is `$ODU_HOSTS`: the inventory a launch resolves, the venue
 * verbs probe and hold, and an unsliced protect derives its platform set from.
 * It used to travel as a loose `hostsFile` field on every port signature (and
 * on every adapter behind them), which is one edit per per-caller fact and five
 * places for the next one to be forgotten.
 *
 * It arrives as ONE value instead, assembled per call inside the service from
 * the verb input, and this is the only shape the ports see. Later per-caller
 * facts — a principal resolved from the connection, an org — join this type
 * rather than every signature, which is why it has a module of its own rather
 * than living in the ports list.
 *
 * **Not a wire type.** Verb inputs keep `hostsFile` exactly as they always
 * have: the three readings (a path, `""` for "my shell has none", absent for
 * "I have no shell") are the contract the docs and agents already speak, and
 * {@link callerOf} is where that contract becomes this object.
 */

export interface Caller {
  /** The CALLER's `$ODU_HOSTS`, or `null` when the caller expressed nothing. */
  readonly hostsFile: string | null;
}

/**
 * Assemble the caller from a verb input.
 *
 * The three readings are kept, not flattened: absent becomes `null` (use the
 * service's own configuration), `""` stays `""` (the caller's shell had none),
 * and a path stays a path. The first two mean opposite things downstream, which
 * is why this is `?? null` and not `?? ""`.
 */
export function callerOf(input: {
  readonly hostsFile?: string | undefined;
}): Caller {
  return { hostsFile: input.hostsFile ?? null };
}
