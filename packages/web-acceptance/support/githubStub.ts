import { createServer, type Server } from "node:http";

export interface StubMode {
  login: string;
  orgMember: boolean;
  teamMember: boolean;
  expires: boolean;
}

export interface GithubStub {
  origin: string;
  mode: StubMode;
  lastAuthorize: URL | null;
  close(): Promise<void>;
}

export const DEFAULT_STUB_MODE: StubMode = {
  login: "odu-e2e",
  orgMember: true,
  teamMember: true,
  expires: false,
};

export async function startGithubStub(port: number): Promise<GithubStub> {
  const stub: GithubStub = {
    origin: `http://127.0.0.1:${port}`,
    mode: { ...DEFAULT_STUB_MODE },
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
