import { setWorldConstructor, World } from "@cucumber/cucumber";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import type { Service } from "./service.ts";
import type { GithubStub } from "./githubStub.ts";

export type Identity =
  | { readonly kind: "loopback" }
  | { readonly kind: "anonymous" }
  | { readonly kind: "tunnel" }
  | { readonly kind: "signed-in"; readonly role: "owner" | "admin" | "member" };

export class OduWorld extends World {
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  service!: Service;

  identity: Identity = { kind: "loopback" };
  signInLogin = "";
  mintedToken?: string;
  cliAnswer?: { status: number | null; stdout: string; stderr: string };
  visited?: { status: number | null; body: string };
  second?: Page;
  stub!: GithubStub;

  scenarioName = "(unnamed scenario)";

  checkout?: string;
  runId?: string;
  runRef?: string;

  cacheBucket?: string;
  cachePath?: string;
  cachePathName?: string;
  cachePaths?: string[];
  cachePathNames?: string[];
  readonly rowState = new Map<string, unknown>();

  ownFixtures: string[] = [];
  ownRuns: string[] = [];

  errors: string[] = [];
  requests: string[] = [];
  expectedResponses: { status: number; url: string }[] = [];
  failedResponses: { status: number; url: string }[] = [];

  failureLogKey?: string;
  failureNode?: string;

  async open(hash = "#/"): Promise<void> {
    await this.page.goto(new URL(hash, this.service.origin).href);
  }

  wire(): Locator {
    return this.page.locator(".wire");
  }

  receipt(): Locator {
    return this.page.locator("p.receipt");
  }

  nodeRow(id: string): Locator {
    return this.page.locator("li.node", { hasText: id });
  }

  runRow(text: string): Locator {
    return this.page.locator("button.row", { hasText: text });
  }

  async waitUntil(
    ask: () => Promise<boolean>,
    what: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await ask()) return;
      if (Date.now() > deadline) {
        throw new Error(`web-acceptance: ${what} did not happen within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async saysThat(
    locator: Locator,
    what: string,
    text: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    let last = "(nothing — the element was never there)";
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const seen = await locator.first().innerText({ timeout: 1000 });
        if (seen.includes(text)) return;
        last = seen;
      } catch (cause) {
        if (!(cause instanceof Error) || cause.name !== "TimeoutError") throw cause;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `web-acceptance: ${what} never said ${JSON.stringify(text)} within ${timeoutMs}ms.\n` +
            `It said: ${JSON.stringify(last)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

setWorldConstructor(OduWorld);
