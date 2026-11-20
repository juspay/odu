import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type LogStream,
  logPathFor,
  logStreamKey,
} from "@odu/run-client/nodeId";
import { createLogTail, type CreateLogTailResult } from "../common/logTail";

export interface NodeLogSink {
  append: (id: string, text: string, stream?: LogStream) => void;
  reset: (id: string, text: string, stream?: LogStream) => void;
  end: (id: string, stream?: LogStream) => void;
  claim: (id: string, stream?: LogStream) => void;
  isNoopReset: (id: string, text: string, stream?: LogStream) => boolean;
  isEnded: (id: string, stream?: LogStream) => boolean;
  streamSource: CreateLogTailResult["streamSource"];
}

export function createNodeLogSink(repoRoot: string, sha7: string): NodeLogSink {
  const tail = createLogTail();
  const fileFor = (id: string, stream: LogStream): string =>
    join(repoRoot, logPathFor(sha7, id, stream));
  const madeDirs = new Set<string>();
  const openedFiles = new Set<string>();

  const claimLog = (id: string, stream: LogStream): string => {
    const file = fileFor(id, stream);
    const dir = dirname(file);
    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    if (!openedFiles.has(file)) {
      openedFiles.add(file);
      writeFileSync(file, "");
    }
    return file;
  };

  return {
    append: (id, text, stream = "recipe") => {
      tail.append(logStreamKey(id, stream), text);
      appendFileSync(claimLog(id, stream), text);
    },
    reset: (id, text, stream = "recipe") => {
      tail.reset(logStreamKey(id, stream), text);
      writeFileSync(claimLog(id, stream), text);
    },
    end: (id, stream = "recipe") => {
      tail.end(logStreamKey(id, stream));
    },
    claim: (id, stream = "recipe") => {
      claimLog(id, stream);
    },
    isEnded: (id, stream = "recipe") => tail.isEnded(logStreamKey(id, stream)),
    isNoopReset: (id, text, stream = "recipe") =>
      tail.isNoopReset(logStreamKey(id, stream), text),
    streamSource: tail.streamSource,
  };
}

export function appendIfOpen(
  sink: Pick<NodeLogSink, "append" | "isEnded">,
  id: string,
  text: string,
  stream: LogStream = "recipe",
): void {
  if (sink.isEnded(id, stream)) return;
  sink.append(id, text, stream);
}
