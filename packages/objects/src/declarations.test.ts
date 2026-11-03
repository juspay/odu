/**
 * A STORE'S PUBLIC URL, as the declarations file spells it.
 *
 * The rest of the parser is exercised where its refusals are read (the cache's
 * `stores.test.ts`); what is proved here is the one field a reader of the
 * store depends on, because an operator writes it by hand and a wrong one
 * would send every reader of the bucket to the wrong address.
 */

import { describe, expect, it } from "bun:test";
import { parseStoreDeclarations } from "./declarations";

const CREDENTIALS = "AWS_ACCESS_KEY_ID=key\nAWS_SECRET_ACCESS_KEY=secret\n";
const BASE = {
  kind: "s3",
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "odu",
  region: "auto",
  credentialsFile: "/run/credentials/r2",
};

const parse = (store: Record<string, unknown>) =>
  parseStoreDeclarations(
    { file: "stores.json", text: JSON.stringify({ r2: { ...BASE, ...store } }) },
    { readFile: () => CREDENTIALS },
  );

describe("a store's publicUrl", () => {
  it("is absent unless it is declared", () => {
    const parsed = parse({});
    expect(parsed.kind === "declared" && parsed.stores.get("r2")?.target.publicUrl).toBeUndefined();
  });

  it("is parsed onto the target, beside the endpoint it does not replace", () => {
    const parsed = parse({ publicUrl: "https://cache.example.com" });
    if (parsed.kind !== "declared") throw new Error(`refused: ${JSON.stringify(parsed.refusal)}`);
    const target = parsed.stores.get("r2");
    expect(target?.target.publicUrl?.href).toBe("https://cache.example.com/");
    // SIGNING STAYS WHERE IT WAS: a public address is read from, never signed
    // for, and the endpoint is untouched by having one.
    expect(target?.target.endpoint.href).toBe("https://account.r2.cloudflarestorage.com/");
  });

  it("takes a plain http host, for the same reason an endpoint may be one", () => {
    // A LOCAL GATEWAY in a VM test has no certificate; production is https.
    const parsed = parse({ publicUrl: "http://localhost:7070" });
    expect(parsed.kind === "declared" && parsed.stores.get("r2")?.target.publicUrl?.href).toBe("http://localhost:7070/");
  });

  it("refuses anything but a host, naming what is wrong", () => {
    // A PATH WOULD MOVE EVERY KEY, and a query or a fragment would be carried
    // into a URL the reader builds by appending to this one.
    const cases: [unknown, string][] = [
      ["https://cache.example.com/cache", "has a path"],
      ["https://cache.example.com/?x=1", "has a query or fragment"],
      ["https://cache.example.com/#frag", "has a query or fragment"],
      ["ftp://cache.example.com", "is not an http(s) URL"],
      ["not a url", "is not a URL"],
      ["", "publicUrl is not a URL"],
      [7, "publicUrl is not a URL"],
    ];
    for (const [publicUrl, reason] of cases) {
      const parsed = parse({ publicUrl });
      const refusal = parsed.kind === "refused" ? parsed.refusal : null;
      expect({ publicUrl, kind: refusal?.kind ?? "declared" }).toEqual({ publicUrl, kind: "bad_store" });
      expect(refusal?.kind === "bad_store" ? refusal.reason : "").toContain(reason);
    }
  });
});
