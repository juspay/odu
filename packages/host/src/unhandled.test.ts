/**
 * THE LAST CATCH, AS A FAULT MEETS IT.
 *
 * Two kinds of proof, because the claim has two halves. The in-process cases
 * drive the handlers directly and assert what is LOGGED and COUNTED — including
 * the cause chain, which is the field issue #160 would have been diagnosed from,
 * and a non-`Error` rejection, which is the value that makes a careless handler
 * throw inside itself.
 *
 * The other half cannot be shown in this process at all: "the daemon does not
 * exit" is a statement about a process, and a test that asserted it from inside
 * the same one would be asserting that it is still running — which it is, by
 * construction. So the survival case SPAWNS A REAL BUN PROCESS, gives it a real
 * unhandled rejection with a real cause, and then asks it for an HTTP response
 * afterwards. Nothing about the source text is read anywhere here.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { Logger } from "@kolu/surface-daemon";
import { installUnhandledGuard } from "./unhandled";

interface Line {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

/** A logger that keeps what it was told. Not a mock framework: the assertions
 *  below are about the object a real logger would serialise. */
function recorder(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (fields: Record<string, unknown>, msg: string): void => {
      lines.push({ level, msg, fields });
    };
  return { log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

/** Fire the handlers the way the runtime does, without waiting for the runtime:
 *  the listeners are the unit, and `process.emit` is how they are reached. */
function emit(event: "unhandledRejection" | "uncaughtException", value: unknown): void {
  (process as unknown as { emit(name: string, ...args: unknown[]): boolean }).emit(event, value);
}

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("installUnhandledGuard", () => {
  it("logs a rejection once at error level with every link of its cause chain", () => {
    const { log, lines } = recorder();
    const guard = installUnhandledGuard({ log });
    try {
      const deepest = new Error("s3: 403 refused");
      const middle = new Error("readback: pull failed", { cause: deepest });
      emit("unhandledRejection", new Error("upload aborted", { cause: middle }));

      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line?.level).toBe("error");
      expect(line?.msg).toBe("odu: unhandled");
      expect(line?.fields.kind).toBe("rejection");
      expect(line?.fields.message).toBe("upload aborted");
      expect(typeof line?.fields.stack).toBe("string");
      const causes = line?.fields.causes as { message: string }[];
      expect(causes.map((link) => link.message)).toEqual([
        "upload aborted",
        "readback: pull failed",
        "s3: 403 refused",
      ]);
      expect(guard.counts()).toEqual({ rejection: 1, exception: 0 });
    } finally {
      guard.remove();
    }
  });

  it("counts an uncaught exception under its own label", () => {
    const { log, lines } = recorder();
    const guard = installUnhandledGuard({ log });
    try {
      emit("uncaughtException", new Error("bad state"));
      expect(guard.counts()).toEqual({ rejection: 0, exception: 1 });
      expect(lines[0]?.fields.kind).toBe("exception");
    } finally {
      guard.remove();
    }
  });

  it("logs and counts a rejection value that is not an Error at all", () => {
    const { log, lines } = recorder();
    const guard = installUnhandledGuard({ log });
    try {
      emit("unhandledRejection", "plain string reason");
      emit("unhandledRejection", { code: 503 });

      expect(guard.counts().rejection).toBe(2);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.fields.message).toBe("plain string reason");
      expect(lines[0]?.fields.stack).toBeUndefined();
      expect(String(lines[1]?.fields.message)).toContain("503");
    } finally {
      guard.remove();
    }
  });

  it("leaves no listener behind after remove()", () => {
    const { log, lines } = recorder();
    const before = {
      rejection: process.listenerCount("unhandledRejection"),
      exception: process.listenerCount("uncaughtException"),
    };
    const guard = installUnhandledGuard({ log });
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);

    guard.remove();
    guard.remove();
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
    expect(process.listenerCount("uncaughtException")).toBe(before.exception);

    emit("unhandledRejection", new Error("after the tenure"));
    expect(lines).toHaveLength(0);
  });

  it("keeps a real serving process alive through a real unhandled rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-unhandled-child-"));
    scratches.push(dir);
    const script = join(dir, "child.ts");
    // The child is the daemon in miniature: the guard installed, a listener
    // bound, then a genuine rejection nobody awaits. It announces its port from
    // INSIDE the guard's own log call rather than after a delay, so the fetch
    // below is necessarily a fetch that happened after the fault was reported —
    // the handshake carries the ordering, not a sleep. `/stop` stops the server
    // gracefully; with nothing else holding the loop the child then ends on its
    // own, which is what exit 0 is evidence of.
    writeFileSync(
      script,
      [
        `import { installUnhandledGuard } from ${JSON.stringify(join(import.meta.dir, "unhandled.ts"))};`,
        `const log = {`,
        `  debug: () => {}, info: () => {}, warn: () => {},`,
        `  error: (fields, msg) => {`,
        `    process.stderr.write(JSON.stringify({ ...fields, msg }) + "\\n");`,
        `    process.stdout.write("ready " + server.port + "\\n");`,
        `  },`,
        `};`,
        `const server = Bun.serve({`,
        `  port: 0,`,
        `  fetch(request) {`,
        `    if (new URL(request.url).pathname === "/stop") {`,
        `      queueMicrotask(() => server.stop(false));`,
        `      return new Response("stopping");`,
        `    }`,
        `    return new Response("alive " + guard.counts().rejection);`,
        `  },`,
        `});`,
        `const guard = installUnhandledGuard({ log });`,
        `void Promise.reject(new Error("boom", { cause: new Error("inner") }));`,
      ].join("\n"),
    );

    const child = Bun.spawn([process.execPath, "run", script], { stdout: "pipe", stderr: "pipe" });
    try {
      const announced = Promise.withResolvers<string>();
      const stdout = (child.stdout as ReadableStream<Uint8Array>).getReader();
      void (async () => {
        let buffered = "";
        for (;;) {
          const next = await stdout.read();
          if (next.done) break;
          buffered += new TextDecoder().decode(next.value);
          const match = /ready (\d+)/.exec(buffered);
          if (match?.[1] !== undefined) return announced.resolve(match[1]);
        }
        announced.reject(new Error(`child exited before serving: ${buffered}`));
      })();
      const port = await announced.promise;

      // STILL SERVING, after the rejection: the whole point of the guard.
      const answer = await fetch(`http://127.0.0.1:${port}/`);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("alive 1");
      expect(child.killed).toBe(false);

      await fetch(`http://127.0.0.1:${port}/stop`);
      expect(await child.exited).toBe(0);

      const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
      expect(stderr).toContain("odu: unhandled");
      expect(stderr).toContain("boom");
      expect(stderr).toContain("inner");
    } finally {
      child.kill();
    }
  }, 30_000);
});
