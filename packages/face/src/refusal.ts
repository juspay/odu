/** A refusal as the sentence a person reads. Every row's refusals are already
 *  written for a person; this only appends the recovery when the error carries
 *  one (`suggestion`, the runs' refusals' argv). One spelling, because three
 *  faces had three — and one of them dropped the recovery. */
export function refusalText(err: unknown): string {
  const value = err as { message?: unknown; suggestion?: unknown };
  const message = typeof value?.message === "string" ? value.message : String(err);
  const suggestion = Array.isArray(value?.suggestion)
    ? ` Try: ${(value.suggestion as unknown[]).map(String).join(" ")}`
    : "";
  return `${message}${suggestion}`;
}
