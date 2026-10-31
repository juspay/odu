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
 *   - **`PeopleFace`** is the owner's page: who is in (`grant.list`) and the
 *     role each holds, with a control to grant or change one (`user.grant`).
 *     The shell DRAWS it for an owner; the row REFUSES everyone else on its own.
 */

import { createControl } from "@odu/face/control";
import { ago } from "@odu/cordis/format";
import { refusalText } from "@odu/face/refusal";
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
  type AuthPerson,
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
  /** Draw the way to the people page — the shell's decision, from the role. */
  canGrant: boolean;
  atPeople: boolean;
  onPeople: () => void;
}): JSX.Element {
  return (
    <div class="account">
      <Show when={props.canGrant}>
        <button
          type="button"
          class="link"
          aria-pressed={props.atPeople}
          onClick={() => props.onPeople()}
        >
          People
        </button>
      </Show>
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
  const control = createControl(props.call);

  /** The name is sent as typed: the ROW refuses an empty one in its own words
   *  — a button that greys out says nothing about why. */
  const create = (): void => {
    control.run(
      props.client.procedures.token.create({ name: name().trim() }),
      (answer) => {
        setName("");
        setMintedId(answer.facts.id);
        setMintedToken(answer.token);
        return `Created ${answer.facts.name}.`;
      },
      () => void refetch(),
    );
  };

  const revoke = (id: string): void => {
    control.run(
      props.client.procedures.token.revoke({ id }),
      () => {
        if (mintedId() === id) {
          setMintedId(null);
          setMintedToken(null);
        }
        return `Revoked ${id}.`;
      },
      () => void refetch(),
    );
  };

  const endSession = (id: string): void => {
    control.run(
      props.client.procedures.session.end({ id }),
      () => "Ended that session — its connections stop being served.",
      () => void refetch(),
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

      <Show when={control.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
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
            class="input"
            placeholder="token name, e.g. laptop"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <button type="button" class="btn btn-primary" disabled={control.busy()} onClick={create}>
          {control.busy() ? "creating…" : "Create token"}
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

/** The roles, least first — the order every select on this page offers them
 *  in, so a slip of the keyboard promotes nobody to owner. */
const ROLES = ["member", "admin", "owner"] as const;
type RoleName = (typeof ROLES)[number];

function isRole(value: string): value is RoleName {
  return (ROLES as readonly string[]).includes(value);
}

/** How a person's presence reads, in one phrase. */
function personLife(person: AuthPerson, now: number): string {
  const role = person.granted ? "granted" : "default role";
  return person.lastSeen === null
    ? `${role} · never signed in`
    : `${role} · last seen ${ago(person.lastSeen, now)}`;
}

/** The three roles as options, the held one SELECTED on the option itself —
 *  so no select's `value` races the options it names. */
function RoleOptions(props: { held: RoleName }): JSX.Element {
  return (
    <For each={ROLES}>
      {(one) => (
        <option value={one} selected={one === props.held}>
          {one}
        </option>
      )}
    </For>
  );
}

export interface PeopleFaceProps {
  client: AuthClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  now: number;
  onClose: () => void;
}

/**
 * WHO IS IN, AND WHAT EACH MAY DO — the owner's page, and `odu auth people` /
 * `odu auth grant` without a terminal.
 *
 * Read when it opens and after every grant, for the profile's reason: the role
 * table is not a live fact on the wire. A grant takes effect at the person's
 * NEXT connection (the row ends their open ones), so the page says so.
 */
export function PeopleFace(props: PeopleFaceProps): JSX.Element {
  type People =
    | { readonly ok: true; readonly people: readonly AuthPerson[] }
    | { readonly ok: false; readonly message: string };
  const [people, { refetch }] = createResource(async (): Promise<People> => {
    try {
      const answer = await props.call(props.client.procedures.grant.list());
      return { ok: true, people: answer.people };
    } catch (err) {
      return { ok: false, message: refusalText(err) };
    }
  });

  const [login, setLogin] = createSignal("");
  const [role, setRole] = createSignal<RoleName>("member");
  const control = createControl(props.call);

  /** One grant — from the form, or from a row's select. The login is sent as
   *  typed, empty included: the ROW refuses it (and a demotion of the last
   *  owner) in its own words, and that sentence is what the page shows. The
   *  list is re-read on either answer, so a refused change does not leave a
   *  select showing a role the daemon does not hold. */
  const grant = (who: string, to: RoleName): void => {
    control.run(
      // `rootToken` is the bootstrap's and is ignored for a signed-in caller:
      // this page is only ever an owner's session.
      props.client.procedures.user.grant({ login: who.trim(), role: to, rootToken: "" }),
      (answer) => {
        setLogin("");
        return `${answer.login} is now ${answer.role} — it takes effect at their next connection.`;
      },
      () => void refetch(),
    );
  };

  const listed = (): readonly AuthPerson[] => {
    const value = people();
    return value !== undefined && value.ok ? value.people : [];
  };
  const refusal = (): string | null => {
    const value = people();
    return value !== undefined && !value.ok ? value.message : null;
  };

  return (
    <section class="profile people-page" aria-label="people">
      <p class="crumbs">
        <button type="button" class="link" onClick={() => props.onClose()}>
          ← runs
        </button>
      </p>
      <h2>People</h2>
      <p class="hint">
        GitHub decides who may enter; this page decides what each person may do once in.
      </p>

      <div class="admin-section">
        <h3>Grant a role</h3>
        <label class="search">
          <span class="sr-only">GitHub login</span>
          <input
            type="text"
            class="input"
            placeholder="GitHub login, e.g. octocat"
            value={login()}
            onInput={(event) => setLogin(event.currentTarget.value)}
          />
        </label>
        <label class="field-inline">
          <span>role</span>
          <select
            class="input"
            aria-label="role to grant"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (isRole(value)) setRole(value);
            }}
          >
            <RoleOptions held={role()} />
          </select>
        </label>
        <button
          type="button"
          class="btn btn-primary"
          disabled={control.busy()}
          onClick={() => grant(login(), role())}
        >
          {control.busy() ? "granting…" : "Grant"}
        </button>
      </div>

      <Show when={control.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
      <Show when={control.done()}>{(message) => <p class="hint done">{message()}</p>}</Show>
      <Show when={refusal()}>{(message) => <p class="fault">{message()}</p>}</Show>

      <h3>Who is in</h3>
      <Show
        when={listed().length > 0}
        fallback={
          <Show when={refusal() === null}>
            <p class="hint">{people.loading ? "reading…" : "Nobody has signed in yet."}</p>
          </Show>
        }
      >
        <ul class="people">
          <For each={listed()}>
            {(person) => (
              <li>
                <span>
                  <strong>{person.login}</strong>
                  <span class="hint"> {personLife(person, props.now)}</span>
                </span>
                {/* CHANGING A ROLE IS A GRANT. The select shows the role held;
                    choosing another one grants it at once, and the list is
                    re-read so the row says what the daemon now holds. */}
                <select
                  class="input"
                  aria-label={`role of ${person.login}`}
                  disabled={control.busy()}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (isRole(value) && value !== person.role) grant(person.login, value);
                  }}
                >
                  <RoleOptions held={person.role} />
                </select>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
