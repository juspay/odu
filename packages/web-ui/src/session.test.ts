import { describe, expect, it } from "bun:test";
import { doorAfterAnswer, holds, principalOf, showsBoard } from "./app";

const MEMBER = { kind: "user", login: "srid", role: "member" } as const;
const ADMIN = { kind: "user", login: "srid", role: "admin" } as const;

describe("with no door", () => {
  it("the caller IS the local owner, and holds every floor", () => {
    const principal = principalOf("open", null);
    expect(principal).toEqual({ kind: "local" });
    expect(holds(principal, "member")).toBe(true);
    expect(holds(principal, "admin")).toBe(true);
    expect(holds(principal, "owner")).toBe(true);
  });

  it("draws the board — there is nothing to sign in to", () => {
    expect(showsBoard("open", null)).toBe(true);
  });
});

describe("with a door", () => {
  it("grants nothing until whoami answers", () => {
    const principal = principalOf("guarded", null);
    expect(principal).toBeNull();
    expect(holds(principal, "member")).toBe(false);
    expect(showsBoard("guarded", null)).toBe(false);
  });

  it("grants nothing to an anonymous connection", () => {
    const principal = principalOf("guarded", { kind: "anonymous" });
    expect(principal).toBeNull();
    expect(holds(principal, "member")).toBe(false);
    expect(showsBoard("guarded", { kind: "anonymous" })).toBe(false);
  });

  it("grants a member the member floor and not the admin one", () => {
    const principal = principalOf("guarded", MEMBER);
    expect(holds(principal, "member")).toBe(true);
    expect(holds(principal, "admin")).toBe(false);
    expect(showsBoard("guarded", MEMBER)).toBe(true);
  });

  it("grants an admin the admin floor", () => {
    expect(holds(principalOf("guarded", ADMIN), "admin")).toBe(true);
  });
});

describe("re-asking the door", () => {
  it("keeps the door a page already knew when the re-ask fails", () => {
    expect(doorAfterAnswer("guarded", "unknown")).toBe("guarded");
    expect(doorAfterAnswer("open", "unknown")).toBe("open");
    expect(doorAfterAnswer("unknown", "unknown")).toBe("unknown");
  });

  it("takes the answer when there is one", () => {
    expect(doorAfterAnswer("guarded", "open")).toBe("open");
    expect(doorAfterAnswer("open", "guarded")).toBe("guarded");
  });
});

describe("with an unknown door", () => {
  it("grants nothing, and draws nothing", () => {
    expect(principalOf("unknown", null)).toBeNull();
    expect(showsBoard("unknown", null)).toBe(false);
  });
});
