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
    expect(refusal).toContain("2.5");
    expect(refusal).toContain(CI_LOG_STREAM_SINCE);
    expect(refusal).toContain("--stream");
    expect(refusal).toContain("odu web --upgrade");
    expect(refusal).toContain(WHERE);
  });

  it("reads a daemon from before `rows` by its one protocol version", () => {
    expect(pushStreamRefusal(daemon("2.4"), WHERE)).not.toBeNull();
  });

  it("allows the daemon this build was written against", () => {
    expect(
      pushStreamRefusal(daemon("2.5", { [CI_ROW]: CI_LOG_STREAM_SINCE }), WHERE),
    ).toBeNull();
  });

  it("allows a daemon NEWER than this build on the runs row", () => {
    expect(pushStreamRefusal(daemon("2.5", { [CI_ROW]: "2.9" }), WHERE)).toBeNull();
  });
});
