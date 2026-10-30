/**
 * THE COMPOSITION'S TWO REFUSALS — the failures that would otherwise serve.
 *
 * A daemon that mounted three of its four rows comes up looking healthy and
 * answers `unknown verb` to every member the absent row owned, which every face
 * in this tree reports as "this build is too old for that service". That is a
 * diagnosis pointing at a version skew, on a machine where the truth is a row
 * that did not start — so the composition refuses at boot instead, naming the
 * row.
 *
 * The second refusal is the same shape one level down: a row's NAME and the
 * SIBLING KEY its surface is served under are one name, because that is what a
 * client folds its health under and what a fence asserts. A row that mounted
 * itself somewhere else would serve a surface nobody dials.
 */

import { describe, expect, it } from "bun:test";
import { composeRows, type Row } from "./rows";
import type { RowContribution } from "./services";

/** A contribution that says nothing and serves no routes — enough for the
 *  composition's own checks, and deliberately not a runtime. */
const nothing: RowContribution = {
  runtime: null,
  attach: null,
  routes: null,
  agent: null,
  done: null,
};

/** A contribution standing in for the ROOTED bundle. */
function rootWith(): RowContribution {
  // ONE CAST, because the composition only ever hands a sibling the runtime:
  // the rest of a rooted bundle is what the runs row built, and none of it is
  // this test's subject.
  const runtime = {} as unknown as NonNullable<RowContribution["runtime"]>;
  return { ...nothing, runtime };
}

/** A sibling that records the fact that the composition attached it. */
function siblingWith(attached: string[], key: string): RowContribution {
  return { ...nothing, attach: () => attached.push(key) };
}

/** Two rows, one of them a sibling — the shape this build has once the cache is
 *  its own row, and the smallest set that can exercise both refusals. */
const TWO_ROWS: ReadonlyArray<Row> = [
  { name: "ci", key: null, plugin: null as unknown as Row["plugin"] },
  { name: "cache", key: "cache", plugin: null as unknown as Row["plugin"] },
];

describe("composing the rows", () => {
  it("refuses to serve when a row published nothing", () => {
    expect(() => composeRows([["ci", rootWith()]], TWO_ROWS)).toThrow(/cache/);
  });

  it("refuses a sibling that asked for no attach", () => {
    expect(() =>
      composeRows([["ci", rootWith()], ["cache", nothing]], TWO_ROWS),
    ).toThrow(/"cache" is a sibling but asked for no attach/);
  });

  it("attaches every sibling to the root's bundle, and only those", () => {
    const attached: string[] = [];
    const composed = composeRows(
      [["ci", rootWith()], ["cache", siblingWith(attached, "cache")]],
      TWO_ROWS,
    );
    expect(attached).toEqual(["cache"]);
    expect(composed.routes).toBeNull();
    expect(composed.siblings).toEqual({});
  });
});
