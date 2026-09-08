/**
 * The wire's types, named for the browser.
 *
 * A re-export and nothing else. It exists so a view imports one module rather
 * than four, and so the ONE place the browser's vocabulary is joined to the
 * service's is visible — a type this file does not name is a type the browser
 * does not render.
 */

export type {
  AttentionAnswer,
  LogPage,
  LogTail,
  NodesFrame,
  NodeStatus,
  RunBoardState,
  RunNode,
  RunRow,
  ServiceCell,
  StartReceipt,
} from "@odu/service-client/surface";

/** The run outcome, as a bare union. The surface declares it inline on the row
 *  (a nullable literal), so this is the non-null half a total label table is
 *  written against. */
export type RunOutcome = "passed" | "failed" | "incomplete";
