/**
 * A GITHUB, SMALL ENOUGH TO BE ONE FILE.
 *
 * The door talks to four endpoints, so the stub answers those four and nothing
 * else: the authorisation page (which redirects straight back, as a person who
 * has already consented would), the token exchange, `/user`, and the two
 * membership probes. Pointing a world at it is `ODU_GITHUB_ORIGIN` /
 * `ODU_GITHUB_API`, which is why those two settings exist in the first place —
 * a GitHub Enterprise install needs them too.
 *
 * **What a scenario can vary**, and why each is a promise:
 *
 *   - `login` — who GitHub says you are;
 *   - `orgMember` / `teamMember` — whether the allow-list lets you in, which is
 *     the "a login outside the list is refused with a reason" scenario;
 *   - `expires` — the App was configured with token expiry on. The row must
 *     REFUSE that sign-in and say which setting to turn off.
 *
 * One server answers both origins because the flow's two halves share nothing
 * but a host; a test that needed two ports would be testing our URL handling
 * rather than the flow.
 */

import { createServer, type Server } from "node:http";

export interface StubMode {
  /** The login GitHub will claim. */
  login: string;
  /** Is that login an active member of the organisation the allow-list names? */
  orgMember: boolean;
  /** …and of the team, when the allow-list names one? */
  teamMember: boolean;
  /** Issue an expiring user token (the App misconfiguration the row refuses). */
  expires: boolean;
}

export interface GithubStub {
  /** Both `ODU_GITHUB_ORIGIN` and `ODU_GITHUB_API`. */
  origin: string;
  /** The mode the next request answers with. Mutated per scenario. */
  mode: StubMode;
  /** The last authorisation URL a browser was redirected to — what a step reads
   *  to prove the flow started with the App's client id and no scope. */
  lastAuthorize: URL | null;
  close(): Promise<void>;
}

const DEFAULT_MODE: StubMode = {
  login: "odu-e2e",
  orgMember: true,
  teamMember: true,
  expires: false,
};

/** Listen on a free loopback port, and answer as GitHub would. */
export async function startGithubStub(port: number): Promise<GithubStub> {
  const stub: GithubStub = {
    origin: `http://127.0.0.1:${port}`,
    mode: { ...DEFAULT_MODE },
    lastAuthorize: null,
    close: async () => {},
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", stub.origin);
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/login/oauth/authorize") {
      stub.lastAuthorize = url;
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (redirect === null) {
        json(400, { error: "no redirect_uri" });
        return;
      }
      const back = new URL(redirect);
      back.searchParams.set("code", "stub-code");
      if (state !== null) back.searchParams.set("state", state);
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }

    if (url.pathname === "/login/oauth/access_token") {
      if (stub.mode.expires) {
        json(200, {
          access_token: "stub-token",
          token_type: "bearer",
          expires_in: 28_800,
          refresh_token: "stub-refresh",
        });
        return;
      }
      json(200, { access_token: "stub-token", token_type: "bearer" });
      return;
    }

    if (url.pathname === "/user") {
      json(200, { login: stub.mode.login, id: 1 });
      return;
    }

    if (url.pathname.startsWith("/user/memberships/orgs/")) {
      if (stub.mode.orgMember) json(200, { state: "active", role: "member" });
      else json(404, { message: "Not Found" });
      return;
    }

    if (/^\/orgs\/[^/]+\/teams\/[^/]+\/memberships\/[^/]+$/.test(url.pathname)) {
      if (stub.mode.teamMember) json(200, { state: "active", role: "member" });
      else json(404, { message: "Not Found" });
      return;
    }

    json(404, { message: `the stub does not answer ${url.pathname}` });
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(port, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  stub.close = () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  };
  return stub;
}
