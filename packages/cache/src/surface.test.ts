import { describe, expect, it } from "bun:test";
import { heldReason, holdReason } from "./surface";

describe("why a path is held", () => {
  it("counts the references it was told about", () => {
    expect(heldReason([])).toBe("waiting for 0 references that are neither here nor upstream");
    expect(heldReason(["/nix/store/a"])).toBe(
      "waiting for 1 reference that is neither here nor upstream",
    );
    expect(heldReason(["/nix/store/a", "/nix/store/b"])).toBe(
      "waiting for 2 references that are neither here nor upstream",
    );
    expect(heldReason([], 2)).toBe("fetching 2 upstream references");
  });

  it("names a failed fetch instead of blaming the references", () => {
    expect(
      holdReason({ failure: "network unreachable", missing: ["/nix/store/a"], fetching: 0 }),
    ).toBe(
      "fetching failed: network unreachable — it retries on the next push of this path, or when odu next starts",
    );
    expect(holdReason({ failure: null, missing: ["/nix/store/a"], fetching: 1 })).toBe(
      "fetching 1 upstream reference",
    );
  });

  it("says no count when the server did not give one", () => {
    // `null` is a 202 with no body: a number here would be one this module
    // invented, and "1 reference" is exactly the wrong guess.
    expect(heldReason(null)).toBe(
      "waiting for a reference that is neither here nor upstream",
    );
  });
});
