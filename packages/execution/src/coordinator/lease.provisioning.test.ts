import { describe, expect, it } from "bun:test";
import { copyProgress } from "./lease";
import { withTimeout } from "../common/withTimeout";

const COPY_LINE = (path: string): string =>
  `kolu-ci-5: copying path '${path}' to 'ssh-ng://kolu-ci-5'...`;

describe("copyProgress", () => {
  it("says nothing when no copy was ever observed", () => {
    const p = copyProgress();
    p.observe("kolu-ci-5: connecting");
    expect(p.note()).toBe("");
  });

  it("counts store paths and names the last one, stripped of its hash", () => {
    const p = copyProgress();
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    p.observe(COPY_LINE("/nix/store/bbbb-python3-3.14.6"));
    const note = p.note();
    expect(note).toContain("still copying the runner closure");
    expect(note).toContain("2 store paths");
    expect(note).toContain("python3-3.14.6");
    expect(note).not.toContain("bbbb");
  });

  it("keeps the singular for one path", () => {
    const p = copyProgress();
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    expect(p.note()).toContain("1 store path so far");
  });

  it("counts a path once however many times it is narrated", () => {
    const p = copyProgress();
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    expect(p.note()).toContain("1 store path so far");
    expect(p.note()).toContain("git-2.55.0-doc");
  });
});

describe("withTimeout", () => {
  it("fires on an absolute bound when nothing reports progress", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 20, "lease pin kolu-ci-5"),
    ).rejects.toThrow("odu: lease pin kolu-ci-5 timed out after 20ms");
  });

  it("appends the note so the refusal says what it was waiting on", async () => {
    const p = copyProgress();
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    await expect(
      withTimeout(new Promise(() => {}), 20, "lease pin kolu-ci-5", {
        note: p.note,
      }),
    ).rejects.toThrow("still copying the runner closure");
  });

  it("does not fire while progress keeps arriving, and fires once it stops", async () => {
    let bump = (): void => {};
    const ticker = setInterval(() => bump(), 15);
    const started = Date.now();
    const pending = withTimeout(
      new Promise(() => {}),
      40,
      "lease pin kolu-ci-5",
      {
        heartbeat: (b) => {
          bump = b;
        },
      },
    );
    setTimeout(() => clearInterval(ticker), 60);
    await expect(pending).rejects.toThrow("timed out after 40ms without progress");
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it("fires the absolute ceiling on a peer that narrates but never finishes", async () => {
    let bump = (): void => {};
    const ticker = setInterval(() => bump(), 5);
    const started = Date.now();
    const pending = withTimeout(
      new Promise(() => {}),
      30,
      "lease pin kolu-ci-5",
      {
        heartbeat: (b) => {
          bump = b;
        },
        ceilingMs: 60,
      },
    );
    try {
      await expect(pending).rejects.toThrow(
        "timed out after 60ms (absolute ceiling",
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    } finally {
      clearInterval(ticker);
    }
  });

  it("lets the idle bound fire first when the peer goes silent", async () => {
    const p = copyProgress();
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    await expect(
      withTimeout(new Promise(() => {}), 20, "lease pin kolu-ci-5", {
        heartbeat: () => {},
        note: p.note,
        ceilingMs: 10_000,
      }),
    ).rejects.toThrow("timed out after 20ms without progress");
  });

  it("does not fire the ceiling on a call that settles in time", async () => {
    await expect(
      withTimeout(Promise.resolve("pinned"), 50, "lease pin kolu-ci-5", {
        heartbeat: () => {},
        ceilingMs: 20,
      }),
    ).resolves.toBe("pinned");
  });

  it("stops bumping once the call settles", async () => {
    let bump = (): void => {};
    await withTimeout(Promise.resolve("pinned"), 50, "lease pin kolu-ci-5", {
      heartbeat: (b) => {
        bump = b;
      },
    });
    expect(() => bump()).not.toThrow();
  });
});
