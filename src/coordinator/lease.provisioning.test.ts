/**
 * The two halves of "provisioning a cold host is legible" that live on the
 * lease seam (juspay/odu#84):
 *
 *   - {@link copyProgress} reads `nix`'s own `copying path …` narration, which
 *     is the only progress signal this seam gets;
 *   - {@link withTimeout}'s heartbeat turns the pin bound from "finish within
 *     `ms`" into "go quiet for `ms`", so a box that is visibly receiving a few
 *     hundred megabytes of closure is not killed for being slow.
 *
 * Both are tested here rather than through `tryClaim`, which needs a real ssh
 * session to reach them at all.
 */

import { describe, expect, it } from "bun:test";
import { copyProgress, withTimeout } from "./lease";

const COPY_LINE = (path: string): string =>
  `kolu-ci-5: copying path '${path}' to 'ssh-ng://kolu-ci-5'...`;

describe("copyProgress", () => {
  it("says nothing when no copy was ever observed", () => {
    const p = copyProgress();
    p.observe("kolu-ci-5: connecting");
    // An unreachable machine must not be reported as one that was mid-copy —
    // that is the misdiagnosis in the other direction.
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
    // The store hash is noise in an error message; the name is the diagnosis.
    expect(note).not.toContain("bbbb");
  });

  it("keeps the singular for one path", () => {
    const p = copyProgress();
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    expect(p.note()).toContain("1 store path so far");
  });

  it("counts a path once however many times it is narrated", () => {
    // Provisioning copies each path twice on a cold host — once pulling it into
    // the local store, once shipping it to the remote. Counting narration lines
    // would report a 300-path closure as 600, which no `nix path-info` can
    // reconcile.
    const p = copyProgress();
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    p.observe(COPY_LINE("/nix/store/aaaa-git-2.55.0-doc"));
    expect(p.note()).toContain("1 store path so far");
    // A repeat still updates "last" — it is where the copy actually is.
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
    // Four bumps at 15ms across a 40ms idle bound: total elapsed (~60ms) is well
    // past the bound, so an absolute deadline would have fired. Then the
    // heartbeat stops and the same bound must still catch the silence.
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
    // The hole the idle bound alone leaves: `@kolu/surface-remote`'s
    // pre-connected backstop expires into `forceCycle`, which RETRIES and
    // announces the retry through `localProgress` — a progress line that re-arms
    // the idle bound. A host stuck in that loop would keep the pin outstanding
    // forever. The ceiling is the one bound a bump cannot move.
    let bump = (): void => {};
    const ticker = setInterval(() => bump(), 5);
    const started = Date.now();
    const pending = withTimeout(
      new Promise(() => {}),
      30, // idle bound — perpetually re-armed by the ticker
      "lease pin kolu-ci-5",
      {
        heartbeat: (b) => {
          bump = b;
        },
        ceilingMs: 60,
      },
    );
    try {
      // The message must say WHICH bound fired: a ceiling expiry is a host that
      // was alive the whole time, which is a different diagnosis from silence.
      await expect(pending).rejects.toThrow(
        "timed out after 60ms (absolute ceiling",
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    } finally {
      clearInterval(ticker);
    }
  });

  it("lets the idle bound fire first when the peer goes silent", async () => {
    // The ceiling is a backstop, never the working deadline: a genuinely silent
    // session must still be diagnosed as silence, with its copy note attached.
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
    // A late bump on a settled call must not re-arm a timer that then rejects
    // into nothing — the promise is already resolved and nobody is listening.
    expect(() => bump()).not.toThrow();
  });
});
