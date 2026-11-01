/**
 * A NAR server in its OWN PROCESS, for the memory test.
 *
 * The pod's failure is a slow socket in front of this process; an in-process
 * `fetch` over loopback applies pressure the pod's path does not. This is the
 * smallest server that exercises the real source (`nixDump`) and a real socket.
 *
 * argv: <store-path>. Prints `ready <port>` on stdout.
 */
import { createServer } from "node:http";
import { ManagedRuntime, Effect, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { nixDump } from "../src/store";
import { createCache } from "../src/cache";
import { cacheRoutes } from "../src/routes";

const path = process.argv[2];
if (path === undefined) throw new Error("narServer: a store path is required");

// `narServer routes <stateDir> <bucket> <hash>`: the FILE response's fixed
// point, through the REAL cacheRoutes (narResponse, Content-Length, Range), not
// a bare Bun.serve that skipped the code under test.
if (path === "routes") {
  const stateRoot = process.argv[3];
  const bucket = process.argv[4];
  const hash = process.argv[5];
  if (stateRoot === undefined || bucket === undefined || hash === undefined) {
    throw new Error("narServer routes: a state dir, bucket and hash are required");
  }
  const cache = createCache({ stateRoot, rootToken: null });
  // THE PRODUCTION ADAPTER: a Node request handler made by
  // `NodeHttpServer.makeHandler` over the same Effect layer `odu web` uses.
  // A handler called directly (or Bun's fetch) is not a test of serving: a
  // body the adapter cannot write passes there and hangs in production.
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
      // THE ROW's write shape: 64 KiB views of whatever the source handed us,
      // exactly as `narWrites` does. A view keeps its parent alive, which is
      // the retention this test exists to bound.
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
