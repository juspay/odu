/**
 * The scaffolding the test suites share — stream capture, a poll loop, and the
 * `RunHeader` fixtures.
 *
 * None of it asserts anything; it is the apparatus assertions are made through,
 * and every piece here had grown a byte-identical twin in a second suite
 * (`capturingStdout` in three, `provisioningHeader`/`lanesHeader` in two). A
 * fixture with two copies is a fixture that can drift on the field the two
 * suites happen not to both check.
 *
 * Not a test file — no `bun:test` import, and the name misses the `*.test.ts`
 * glob — so it is imported by the harnesses rather than collected as a suite.
 * Same convention as `packages/cli/src/mcp/serveForTest.ts`.
 */

import type { RunHeader } from "@odu/run-client/surface";

/** Run `fn` with `process.stdout` captured; returns what it wrote plus `fn`'s
 *  own result. Takes a sync or async body, because the faces under test are
 *  both (a `PlainDisplay` call returns void; `statusCommand` is a promise). */
export async function capturingStdout<T>(
  fn: () => T | Promise<T>,
): Promise<{ out: string; result: T }> {
  const { text, result } = await capturing(process.stdout, fn);
  return { out: text, result };
}

/** Same, for `process.stderr`. */
export async function capturingStderr<T>(
  fn: () => T | Promise<T>,
): Promise<{ err: string; result: T }> {
  const { text, result } = await capturing(process.stderr, fn);
  return { err: text, result };
}

/** The one swap-write-restore body both capturers are. `finally` restores even
 *  when `fn` throws, so a failing assertion inside a capture cannot leave the
 *  rest of the suite writing into a dead array. */
async function capturing<T>(
  stream: NodeJS.WriteStream,
  fn: () => T | Promise<T>,
): Promise<{ text: string; result: T }> {
  const chunks: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof stream.write;
  try {
    const result = await fn();
    return { text: chunks.join(""), result };
  } finally {
    stream.write = original;
  }
}

/** Poll a predicate to a deadline — for ordering against a live subscription or
 *  another process, where the alternative is a fixed sleep that is either flaky
 *  or slow. Throws on the deadline so a test that never gets its condition
 *  fails with a reason rather than hanging to the suite timeout. */
export async function waitFor(
  pred: () => boolean,
  timeoutMs = 5_000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** A run mid-claim: one lane still `claiming`, from a two-host pool. What
 *  `orchestrate` publishes between `serveSocket` and the venue claim. */
export function provisioningHeader(startedAt = 1_000): RunHeader {
  return {
    commitUrl: null,
    lanes: [
      {
        state: "claiming",
        platform: "x86_64-linux",
        pool: ["kolu-ci-5", "kolu-ci-6"],
      },
    ],
    hostsSource: "~/.config/odu/hosts.json",
    startedAt,
  };
}

/** The same run once its claim resolved: one `leased` lane on a real host. */
export function lanesHeader(): RunHeader {
  return {
    commitUrl: null,
    lanes: [{ state: "leased", platform: "x86_64-linux", host: "kolu-ci-5" }],
    hostsSource: "~/.config/odu/hosts.json",
    startedAt: 1_000,
  };
}
