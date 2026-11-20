import type { RunHeader } from "@odu/run-client/surface";

export async function capturingStdout<T>(
  fn: () => T | Promise<T>,
): Promise<{ out: string; result: T }> {
  const { text, result } = await capturing(process.stdout, fn);
  return { out: text, result };
}

export async function capturingStderr<T>(
  fn: () => T | Promise<T>,
): Promise<{ err: string; result: T }> {
  const { text, result } = await capturing(process.stderr, fn);
  return { err: text, result };
}

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

export function lanesHeader(): RunHeader {
  return {
    commitUrl: null,
    lanes: [{ state: "leased", platform: "x86_64-linux", host: "kolu-ci-5" }],
    hostsSource: "~/.config/odu/hosts.json",
    startedAt: 1_000,
  };
}
