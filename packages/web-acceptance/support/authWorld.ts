import type { Identity, OduWorld } from "./world.ts";

export type { Identity };

export const STUB_LOGIN = "odu-e2e";

export const OPERATOR_LOGIN = "odu-owner";

export const STUB_ALLOW = "org:juspay";

export const STUB_CLIENT_ID = "stub-client-id";
export const STUB_CLIENT_SECRET = "stub-client-secret";

export function identityOf(tags: readonly { readonly name: string }[]): Identity {
  const named = tags.map((tag) => tag.name);
  const signedIn = named.find((name) => name.startsWith("@signed-in:"));
  if (signedIn !== undefined) {
    const role = signedIn.slice("@signed-in:".length);
    if (role === "owner" || role === "admin" || role === "member") {
      return { kind: "signed-in", role };
    }
    throw new Error(
      `web-acceptance: ${signedIn} names no role — use @signed-in:owner|admin|member`,
    );
  }
  if (named.includes("@anonymous")) return { kind: "anonymous" };
  if (named.includes("@tunnel")) return { kind: "tunnel" };
  return { kind: "loopback" };
}

export function doorEnv(opts: {
  readonly origin: string;
  readonly stubOrigin: string;
  readonly secretFile: string;
  readonly allow?: string;
}): NodeJS.ProcessEnv {
  return {
    ODU_PUBLIC_ORIGIN: opts.origin,
    ODU_GITHUB_CLIENT_ID: STUB_CLIENT_ID,
    ODU_GITHUB_CLIENT_SECRET_FILE: opts.secretFile,
    ODU_GITHUB_ALLOW: opts.allow ?? STUB_ALLOW,
    ODU_GITHUB_ORIGIN: opts.stubOrigin,
    ODU_GITHUB_API: opts.stubOrigin,
  };
}

export async function signIn(world: OduWorld): Promise<void> {
  await world.page.goto(new URL("/auth/github", world.service.origin).href, {
    waitUntil: "domcontentloaded",
  });
}
