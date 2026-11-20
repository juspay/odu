/** A refusal as the sentence a person reads. Appends the recovery when the
 *  error carries one (`suggestion`, the runs' refusals' argv). */
export function refusalText(err: unknown): string {
  const value = err as { message?: unknown; suggestion?: unknown };
  const message = typeof value?.message === "string" ? value.message : String(err);
  const suggestion = Array.isArray(value?.suggestion)
    ? ` Try: ${(value.suggestion as unknown[]).map(String).join(" ")}`
    : "";
  return `${message}${suggestion}`;
}
