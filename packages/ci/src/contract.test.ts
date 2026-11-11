/**
 * THE CI ROW'S VERSION, HELD TO ITS SURFACE.
 *
 * `LEDGER` is every version this row has published, in order, each with the
 * fingerprint of the surface it described (`@odu/cordis/contract`). It is
 * APPEND-ONLY: a bump adds a line, and an edited old line is a surface change
 * shipped under an old number. Change the surface without
 * moving `CI_CONTRACT_VERSION` and this fails, naming the bump rule: the MINOR when the
 * surface only grows, the MAJOR when something a reader already uses changes.
 * Then append the line the message prints.
 *
 * The identity cell (`service`) is SERVED on this surface but is the host's
 * fact, so it is left out here and pinned in `packages/host/src/contract.test.ts`
 * against the host's version — each fact is versioned once.
 */

import { describe, expect, it } from "bun:test";
import { type ContractLedger, contractLedgerMismatch, rowShape, surfaceFingerprint } from "@odu/cordis/contract";
import { CI_CONTRACT_VERSION, oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";

const LEDGER: ContractLedger = {
  "2.4": "83be116bdd6efc03",
  // 2.5 — PLAN 4.1: `push` on a run row and on a wait/read answer (where this
  // run pushes, why it does not, and what it warmed), and `pushed` on a node
  // — its paths, its bytes and the push's own time. Optional output fields;
  // additive.
  "2.5": "5b69127e21682efd",
  // 2.6 — TWO unreleased changes share this line, because a version is a
  // description of a SURFACE and there is only one surface here. PLAN 4.4
  // brought `actor` on a run row and on a wait/read answer — who started the
  // run, a login or `@local` for a loopback caller — and `probing` as a fifth
  // venue state, so the kept reading can be republished while a probe is
  // still dialling. PLAN 4.1's second half made the push a STEP: a node's
  // `pushed` counts are gone, replaced by `push` — a state (`pushing` |
  // `pushed` | `failed`) that carries `stored` (what this node put on the
  // bucket) and `present` (what the bucket already served) APART, where one
  // `paths` used to report their sum and so read as traffic that never
  // happened — and only when there are counts to carry, so a node mid-push
  // and a node that failed to push are sayable at all;
  // `log_read` gained `stream`, absent meaning the recipe's log, so one
  // key addresses both of an attempt's outputs; and the wait/read answer's
  // `push` gained `failedOn` and `present`, both optional because that struct
  // shipped in 2.5 and a required field there would make every answer about a
  // pushing run fail to decode.
  //
  // A failed push also carries its `message` — the push client's own
  // sentence, which the lane has as a value when it stamps the cell and
  // which a reader who no longer has the push log needs.
  //
  // MINOR despite the one removal: node `pushed` shipped in 2.5 one release
  // ago and had no reader outside this repo, and the surface otherwise only
  // grows.
  //
  // RE-PINNED, not appended: 2.6 has never shipped, so the surface it
  // describes is the one being written. The rule the message states — never
  // rewrite a historical line — is about a number somebody could already be
  // running.
  "2.6": "e2f201e5520f3c25",
  // 2.7 — PLAN 4.4: `run.start`'s `branch`. A caller that names a checkout on
  // the service may now name the branch that clone should be ON for the
  // commit it is handing over, and the service fetches and moves it there
  // rather than refusing every commit the clone has not got yet. One optional
  // INPUT key; additive, so MINOR. A 2.6 daemon drops it as excess and keeps
  // refusing a clone that is not already on the commit — the answer a caller
  // gets without the field, never a run against the wrong one.
  "2.7": "3cf445349a1994c0",
};

describe("the ci row's contract", () => {
  it("is the last line of its ledger, and the surface is that line's", () => {
    const current = {
      version: CI_CONTRACT_VERSION,
      fingerprint: surfaceFingerprint(rowShape(oduServiceSurface, ODU_SERVICE_EXPOSE, ["service"])),
    };
    const mismatch = contractLedgerMismatch("the ci row", "CI_CONTRACT_VERSION", current, LEDGER);
    expect(mismatch, mismatch ?? "").toBeNull();
  });
});
