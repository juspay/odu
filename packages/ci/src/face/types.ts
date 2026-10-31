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
  CheckoutFrame,
  LogPage,
  LogTail,
  NodesFrame,
  NodeStatus,
  Pipeline,
  RunBoardState,
  RunNode,
  RunOutcome,
  RunRow,
  ServiceCell,
  StartReceipt,
  VenueRow,
} from "@odu/service-client/surface";
