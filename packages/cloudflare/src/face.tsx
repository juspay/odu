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
import {
  OFF_TUNNEL,
  oduCloudflareSurface,
  type CloudflareRoute,
  type CloudflareStatus,
  type CloudflareTunnel,
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

  return (
    <section class="tunnel" aria-label="tunnel">
      <h2>Tunnel</h2>
      <Show
        when={first()?.ok === true}
        fallback={
          <p class="hint">
            {first.loading
              ? "reading…"
              : "Cloudflare is not configured on this server — set ODU_CLOUDFLARE_API_TOKEN_FILE (services.odu.cloudflare.apiTokenFile) and restart."}
          </p>
        }
      >
        <Show
          when={routes().length > 0}
          fallback={
            <>
              {/* NO NAME EVER SET IS IDLE, not a stopped connector: `stopped`
                  is what a connector says AFTER carrying names. A tunnel that
                  HAS existed keeps its state — clearing the last name really
                  does stop it. */}
              <Show when={tunnelOf().id !== null || tunnelOf().name !== null}>
                <p class="bucket-facts">
                  <span
                    class={`pill ${tunnelOf().state === "failed" ? "hue-red" : "hue-grey"}`}
                  >
                    connector {tunnelOf().state}
                  </span>
                  <Show when={tunnelOf().name}>{(name) => <span>{name()}</span>}</Show>
                  <Show when={tunnelOf().id}>{(id) => <code>{id()}</code>}</Show>
                </p>
                <Show when={tunnelOf().reason}>
                  {(reason) => <p class="fault">{reason()}</p>}
                </Show>
                <p class="hint">
                  One tunnel for this server, made the first time a name was set. The
                  connector is a child of the daemon; when the last name goes, it stops.
                </p>
              </Show>
              <p class="hint">
                The tunnel is idle — no name is routed. Set one on a bucket page, under
                “A name of its own”.
              </p>
            </>
          }
        >
          <p class="bucket-facts">
            <span class={`pill ${tunnelOf().state === "failed" ? "hue-red" : "hue-grey"}`}>
              connector {tunnelOf().state}
            </span>
            <Show when={tunnelOf().name}>{(name) => <span>{name()}</span>}</Show>
            <Show when={tunnelOf().id}>{(id) => <code>{id()}</code>}</Show>
          </p>
          <Show when={tunnelOf().reason}>
            {(reason) => <p class="fault">{reason()}</p>}
          </Show>
          <p class="hint">
            One tunnel for this server, made the first time a name was set. The
            connector is a child of the daemon; when the last name goes, it stops.
          </p>
          <ol class="paths">
            <For each={routes()}>
              {(route) => (
                <li>
                  <code class="path">{route.domain}</code>
                  <span class="bucket-facts">
                    <span>{route.bucket === null ? "the server itself" : route.bucket}</span>
                    <span class={`pill ${route.state === "failed" ? "hue-red" : "hue-grey"}`}>
                      {routeText(route)}
                    </span>
                    <span>{ago(route.updated, props.now)}</span>
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Show>
    </section>
  );
}

/**
 * THE STRIP ON A BUCKET PAGE. Rendered by the shell beside the cache's own
 * face; it shows the route for THIS bucket and nothing when there is none, so a
 * bucket without a domain reads as the cache page always did.
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
        <>
          <p class="bucket-facts" aria-label="domain route">
            <span class={`pill ${row().state === "failed" ? "hue-red" : "hue-grey"}`}>
              {row().state}
            </span>
            <span>{row().domain}</span>
            <span>{ago(row().updated, props.now)}</span>
          </p>
          <p class="hint">
            {row().state === "wiring"
              ? `The tunnel row is wiring ${row().domain}'s DNS record.`
              : row().state === "live"
                ? `The tunnel row says ${row().domain} is live.`
                : `The tunnel row could not route ${row().domain}${
                    row().reason === null ? "." : `: ${row().reason}`
                  }`}
          </p>
        </>
      )}
    </Show>
  );
}
