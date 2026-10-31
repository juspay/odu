/**
 * WHO THE BOARD THINKS IS HERE — the one decision every control's visibility
 * rests on.
 *
 * It is pure and exported from the shell for exactly one reason: a mistake in
 * it hides buttons instead of throwing. Round 2 shipped one — with no door the
 * page granted nobody any floor, so a loopback daemon lost Start run, Retry,
 * Run again and both cancels, and only a browser would have said so.
 */

import { describe, expect, it } from "bun:test";
import { doorAfterAnswer, holds, principalOf, showsBoard } from "./app";

const MEMBER = { kind: "user", login: "srid", role: "member" } as const;
const ADMIN = { kind: "user", login: "srid", role: "admin" } as const;

describe("with no door", () => {
  it("the caller IS the local owner, and holds every floor", () => {
    const principal = principalOf(false, null);
    expect(principal).toEqual({ kind: "local" });
    expect(holds(principal, "member")).toBe(true);
    expect(holds(principal, "admin")).toBe(true);
    expect(holds(principal, "owner")).toBe(true);
  });

  it("draws the board — there is nothing to sign in to", () => {
    expect(showsBoard(false, null)).toBe(true);
  });
});

describe("with a door", () => {
  it("grants nothing until whoami answers", () => {
    const principal = principalOf(true, null);
    expect(principal).toBeNull();
    expect(holds(principal, "member")).toBe(false);
    expect(showsBoard(true, null)).toBe(false);
  });

  it("grants nothing to an anonymous connection", () => {
    const principal = principalOf(true, { kind: "anonymous" });
    expect(principal).toBeNull();
    expect(holds(principal, "member")).toBe(false);
    expect(showsBoard(true, { kind: "anonymous" })).toBe(false);
  });

  it("grants a member the member floor and not the admin one", () => {
    const principal = principalOf(true, MEMBER);
    expect(holds(principal, "member")).toBe(true);
    expect(holds(principal, "admin")).toBe(false);
    expect(showsBoard(true, MEMBER)).toBe(true);
  });

  it("grants an admin the admin floor", () => {
    expect(holds(principalOf(true, ADMIN), "admin")).toBe(true);
  });
});

describe("re-asking the door", () => {
  it("keeps the door a page already knew when the re-ask fails", () => {
    // A host that cannot be reached has not answered: the wire says so, and the
    // board stays. Otherwise a dropped connection removes every run control.
    expect(doorAfterAnswer(true, null)).toBe(true);
    expect(doorAfterAnswer(false, null)).toBe(false);
    expect(doorAfterAnswer(null, null)).toBeNull();
  });

  it("takes the answer when there is one", () => {
    expect(doorAfterAnswer(true, false)).toBe(false);
    expect(doorAfterAnswer(false, true)).toBe(true);
  });
});

describe("with an unknown door", () => {
  it("grants nothing, and draws nothing", () => {
    // A daemon that never answered is not a loopback daemon: assuming one would
    // draw every run control for a server that is not there.
    expect(principalOf(null, null)).toBeNull();
    expect(showsBoard(null, null)).toBe(false);
  });
});
