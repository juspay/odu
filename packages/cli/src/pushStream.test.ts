/**
 * `odu ci logs --stream push` AGAINST A DAEMON THAT DOES NOT KNOW THE FLAG.
 *
 * Every other cost of the additive rule announces itself: a verb added since
 * the daemon was built answers "unknown request tag", and the caller reports
 * it. An optional INPUT key has no such answer — a daemon from before it drops
 * the key as an excess property and serves the request it understood. For
 * `log_read` that request is the attempt's RECIPE log, returned under the
 * push's name, with nothing in the page to say which file it came from.
 *
 * So this one is decided BEFORE the call, off what the daemon publishes for
 * the runs row, and these are the four readings that decision rests on. The
 * sentence is asserted for the two versions it has to name and the way out it
 * has to offer — not word for word, which would pin prose nobody promised.
 */

import { describe, expect, it } from "bun:test";
import {
  CI_LOG_STREAM_SINCE,
  CI_ROW,
  type ServiceCell,
  UNKNOWN_SERVICE,
} from "@odu/service-client/surface";
import { pushStreamRefusal } from "./serviceCommands";

const WHERE = "http://127.0.0.1:18440";

function daemon(protocolVersion: string, rows?: Record<string, string>): ServiceCell {
  return {
    ...UNKNOWN_SERVICE,
    identity: {
      ...UNKNOWN_SERVICE.identity,
      protocolVersion,
      ...(rows === undefined ? {} : { rows }),
    },
  };
}

describe("`--stream push` is refused rather than silently answered", () => {
  it("refuses a daemon whose runs row is behind the minor that added `stream`", () => {
    const refusal = pushStreamRefusal(daemon("2.5", { [CI_ROW]: "2.5" }), WHERE);
    expect(refusal).not.toBeNull();
    // BOTH versions, because "upgrade something" is not actionable: the
    // operator has to be able to see which end is old.
    expect(refusal).toContain("2.5");
    expect(refusal).toContain(CI_LOG_STREAM_SINCE);
    // And the two ways out — read the recipe's log, or replace the daemon.
    expect(refusal).toContain("--stream");
    expect(refusal).toContain("odu web --upgrade");
    expect(refusal).toContain(WHERE);
  });

  it("reads a daemon from before `rows` by its one protocol version", () => {
    // Before 2.5 a daemon published a single number for the whole composed
    // wire, so that number IS what it serves the runs at. Treating the absent
    // `rows` as "nothing to compare" would wave through the oldest daemons —
    // exactly the ones that cannot answer this flag.
    expect(pushStreamRefusal(daemon("2.4"), WHERE)).not.toBeNull();
  });

  it("allows the daemon this build was written against", () => {
    expect(
      pushStreamRefusal(daemon("2.5", { [CI_ROW]: CI_LOG_STREAM_SINCE }), WHERE),
    ).toBeNull();
  });

  it("allows a daemon NEWER than this build on the runs row", () => {
    // The skew that matters is one-directional: a daemon ahead of this build
    // has the flag and more, and refusing it would make every upgrade a flag
    // day for the terminal that dialled it.
    expect(pushStreamRefusal(daemon("2.5", { [CI_ROW]: "2.9" }), WHERE)).toBeNull();
  });
});
