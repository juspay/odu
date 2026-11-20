/** A refusal as the sentence a person reads. Appends the recovery when the
 *  error carries one (`suggestion`, the runs' refusals' argv). */
interface Refusal {
  readonly message: string;
  readonly suggestion?: readonly string[];
}

function asRefusal(err: unknown): Refusal {
  const held = typeof err === "object" && err !== null ? err : {};
  const message =
    "message" in held && typeof held.message === "string" ? held.message : String(err);
  const suggestion =
    "suggestion" in held && Array.isArray(held.suggestion)
      ? (held.suggestion as readonly unknown[]).map(String)
      : undefined;
  return suggestion === undefined ? { message } : { message, suggestion };
}

export function refusalText(err: unknown): string {
  const refusal = asRefusal(err);
  return refusal.suggestion === undefined
    ? refusal.message
    : `${refusal.message} Try: ${refusal.suggestion.join(" ")}`;
}
