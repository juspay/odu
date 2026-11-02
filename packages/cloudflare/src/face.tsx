/**
 * THE TUNNEL, AS A PAGE — the connector's state, the names it carries, and the
 * one reason a person needs when a name is not live.
 *
 * It is its own row's face, drawn by the shell: the cache page sets a bucket's
 * name and knows nothing about Cloudflare, and this page knows nothing about a
 * bucket's key, paths or tokens. `BucketRoute` is the narrow strip the shell
 * places on a bucket page, so the domain's state is visible where the name was
 * set without either row reaching into the other.
 *
 * The row may not be mounted (no token configured). The status read is what
 * tells the page that — the cell has a default and would otherwise say
 * `stopped`, which is a different fact.
 */

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

/** One row's state, in the words the row uses. */
function routeText(route: CloudflareRoute): string {
  return route.reason === null ? route.state : `${route.state}: ${route.reason}`;
}

/**
 * A NAME'S HUE — the design's status colours, spent on a status.
 *
 * `live` is green because the name answers; `wiring` is amber because it is a
 * state in MOTION that leaves on its own; `failed` is red. Nothing here is
 * violet: violet is a run whose machine died, and a name Cloudflare refused
 * has a REASON, which this page prints beside the pill instead.
 */
function routeHue(state: RouteState): StatusHue {
  return state === "live" ? "green" : state === "wiring" ? "amber" : "red";
}

/**
 * THE CONNECTOR'S HUE, and `stopped` is deliberately GREY.
 *
 * A connector with no name to carry is not a fault — it is the resting state
 * of a server nobody has named a bucket on, and a red pill there would send a
 * person looking for a breakage that is not one. Only `failed` is red;
 * `running` is the amber of a thing still on its way to connected.
 */
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
  // THE MOUNTED QUESTION: a status read fails with an unknown verb when the row
  // is not served, which is exactly "Cloudflare is not configured here".
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

  /**
   * HAS A TUNNEL EVER EXISTED — the one question that decides whether this page
   * says anything about a connector at all.
   *
   * NO NAME EVER SET IS IDLE, not a stopped connector: `stopped` is what a
   * connector says AFTER carrying names. The cell has a default, so a server
   * that has never made a tunnel would otherwise open on "connector stopped",
   * which reads as a thing that broke. A tunnel that HAS existed keeps its
   * state — clearing the last name really does stop it, and that IS news.
   */
  const made = (): boolean => tunnelOf().id !== null || tunnelOf().name !== null;

  /**
   * WHEN THE ROW LAST HEARD ANYTHING. The surface publishes no timestamp on the
   * tunnel itself — only each route carries `updated` — so "last seen" is the
   * newest of those, read rather than added. A tunnel with no names has none,
   * and the line is absent rather than guessed.
   */
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
      {/* A ROW THAT IS NOT SERVED IS AN ANSWER, not a page still loading, so it
          gets the dashed empty panel every other "nothing here" on this board
          gets rather than a stray grey line under the title. */}
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
                      {/* THE BUCKET IS A PROPERTY, not a verdict, so it is a
                          square grey tag and never a hue. The server's own
                          origin has no bucket to name and says so in words. */}
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

/**
 * THE STRIP ON A BUCKET PAGE. Rendered by the shell beside the cache's own
 * face; it shows the route for THIS bucket and nothing when there is none, so a
 * bucket without a domain reads as the cache page always did.
 *
 * ONE LINE, and no panel of its own: the cache page is already a column of
 * panels about this bucket, and a sixth bordered card holding three words would
 * read as a second page stapled under the first. A TAG rather than a pill,
 * hued green only when the name is live — a domain that answers is the one
 * property on this board that is also a verdict — and the sentence under it
 * appears only while there is news to carry, so a live name is genuinely one
 * line and a failed one still prints its reason in full.
 */
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
