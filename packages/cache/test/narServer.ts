import { createServer } from "node:http";
import { ManagedRuntime, Effect, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { nixDump } from "../src/store";
import { createCache } from "../src/cache";
import { cacheRoutes } from "../src/routes";
import { diskObjectStore, type ObjectStore } from "@odu/objects";
import { LOCAL_STORE } from "../src/surface";
import { join } from "node:path";

const path = process.argv[2];
if (path === undefined) throw new Error("narServer: a store path is required");

if (path === "routes") {
  const stateRoot = process.argv[3];
  const bucket = process.argv[4];
  const hash = process.argv[5];
  if (stateRoot === undefined || bucket === undefined || hash === undefined) {
    throw new Error("narServer routes: a state dir, bucket and hash are required");
  }
  const flags = new Set(process.argv.slice(6));
  const options = { logJson: flags.has("log"), slowStore: flags.has("slow") };
  const log = options.logJson
    ? (event: string, fields: Record<string, unknown>) =>
        process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`)
    : undefined;
  const disk = diskObjectStore({ dir: join(stateRoot, "cache") });
  const objects: ObjectStore = options.slowStore
    ? {
        ...disk,
        async get(key, range) {
          const found = await disk.get(key, range);
          if (found === null) return null;
          const reader = found.stream.getReader();
          return {
            size: found.size,
            stream: new ReadableStream<Uint8Array>({
              async pull(controller) {
                await new Promise((resolve) => setTimeout(resolve, 1));
                const next = await reader.read();
                if (next.done) controller.close();
                else controller.enqueue(next.value);
              },
              cancel: (reason) => reader.cancel(reason),
            }),
          };
        },
      }
    : disk;
  const cache = createCache({
    stateRoot,
    rootToken: null,
    publicOrigin: "http://127.0.0.1:18440",
    log,
    stores: new Map([[LOCAL_STORE, objects]]),
  });
  const runtime = ManagedRuntime.make(NodeHttpServer.layerHttpServices);
  const scope = await runtime.runPromise(Scope.make());
  const handler = await runtime.runPromise(
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(cacheRoutes(cache).layer);
      return yield* NodeHttpServer.makeHandler(httpEffect, { scope });
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no listener");
  process.stdout.write(`ready ${address.port}\n`);
  process.on("SIGTERM", () => {
    server.close();
    void runtime.dispose();
    void cache.close();
  });
} else {
  const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/x-nix-nar" });
  const reader = nixDump(path, null).getReader();
  void (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        response.end();
        return;
      }
      for (let at = 0; at < next.value.length; at += 64 * 1024) {
        const piece = next.value.subarray(at, Math.min(next.value.length, at + 64 * 1024));
        if (!response.write(piece)) {
          await new Promise<void>((resolve) => response.once("drain", () => resolve()));
        }
      }
    }
  })().catch(() => response.destroy());
});
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "object" && address !== null) {
      process.stdout.write(`ready ${address.port}\n`);
    }
  });
}
