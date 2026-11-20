const DIAGNOSTIC_FIELDS = ["code", "errno", "syscall", "hostname", "address", "port"] as const;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function describeLink(value: unknown): string {
  if (typeof value !== "object" || value === null) return oneLine(String(value));
  const bag = value as Record<string, unknown>;
  const name = typeof bag.name === "string" && bag.name !== "" ? bag.name : "Error";
  const message = typeof bag.message === "string" ? oneLine(bag.message) : "";
  const facts: string[] = [];
  for (const field of DIAGNOSTIC_FIELDS) {
    const fact = bag[field];
    if (fact === undefined || fact === null || fact === "" || typeof fact === "object") continue;
    facts.push(`${field}=${oneLine(String(fact))}`);
  }
  const head = message === "" ? name : `${name}: ${message}`;
  return facts.length === 0 ? head : `${head} (${facts.join(", ")})`;
}

function linksOf(err: unknown): string[] {
  const seen = new Set<object>();
  const links: string[] = [];
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const link = pending.shift();
    if (typeof link !== "object" || link === null) {
      links.push(describeLink(link));
      continue;
    }
    if (seen.has(link)) continue;
    seen.add(link);
    links.push(describeLink(link));
    const bag = link as { cause?: unknown; errors?: unknown };
    if (bag.cause !== undefined && bag.cause !== null) pending.push(bag.cause);
    if (Array.isArray(bag.errors)) {
      for (const nested of bag.errors) {
        if (nested !== undefined && nested !== null) pending.push(nested);
      }
    }
  }
  return links;
}

export function describeFailure(err: unknown): string {
  try {
    return linksOf(err).join(" ← ");
  } catch {
    return "an error that refused to describe itself";
  }
}
