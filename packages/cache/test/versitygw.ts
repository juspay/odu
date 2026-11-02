/**
 * AN S3 SERVICE FOR THE SUITE: versitygw over a temporary directory.
 *
 * versitygw (nixpkgs, in the dev shell) is a real S3 gateway — signed requests,
 * conditional writes, multipart, ranges, paged lists — over a plain directory,
 * so the S3 store is tested against S3 semantics rather than a mock of them.
 * One gateway per test file, on a free port; every case gets a bucket of its
 * own, so cases never see each other's keys.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { s3Fetch, type S3Target } from "../src/s3sign";

export interface Gateway {
  endpoint: string;
  /** A new, empty bucket on this gateway, and the target that writes it. */
  bucket(): Promise<S3Target>;
  stop(): Promise<void>;
}

const ACCESS = "odu-test-access";
const SECRET = "odu-test-secret-key";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no free port");
  return address.port;
}

export async function startGateway(): Promise<Gateway> {
  const dir = mkdtempSync(join(tmpdir(), "odu-versitygw-"));
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    "versitygw",
    ["--access", ACCESS, "--secret", SECRET, "--port", `127.0.0.1:${port}`, "--quiet", "posix", dir],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const spawned = new Promise<never>((_, reject) => {
    child.once("error", (err) =>
      reject(new Error(`versitygw did not start (${err.message}) — it is in the dev shell; run \`just test\``)),
    );
    child.once("exit", (code) => reject(new Error(`versitygw exited ${code}: ${stderr}`)));
  });
  spawned.catch(() => {});
  const probe: S3Target = { endpoint, bucket: "probe", region: "us-east-1", accessKeyId: ACCESS, secretAccessKey: SECRET };
  const deadline = Date.now() + 15_000;
  for (;;) {
    const up = await Promise.race([
      s3Fetch(probe, "HEAD", "probe").then(() => true, () => false),
      spawned,
    ]);
    if (up) break;
    if (Date.now() > deadline) throw new Error(`versitygw did not answer on ${endpoint}: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let made = 0;
  return {
    endpoint,
    async bucket() {
      made += 1;
      const target: S3Target = { ...probe, bucket: `case-${process.pid}-${made}` };
      // CreateBucket is a PUT of the bucket itself: the empty key.
      const response = await s3Fetch(target, "PUT", "");
      if (!response.ok) throw new Error(`CreateBucket ${target.bucket}: ${response.status} ${await response.text()}`);
      return target;
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve(null)));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
