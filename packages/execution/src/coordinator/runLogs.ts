import type { LogStream } from "@odu/run-client/nodeId";
import type { RunHistory } from "./history";
import type { NodeLogSink } from "./nodeLogSink";

export interface NodeLog {
  append(text: string, stream?: LogStream): void;
  reset(text: string, stream?: LogStream): void;
  end(stream?: LogStream): void;
  seal(): void;
  truncate(cause: string): void;
  isEnded(stream?: LogStream): boolean;
}

export interface RunLogs {
  of(id: string): NodeLog;
  place(id: string, host: string | null): void;
  hostOf(id: string): string | null;
  claim(ids: Iterable<string>): void;
  sealAll(ids: Iterable<string>): void;
  isNoopReset(id: string, text: string, stream?: LogStream): boolean;
  streamSource: NodeLogSink["streamSource"];
}

export function createRunLogs(
  sink: NodeLogSink,
  history: RunHistory,
): RunLogs {
  const hosts = new Map<string, string>();

  const of = (id: string): NodeLog => {
    const end = (stream: LogStream = "recipe"): void => {
      sink.end(id, stream);
      if (stream === "recipe") history.logFinalized(id, true, null);
    };
    const append = (text: string, stream: LogStream = "recipe"): void => {
      if (sink.isEnded(id, stream)) return;
      sink.append(id, text, stream);
      history.log(id, text, hosts.get(id) ?? null, stream);
    };
    return {
      append,
      reset: (text, stream = "recipe") => {
        sink.reset(id, text, stream);
        history.replaceLog(id, text, hosts.get(id) ?? null, stream);
      },
      end,
      seal: () => {
        end();
        end("push");
      },
      truncate: (cause) => {
        append(
          `\n[odu] log truncated: ${cause} with this node's output still owed` +
            " — what follows the last line was never received\n",
        );
        history.logFinalized(id, false, cause);
      },
      isEnded: (stream) => sink.isEnded(id, stream),
    };
  };

  return {
    of,
    place: (id, host) => {
      if (host === null) hosts.delete(id);
      else hosts.set(id, host);
    },
    hostOf: (id) => hosts.get(id) ?? null,
    claim: (ids) => {
      for (const id of ids) sink.claim(id);
    },
    sealAll: (ids) => {
      for (const id of ids) of(id).seal();
    },
    isNoopReset: sink.isNoopReset,
    streamSource: sink.streamSource,
  };
}
