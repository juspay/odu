import {
  type CloudflareConfig,
  laneAuthHeaders,
  laneEndpoint,
} from "../../common/cloudflareConfig";

/** Open an authenticated WebSocket to a lane route. Bun's WebSocket takes
 *  request headers; the Worker authenticates the upgrade like every route. */
export function openLaneSocket(
  config: Readonly<CloudflareConfig>,
  instance: string,
  action: "agent" | "import",
): WebSocket {
  const ws = new (WebSocket as unknown as new (
    url: URL,
    init: { headers: Record<string, string> },
  ) => WebSocket)(laneEndpoint(config, instance, action, "wss"), { headers: laneAuthHeaders(config) });
  ws.binaryType = "arraybuffer";
  return ws;
}
