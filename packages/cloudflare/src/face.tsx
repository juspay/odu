import { ago } from "@odu/cordis/format";
import { refusalText } from "@odu/face/refusal";
import type { SurfaceClient } from "@kolu/surface/solid";
import type { Effect } from "effect";
import { createMemo, createResource, For, Show, type JSX } from "solid-js";
import { PageHead, Panel, Pill, Tag, type StatusHue } from "@odu/face/ui";
import {
  OFF_TUNNEL,
  oduCloudflareSurface,
  type CloudflareRoute,
  type CloudflareStatus,
  type CloudflareTunnel,
  type RouteState,
  type TunnelState,
} from "./surface";

type CloudflareSpec = (typeof oduCloudflareSurface)["spec"];
export type CloudflareClient = SurfaceClient<CloudflareSpec>;

export interface CloudflareFaceProps {
  client: CloudflareClient;
  now: number;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
}

type Reading =
  | { readonly ok: true; readonly status: CloudflareStatus }
  | { readonly ok: false; readonly message: string };

function routeText(route: CloudflareRoute): string {
  return route.reason === null ? route.state : `${route.state}: ${route.reason}`;
}

function routeHue(state: RouteState): StatusHue {
  return state === "live" ? "green" : state === "wiring" ? "amber" : "red";
}

function tunnelHue(state: TunnelState): StatusHue {
  return state === "connected"
    ? "green"
    : state === "running"
      ? "amber"
      : state === "failed"
        ? "red"
        : "grey";
}

export function TunnelFace(props: CloudflareFaceProps): JSX.Element {
  const [first] = createResource(async (): Promise<Reading> => {
    try {
      return { ok: true, status: await props.call(props.client.procedures.status.read()) };
    } catch (err) {
      return { ok: false, message: refusalText(err) };
    }
  });
  const tunnel = props.client.cells.tunnel.use();
  const held = props.client.collections.routes.use();
  const routes = createMemo<CloudflareRoute[]>(() => {
    const out: CloudflareRoute[] = [];
    for (const key of held.keys()) {
      const row = held.byKey(key)?.();
      if (row !== undefined) out.push(row);
    }
    return out.sort((left, right) => left.domain.localeCompare(right.domain));
  });
  const tunnelOf = (): CloudflareTunnel => tunnel.value() ?? OFF_TUNNEL;

  const made = (): boolean => tunnelOf().id !== null || tunnelOf().name !== null;

  const lastSeen = createMemo<number | null>(() => {
    let newest: number | null = null;
    for (const route of routes()) {
      if (newest === null || route.updated > newest) newest = route.updated;
    }
    return newest;
  });

  return (
    <section class="screen tunnel" aria-label="tunnel">
      <PageHead
        title="Tunnel"
        sub="One Cloudflare tunnel for this server, carrying the names its buckets answer on."
        actions={
          <Show when={first()?.ok === true && made()}>
            <Pill hue={tunnelHue(tunnelOf().state)}>connector {tunnelOf().state}</Pill>
          </Show>
        }
      />
      <Show
        when={first()?.ok === true}
        fallback={
          <p class="empty">
            {first.loading
              ? "reading…"
              : "Cloudflare is not configured on this server — set ODU_CLOUDFLARE_API_TOKEN_FILE (services.odu.cloudflare.apiTokenFile) and restart."}
          </p>
        }
      >
        <Show when={made()}>
          <Panel
            title="Connector"
            note="One tunnel for this server, made the first time a name was set. The connector is a child of the daemon; when the last name goes, it stops."
          >
            <div class="panel-body">
              <dl class="stats">
                <dt>state</dt>
                <dd>{tunnelOf().state}</dd>
                <Show when={tunnelOf().name}>
                  {(name) => (
                    <>
                      <dt>name</dt>
                      <dd>{name()}</dd>
                    </>
                  )}
                </Show>
                <Show when={tunnelOf().id}>
                  {(id) => (
                    <>
                      <dt>id</dt>
                      <dd>{id()}</dd>
                    </>
                  )}
                </Show>
                <dt>names</dt>
                <dd>{routes().length}</dd>
                <Show when={lastSeen()}>
                  {(at) => (
                    <>
                      <dt>last seen</dt>
                      <dd>{ago(at(), props.now)}</dd>
                    </>
                  )}
                </Show>
              </dl>
              <Show when={tunnelOf().reason}>
                {(reason) => <p class="fault">{reason()}</p>}
              </Show>
            </div>
          </Panel>
        </Show>
        <Panel
          title="Routes"
          note="One line per name the tunnel carries: the host, the bucket behind it, and when the row last heard about it."
        >
          <Show
            when={routes().length > 0}
            fallback={
              <div class="panel-body">
                <p class="empty">
                  The tunnel is idle — no name is routed. Set one on a bucket page, under
                  “A name of its own”.
                </p>
              </div>
            }
          >
            <ol class="paths">
              <For each={routes()}>
                {(route) => (
                  <li>
                    <code class="path">{route.domain}</code>
                    <span class="fact-line bucket-facts">
                      <Pill hue={routeHue(route.state)}>{routeText(route)}</Pill>
                      <Show
                        when={route.bucket}
                        fallback={<span>the server itself</span>}
                      >
                        {(bucket) => <Tag>{bucket()}</Tag>}
                      </Show>
                      <span>{ago(route.updated, props.now)}</span>
                    </span>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </Panel>
      </Show>
    </section>
  );
}

export function BucketRoute(props: {
  client: CloudflareClient;
  bucket: string;
  now: number;
}): JSX.Element {
  const held = props.client.collections.routes.use();
  const route = createMemo<CloudflareRoute | undefined>(() => {
    for (const key of held.keys()) {
      const row = held.byKey(key)?.();
      if (row !== undefined && row.bucket === props.bucket) return row;
    }
    return undefined;
  });
  return (
    <Show when={route()}>
      {(row) => (
        <div class="stack">
          <p class="fact-line bucket-facts" aria-label="domain route">
            <Tag hue={row().state === "live" ? "green" : undefined}>{row().state}</Tag>
            <code>{row().domain}</code>
            <span>{ago(row().updated, props.now)}</span>
          </p>
          <Show when={row().state === "wiring"}>
            <p class="hint">The tunnel row is wiring {row().domain}'s DNS record.</p>
          </Show>
          <Show when={row().state === "failed"}>
            <p class="fault">
              The tunnel row could not route {row().domain}
              {row().reason === null ? "." : `: ${row().reason}`}
            </p>
          </Show>
        </div>
      )}
    </Show>
  );
}
