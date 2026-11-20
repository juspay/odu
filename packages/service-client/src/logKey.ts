import { decodeNodeKey, encodeNodeKey, isAttemptOrdinal } from "@odu/run-history/ids";

export interface LogKey {
  runId: string;
  /** `<namepath>@<platform>`, decoded. */
  node: string;
  /** 1-based attempt ordinal. */
  attempt: number;
}

/** The separator. `/` because the encoded node key cannot contain one (that is
 *  what `encodeNodeKey` guarantees — the encoding exists so the key is a legal
 *  single path segment). */
const SEP = "/";

export function formatLogKey(key: LogKey): string {
  return [key.runId, encodeNodeKey(key.node), String(key.attempt)].join(SEP);
}

/** Read the token back, or `null`. */
export function parseLogKey(token: string): LogKey | null {
  const parts = token.split(SEP);
  if (parts.length !== 3) return null;
  const [runId, encodedNode, rawAttempt] = parts;
  if (runId === undefined || runId === "") return null;
  if (encodedNode === undefined || encodedNode === "") return null;
  if (rawAttempt === undefined || !/^[0-9]+$/.test(rawAttempt)) return null;
  const attempt = Number(rawAttempt);
  if (!isAttemptOrdinal(attempt)) return null;
  const node = decodeNodeKey(encodedNode);
  if (node === null) return null;
  return { runId, node, attempt };
}
