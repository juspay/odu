/**
 * THE DOOR'S FACE — the sign-in page, the signed-in header, and the profile.
 *
 * It is here rather than in `@odu/web-ui` for the reason `@odu/cache/face` is:
 * a row owns everything about itself, and what a sign-in looks like is one of
 * those things. The shell imports this and hands it the auth client; it holds
 * no run client and reaches no other row.
 *
 * ## Four pieces, and what each may assume
 *
 *   - **`SignIn`** is what an ANONYMOUS browser meets INSTEAD OF the whole app
 *     — no rail and no frame, because there is nothing yet to navigate. It is
 *     a link and nothing else: GitHub's authorisation page is the form, and the
 *     daemon's `/auth/github` route is what starts the flow.
 *   - **`SignedInHeader`** is the RAIL'S ACCOUNT CARD: the login, its role, the
 *     way to the profile, and sign-out. Sign-out is a real
 *     `<form method="post">`, so the cookie the browser cannot read is the one
 *     the server clears. The row switch BESIDE it is the shell's and not this
 *     file's — the way to the people page included.
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
import {
  BackLink,
  Button,
  CopyButton,
  PageHead,
  Panel,
  Pill,
  Tag,
  TextInput,
} from "@odu/face/ui";
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

/** HOW MANY CELLS the sign-in's field draws — eighteen columns of twelve at
 *  the artboard's size. The grid is `auto-fit`, so a narrower pane rewraps the
 *  same cells rather than being given a different number of them. */
const SIGN_IN_CELLS = 216;

/**
 * THE FIELD'S PATTERN, COMPUTED ONCE AND NEVER AGAIN.
 *
 * A pure function of the index rather than `Math.random`: a decoration that
 * reshuffles on every render is a page that FLICKERS, and a page that flickers
 * while somebody reads "this server answers only to people its operator has
 * allowed in" looks like it is deciding something about them. Hoisted to the
 * module so it is one array for the life of the tab.
 *
 * The mix is the artboard's — mostly green, a little amber, one red in
 * twenty-three — because that is what a healthy board looks like, and this is
 * a picture of a board.
 */
const SIGN_IN_PATTERN: readonly string[] = Array.from(
  { length: SIGN_IN_CELLS },
  (_unused, index) => {
    const step = (index * 37 + (index % 7) * 11) % 23;
    if (step < 13) return "hue-green";
    if (step < 15) return "hue-amber";
    if (step === 15) return "hue-red";
    return "hue-grey";
  },
);

/**
 * WHAT AN ANONYMOUS CONNECTION MEETS — the whole screen, not a panel in one.
 *
 * Two panes. The right one is the product's name, what this server is, and the
 * ONE control. The left one is decoration, and the only decoration this design
 * has: a field of LANE CELLS, the same eleven pixels the board spends on a
 * node, so the first thing a stranger sees is the shape of the thing they are
 * signing in to.
 */
export function SignIn(): JSX.Element {
  return (
    <section class="signin" aria-label="sign in">
      {/* `aria-hidden`: the field says nothing a reader needs, and two hundred
          unnamed cells in the accessibility tree are two hundred things to
          skip past before reaching the only control on the page. */}
      <div class="signin-art" aria-hidden="true">
        <div class="signin-grid">
          <For each={SIGN_IN_PATTERN}>{(hue) => <span class={`cell ${hue}`} />}</For>
        </div>
      </div>
      <div class="signin-main">
        <div class="signin-card">
          <span class="brand-name">odu</span>
          <div class="stack">
            <h1 class="signin-title">{SIGN_IN_COPY.title}</h1>
            <p class="hint">{SIGN_IN_COPY.hint}</p>
          </div>
          {/* A link, not a button: GitHub's authorisation page is the form, and
              a person may want to open it in a new tab. */}
          <a class="signin-action" href={AUTH_SIGN_IN_PATH}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2Z" />
            </svg>
            {SIGN_IN_COPY.action}
          </a>
          {/* WHICH SERVER THIS IS. A person reaches a dozen of these by tailnet
              name, and the origin is the only thing on the page that says which
              one is asking them to sign in. */}
          <p class="signin-foot">{pageOrigin()}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * THE RAIL'S ACCOUNT CARD — who you are, what you hold, and the way out.
 *
 * It sits at the foot of the shell's sidebar, where an account lives in every
 * application a person has ever used. It draws the way to the PROFILE and
 * nothing else: the rows, People included, are the rail's own navigation, and
 * a second list of them down here was two things to keep in step.
 */
export function SignedInHeader(props: {
  who: Who;
  atProfile: boolean;
  onProfile: () => void;
}): JSX.Element {
  return (
    // ANONYMOUS DRAWS NOTHING, rather than an empty card: a bordered box with
    // no name in it reads as an account that failed to load.
    <Show when={props.who.kind !== "anonymous"}>
      <div class="whoami">
        <Switch>
          <Match when={props.who.kind === "user" ? props.who : null}>
            {(who) => (
              <>
                <span class="avatar" aria-hidden="true">
                  {who().login.slice(0, 1).toUpperCase()}
                </span>
                <span class="whoami-who">
                  <button
                    type="button"
                    class="link whoami-name account-name"
                    aria-pressed={props.atProfile}
                    onClick={() => props.onProfile()}
                  >
                    {who().login}
                  </button>
                  <span class="whoami-role">{who().role}</span>
                </span>
                {/* A form POST: the session cookie is HttpOnly, so the only
                    thing that can clear it is the server answering a request. */}
                <form method="post" action={AUTH_SIGN_OUT_PATH} class="account-out">
                  <button type="submit" class="link">
                    Sign out
                  </button>
                </form>
              </>
            )}
          </Match>
          {/* NO DOOR, and the caller is the machine's owner. `$` rather than an
              initial: there is no login to take one from, and a shell prompt is
              what this principal actually is. There is no sign-out either —
              nothing was signed in. */}
          <Match when={props.who.kind === "local"}>
            <span class="avatar" aria-hidden="true">
              $
            </span>
            <span class="whoami-who">
              <span class="whoami-name account-name">local owner</span>
              <span class="whoami-role">owner · no door</span>
            </span>
          </Match>
        </Switch>
      </div>
    </Show>
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
  const expires =
    token.expires === null
      ? "no expiry"
      : token.expires <= now
        ? `expired ${new Date(token.expires).toISOString().slice(0, 10)}`
        : `expires ${new Date(token.expires).toISOString().slice(0, 10)}`;
  return `${used} · ${expires} · created ${ago(token.created, now)}`;
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
  // NINETY DAYS IS THE FORM'S DEFAULT and "never" is a visible choice; the
  // row's absent-expiry rule is the API's, not a page's silent behaviour.
  const [expiry, setExpiry] = createSignal("90");
  const control = createControl(props.call);

  /** The name is sent as typed: the ROW refuses an empty one in its own words
   *  — a button that greys out says nothing about why. */
  const create = (): void => {
    control.run(
      props.client.procedures.token.create({
        name: name().trim(),
        ...(expiry() === "never" ? {} : { expiresDays: Number(expiry()) }),
      }),
      (answer) => {
        setName("");
        setMintedId(answer.facts.id);
        setMintedToken(answer.token);
        return expiry() === "never"
          ? `Created ${answer.facts.name}, with no expiry.`
          : `Created ${answer.facts.name}, expiring in ${expiry()} days.`;
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
        <BackLink onClick={() => props.onClose()}>runs</BackLink>
      </p>
      {/* THE LOGIN IS THE HEADING, in mono: it is the string the daemon knows
          this person by, and the one a `--origin` call will name. A local owner
          has no login and the page still exists for them — a token is how a
          machine with no door hands a credential to an agent. The role and the
          origin ride under it, because a token minted here is a credential FOR
          THIS SERVER and nothing else. */}
      <PageHead
        title={props.who.kind === "user" ? props.who.login : "local owner"}
        mono
        sub={`${props.who.kind === "user" ? props.who.role : "owner"} · ${pageOrigin()}`}
      />

      <Show when={control.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
      <Show when={control.done()}>{(message) => <p class="hint done">{message()}</p>}</Show>
      <Show when={refusal()}>{(message) => <p class="fault">{message()}</p>}</Show>

      <Panel
        title="Sessions"
        note="Every browser signed in as you. Revoking one stops serving its connections at once."
      >
        <div class="panel-body">
          <Show
            when={sessions().length > 0}
            fallback={<p class="empty">{readings.loading ? "reading…" : "No sessions."}</p>}
          >
            <ul class="facts">
              <For each={sessions()}>
                {(session) => (
                  <li>
                    <span>
                      <strong>{session.agent ?? "unknown browser"}</strong>
                      <span class="bucket-facts">{sessionLife(session, props.now)}</span>
                    </span>
                    <button
                      type="button"
                      class="text-action"
                      onClick={() => endSession(session.id)}
                    >
                      revoke
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Panel>

      <Panel
        title="Personal access tokens"
        note="A token is shown once, when it is minted — the row keeps only a hash."
      >
        {/* THE ONE SHOWING, at the top of the panel that minted it. A console
            surface rather than a field: it is read, copied and never seen
            again, and the copy control is beside it because nobody selects
            forty characters of base64 by hand on a phone. */}
        <Show when={mintedToken()}>
          {(token) => (
            <div class="profile-minted panel-body">
              <p>
                <strong>Copy this token now.</strong> It is shown once; only a hash is kept.
              </p>
              <pre class="use-block minted-token">{token()}</pre>
              <div class="control-row">
                <CopyButton text={token()} label="Copy token" />
                <span class="hint">
                  <code>odu auth login {pageOrigin()}</code> stores it on a machine, or set{" "}
                  <code>ODU_TOKEN</code> for an agent.
                </span>
              </div>
            </div>
          )}
        </Show>
        <div class="panel-body">
          <div class="stack">
            <div class="profile-create control-row">
              {/* The name is sent as typed and the button never greys out: the
                  ROW refuses an empty one in its own words, and a disabled
                  control says nothing about why. */}
              <label class="field-inline">
                <span class="sr-only">token name</span>
                <TextInput
                  id="token-name"
                  value={name()}
                  placeholder="token name, e.g. laptop"
                  onValue={(value) => setName(value)}
                />
              </label>
              <label class="field-inline">
                <span>expiry</span>
                <select
                  class="input"
                  aria-label="token expiry"
                  value={expiry()}
                  onChange={(event) => setExpiry(event.currentTarget.value)}
                >
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="365">1 year</option>
                  <option value="never">never</option>
                </select>
              </label>
              <Button class="btn-primary" disabled={control.busy()} onClick={create}>
                {control.busy() ? "creating…" : "Create token"}
              </Button>
            </div>
            <Show
              when={tokens().length > 0}
              fallback={<p class="empty">{readings.loading ? "reading…" : "No tokens yet."}</p>}
            >
              <ul class="tokens">
                <For each={tokens()}>
                  {(token) => (
                    <li>
                      <span>
                        <strong>{token.name}</strong>
                        <span class="bucket-facts">{tokenLife(token, props.now)}</span>
                      </span>
                      <span class="control-row">
                        <Show when={token.id === mintedId()}>
                          <Pill hue="amber">just created</Pill>
                        </Show>
                        {/* THE ID IS IN THE CONTROL'S NAME. Two tokens may both
                            be called `laptop`, and "revoke" alone would be two
                            controls with one name — to a screen reader and to
                            the acceptance suite alike. */}
                        <Show when={!token.revoked}>
                          <button
                            type="button"
                            class="text-action"
                            onClick={() => revoke(token.id)}
                          >
                            revoke {token.id}
                          </button>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      </Panel>
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
 * WHO IS IN, AND WHAT EACH MAY DO — the owner's page, and what
 * `odu surface auth grant_list` / `user_grant` answer, without a terminal.
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
    <section class="people-page" aria-label="people">
      <p class="crumbs">
        <BackLink onClick={() => props.onClose()}>runs</BackLink>
      </p>
      <PageHead
        title="People"
        sub="GitHub decides who may enter; this page decides what each person may do once in."
      />

      <Panel
        title="Grant a role"
        note="A grant takes effect at that person's next connection — their open ones end."
      >
        <div class="panel-body">
          <div class="stack">
            <div class="control-row">
              <label class="field-inline">
                <span class="sr-only">GitHub login</span>
                <TextInput
                  id="grant-login"
                  value={login()}
                  placeholder="GitHub login, e.g. octocat"
                  onValue={(value) => setLogin(value)}
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
              <Button
                class="btn-primary"
                disabled={control.busy()}
                onClick={() => grant(login(), role())}
              >
                {control.busy() ? "granting…" : "Grant"}
              </Button>
            </div>
            {/* THE ROW'S OWN SENTENCE, under the control that asked for it:
                "a grant needs a GitHub login" is the daemon's answer, not a
                validation message this page invented. */}
            <Show when={control.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
            <Show when={control.done()}>{(message) => <p class="hint done">{message()}</p>}</Show>
            <Show when={refusal()}>{(message) => <p class="fault">{message()}</p>}</Show>
          </div>
        </div>
      </Panel>

      <Panel title="Who is in" note="Everyone who has signed in, and what each one holds.">
        <div class="panel-body">
          <Show
            when={listed().length > 0}
            fallback={
              <Show when={refusal() === null}>
                <p class="empty">{people.loading ? "reading…" : "Nobody has signed in yet."}</p>
              </Show>
            }
          >
            <ul class="people">
              <For each={listed()}>
                {(person) => (
                  <li>
                    <span class="control-row">
                      <span class="avatar" aria-hidden="true">
                        {person.login.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <code class="path">{person.login}</code>
                        <span class="bucket-facts">{personLife(person, props.now)}</span>
                      </span>
                      {/* A ROLE IS A PROPERTY, not a verdict: a square grey tag
                          and not a hued pill, because every colour this page
                          owns already means something about a run. */}
                      <Tag>{person.role}</Tag>
                    </span>
                    {/* CHANGING A ROLE IS A GRANT. The select shows the role
                        held; choosing another one grants it at once, and the
                        list is re-read so the row says what the daemon now
                        holds. */}
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
        </div>
      </Panel>
    </section>
  );
}
