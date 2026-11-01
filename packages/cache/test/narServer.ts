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
import { nixDump } from "../src/store";

const path = process.argv[2];
if (path === undefined) throw new Error("narServer: a store path is required");

// `narServer file <path>`: the FILE response's fixed point. The kept object is
// served by Bun as a file (sendfile, sized), so a slow reader must not grow
// this process at all.
if (path === "file") {
  const file = process.argv[3];
  if (file === undefined) throw new Error("narServer file: a file path is required");
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(Bun.file(file), { headers: { "content-type": "application/x-nix-nar" } }),
  });
  process.stdout.write(`ready ${served.port}\n`);
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
