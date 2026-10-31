/**
 * THE DOOR'S FACE — the sign-in page, the signed-in header, and the profile.
 *
 * It is here rather than in `@odu/web-ui` for the reason `@odu/cache/face` is:
 * a row owns everything about itself, and what a sign-in looks like is one of
 * those things. The shell imports this and hands it the auth client; it holds
 * no run client and reaches no other row.
 *
 * ## Three pieces, and what each may assume
 *
 *   - **`SignIn`** is what an ANONYMOUS browser meets instead of the board. It
 *     is a link and nothing else: GitHub's authorisation page is the form, and
 *     the daemon's `/auth/github` route is what starts the flow.
 *   - **`SignedInHeader`** is the login, its role, the way to the profile, and
 *     sign-out. Sign-out is a real `<form method="post">`, so the cookie the
 *     browser cannot read is the one the server clears.
 *   - **`ProfileFace`** is sessions and personal tokens: create (the token is
 *     shown once), revoke, and end a session. It reads them when it opens rather
 *     than subscribing — a token list is not a live fact, and `whoami` on the
 *     next call is what notices a revocation.
 */

import { ago } from "@odu/cordis/format";
import type { SurfaceClient } from "@kolu/surface/solid";
import type { Effect } from "effect";
import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import {
  AUTH_SIGN_IN_PATH,
  AUTH_SIGN_OUT_PATH,
  SIGN_IN_COPY,
  type AuthSession,
  type AuthToken,
  oduAuthSurface,
  type Who,
} from "./surface";

/** The caller's identity, re-exported so a shell that opens this door does not
 *  also reach for the contract module. */
export type { Who } from "./surface";

type AuthSpec = (typeof oduAuthSurface)["spec"];

/** The auth row's client as a VIEW holds it. */
export type AuthClient = SurfaceClient<AuthSpec>;

/** What the shell renders when this connection has no session. */
export function SignIn(): JSX.Element {
  return (
    <section class="signin" aria-label="sign in">
      <h1 class="signin-title">{SIGN_IN_COPY.title}</h1>
      <p class="hint">{SIGN_IN_COPY.hint}</p>
      {/* A link, not a button: GitHub's authorisation page is the form, and a
          person may want to open it in a new tab. */}
      <a class="signin-action" href={AUTH_SIGN_IN_PATH}>
        {SIGN_IN_COPY.action}
      </a>
    </section>
  );
}

/** The header, when somebody is signed in — or when the daemon has no door and
 *  the caller is its local owner. */
export function SignedInHeader(props: {
  who: Who;
  atProfile: boolean;
  onProfile: () => void;
}): JSX.Element {
  return (
    <div class="account">
      <Switch>
        <Match when={props.who.kind === "user" ? props.who : null}>
          {(who) => (
            <button
              type="button"
              class="link account-name"
              aria-pressed={props.atProfile}
              onClick={() => props.onProfile()}
            >
              {who().login}
              <span class="pill hue-grey">{who().role}</span>
            </button>
          )}
        </Match>
        <Match when={props.who.kind === "local"}>
          <span class="account-name">local owner</span>
        </Match>
      </Switch>
      <Show when={props.who.kind === "user"}>
        {/* A form POST: the session cookie is HttpOnly, so the only thing that
            can clear it is the server answering a request. */}
        <form method="post" action={AUTH_SIGN_OUT_PATH} class="account-out">
          <button type="submit" class="link">
            Sign out
          </button>
        </form>
      </Show>
    </div>
  );
}

type Readings =
  | {
      readonly ok: true;
      readonly sessions: readonly AuthSession[];
      readonly tokens: readonly AuthToken[];
    }
  | { readonly ok: false; readonly message: string };

/** A refusal as a sentence. */
function refusalText(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(err);
}

/** How a token's life reads, in one phrase. */
function tokenLife(token: AuthToken, now: number): string {
  if (token.revoked) return "revoked";
  const used = token.lastUsed === null ? "never used" : `last used ${ago(token.lastUsed, now)}`;
  return `${used} · created ${ago(token.created, now)}`;
}

/** How a session's life reads, in one phrase. */
function sessionLife(session: AuthSession, now: number): string {
  return `signed in ${ago(session.created, now)} · last seen ${ago(session.lastSeen, now)}`;
}

/** Where this page is served — the origin a minted token is for. */
function pageOrigin(): string {
  return typeof globalThis.location === "undefined" ? "<origin>" : globalThis.location.origin;
}

export interface ProfileFaceProps {
  client: AuthClient;
  /** The UI edge, supplied by the shell — a click is where an `Effect` runs. */
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  now: number;
  who: Who;
  onClose: () => void;
}

export function ProfileFace(props: ProfileFaceProps): JSX.Element {
  const [readings, { refetch }] = createResource(async (): Promise<Readings> => {
    try {
      const [sessions, tokens] = await Promise.all([
        props.call(props.client.procedures.session.list()),
        props.call(props.client.procedures.token.list()),
      ]);
      return { ok: true, sessions: sessions.sessions, tokens: tokens.tokens };
    } catch (err) {
      return { ok: false, message: refusalText(err) };
    }
  });

  /** The token just minted — the ONE time it can be read. */
  const [mintedId, setMintedId] = createSignal<string | null>(null);
  const [mintedToken, setMintedToken] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const create = (): void => {
    const label = name().trim();
    if (label === "") return;
    setBusy(true);
    setFailure(null);
    void props.call(props.client.procedures.token.create({ name: label })).then(
      (answer) => {
        setBusy(false);
        setName("");
        setMintedId(answer.facts.id);
        setMintedToken(answer.token);
        void refetch();
      },
      (err: unknown) => {
        setBusy(false);
        setFailure(refusalText(err));
      },
    );
  };

  const revoke = (id: string): void => {
    setFailure(null);
    void props.call(props.client.procedures.token.revoke({ id })).then(
      () => {
        if (mintedId() === id) {
          setMintedId(null);
          setMintedToken(null);
        }
        void refetch();
      },
      (err: unknown) => setFailure(refusalText(err)),
    );
  };

  const endSession = (id: string): void => {
    setFailure(null);
    void props.call(props.client.procedures.session.end({ id })).then(
      () => void refetch(),
      (err: unknown) => setFailure(refusalText(err)),
    );
  };

  const tokens = (): readonly AuthToken[] => {
    const value = readings();
    return value !== undefined && value.ok ? value.tokens : [];
  };
  const sessions = (): readonly AuthSession[] => {
    const value = readings();
    return value !== undefined && value.ok ? value.sessions : [];
  };
  const refusal = (): string | null => {
    const value = readings();
    return value !== undefined && !value.ok ? value.message : null;
  };

  return (
    <section class="profile" aria-label="profile">
      <p class="crumbs">
        <button type="button" class="link" onClick={() => props.onClose()}>
          ← runs
        </button>
      </p>
      <h2>
        {props.who.kind === "user" ? props.who.login : "local owner"}
        <Show when={props.who.kind === "user" ? props.who : null}>
          {(who) => <span class="pill hue-grey">{who().role}</span>}
        </Show>
      </h2>

      <Show when={failure()}>{(message) => <p class="fault">{message()}</p>}</Show>
      <Show when={refusal()}>{(message) => <p class="fault">{message()}</p>}</Show>

      <Show when={mintedToken()}>
        {(token) => (
          <div class="profile-minted">
            <p>
              <strong>Copy this token now.</strong> It is shown once; only a hash is kept.
            </p>
            <pre class="use-block">{token()}</pre>
            <p class="hint">
              <code>odu auth login {pageOrigin()}</code> stores it on a machine, or set{" "}
              <code>ODU_TOKEN</code> for an agent.
            </p>
          </div>
        )}
      </Show>

      <h3>Personal access tokens</h3>
      <div class="profile-create">
        <label class="search">
          <span class="sr-only">token name</span>
          <input
            type="text"
            placeholder="token name, e.g. laptop"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <button type="button" disabled={busy() || name().trim() === ""} onClick={create}>
          {busy() ? "creating…" : "Create token"}
        </button>
      </div>
      <Show when={tokens().length > 0} fallback={<p class="hint">No tokens yet.</p>}>
        <ul class="tokens">
          <For each={tokens()}>
            {(token) => (
              <li>
                <span>
                  <strong>{token.name}</strong>
                  <span class="hint"> {tokenLife(token, props.now)}</span>
                </span>
                <Show when={token.id === mintedId()}>
                  <span class="pill hue-amber">just created</span>
                </Show>
                <Show when={!token.revoked}>
                  <button type="button" class="text-action" onClick={() => revoke(token.id)}>
                    revoke
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <h3>Sessions</h3>
      <Show when={sessions().length > 0} fallback={<p class="hint">No sessions.</p>}>
        <ul class="sessions">
          <For each={sessions()}>
            {(session) => (
              <li>
                <span>
                  <strong>{session.agent ?? "unknown browser"}</strong>
                  <span class="hint"> {sessionLife(session, props.now)}</span>
                </span>
                <button
                  type="button"
                  class="text-action"
                  onClick={() => endSession(session.id)}
                >
                  end
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
