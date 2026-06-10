/**
 * In-band introspection of a live run — `odu status` / `logs` / `attach`
 * attach to the coordinator's fan-in surface on `.ci/odu.sock`. The same
 * three primitives every face speaks: one snapshot of the `nodes` cell, a
 * log stream with snapshot-then-append replay, the dashboard with `r`erun.
 */

import {
	type NodeLogFrame,
	type NodeState,
	type PipelineState,
	type RunHeader,
	STATUS_META,
} from "../common/surface";
import {
	createDisplay,
	progressEvent,
	renderRunFrame,
} from "../coordinator/display";
import { dialSocket, type OduClient } from "../coordinator/socket";
import {
	applyLogFrame,
	defaultAttachId,
	nodeRow,
	renderLogPane,
	statusGlyph,
	summarize,
} from "./render";

export async function firstSnapshot(client: OduClient): Promise<PipelineState> {
	for await (const state of await client.surface.nodes.get({})) {
		return state;
	}
	throw new Error("odu: coordinator closed before sending state");
}

/** The run header off the surface — `run` publishes it before serving, so the
 *  first value is the real lane→host map. The `header` cell always yields its
 *  current value (EMPTY_HEADER until `run` publishes), so an empty stream means
 *  the coordinator closed before sending — a protocol failure we surface
 *  rather than mask with a blank banner (mirrors `firstSnapshot`). */
export async function firstHeader(client: OduClient): Promise<RunHeader> {
	for await (const header of await client.surface.header.get({})) {
		return header;
	}
	throw new Error("odu: coordinator closed before sending header");
}

/** Resolve a node argument against the live state: exact id, or unique
 *  suffix-ish match (`e2e@x86_64-linux` ≡ `ci::e2e@x86_64-linux`). */
export function resolveNodeId(state: PipelineState, token: string): string {
	if (state.nodes[token] !== undefined) return token;
	const matches = state.order.filter(
		(id) =>
			id === token || id.endsWith(`::${token}`) || id.includes(`::${token}@`),
	);
	if (matches.length === 1 && matches[0] !== undefined) return matches[0];
	throw new Error(
		matches.length === 0
			? `odu: no node matches "${token}" (try: ${state.order.join(", ")})`
			: `odu: "${token}" is ambiguous (${matches.join(", ")})`,
	);
}

export async function statusCommand(
	json: boolean,
	socketPath?: string,
): Promise<number> {
	const { client, close } = await dialSocket(socketPath);
	const state = await firstSnapshot(client);
	close();
	if (json) {
		const rows = state.order
			.map((id) => state.nodes[id])
			.filter((n): n is NonNullable<typeof n> => n !== undefined)
			.map(nodeRow);
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
	} else {
		for (const id of state.order) {
			const node = state.nodes[id];
			if (node === undefined) continue;
			// Same word source as run/attach's plain face — STATUS_META's external
			// wording (ok→success, …), padded to 7, so a green node reads `success`
			// in every plain face. The `??` keeps the snapshot-only states whose
			// progress mapping is null (pending) reading as their raw status.
			const word = STATUS_META[node.status].progress ?? node.status;
			process.stdout.write(
				`${statusGlyph(node.status)} ${word.padEnd(7)} ${id}\n`,
			);
		}
	}
	return summarize(state).failedOverall ? 1 : 0;
}

export async function logsCommand(
	token: string,
	follow: boolean,
): Promise<number> {
	const { client, close } = await dialSocket();
	const state = await firstSnapshot(client);
	const id = resolveNodeId(state, token);
	for await (const frame of await client.surface.nodeLog.get({ id })) {
		process.stdout.write(frame.text);
		if (!follow && frame.kind === "snapshot") break;
	}
	close();
	return 0;
}

export async function attachCommand(json: boolean): Promise<number> {
	// The dashboard reads keystrokes (attach / rerun / quit), so it needs a TTY
	// *stdin* — the one deliberate threshold difference from `run`'s output-only
	// live matrix, which keys off stdout alone. The non-interactive fallback is
	// no longer a poor cousin: it shares `run`'s json/plain rendering
	// (juspay/odu#4), so a piped `attach` and a piped `run` emit one contract.
	const interactive =
		!json && process.stdin.isTTY === true && process.stdout.isTTY === true;
	const { client, close } = await dialSocket();
	if (!interactive) return attachStream(client, close, json);
	return attachDashboard(client, close);
}

/** The run header `attach` shows above the transition stream — `run`'s
 *  banner minus the parts only the coordinator owns. An attached observer
 *  knows the pipeline name + commit (from the surface) but not which hosts the
 *  coordinator leased (lanes) nor the forge origin (commitUrl), so it leaves
 *  those empty and the banner collapses to `odu · <pipeline> @ <sha>`. */
function attachHeader(state: PipelineState): RunHeader {
	return {
		pipeline: state.name,
		sha7: state.sha7,
		dirty: state.dirty,
		commitUrl: null,
		lanes: [],
		hostsSource: null,
	};
}

/** Non-tty / `-o json`: one line per node transition — the attach analogue
 *  of `--progress json`. Routes through `run`'s own `createDisplay`, building
 *  each event with the shared `progressEvent`, so the json shape (with
 *  `recipe`/`platform`/`log`), the plain line format, and the 60s heartbeat
 *  are byte-identical to `run` rather than a drifted re-implementation. */
export async function attachStream(
	client: OduClient,
	close: () => void,
	json: boolean,
): Promise<number> {
	const display = createDisplay(json ? "json" : "plain");
	const seen = new Map<string, NodeState["status"]>();
	let last: PipelineState | undefined;
	let started = false;
	for await (const state of await client.surface.nodes.get({})) {
		last = state;
		if (!started) {
			started = true;
			display.start(attachHeader(state));
		}
		display.update(state); // drives the plain heartbeat
		for (const id of state.order) {
			const node = state.nodes[id];
			if (node === undefined || seen.get(id) === node.status) continue;
			seen.set(id, node.status);
			const event = progressEvent(state.sha7, id, node);
			if (event !== null) display.transition(event, node);
		}
		if (summarize(state).done) break;
	}
	display.stop(last);
	close();
	return last !== undefined && summarize(last).failedOverall ? 1 : 0;
}

/** Interactive view — `run`'s recipe × platform matrix with the focused node's
 *  log pane below it. The header (lane→host map) comes off the surface, so this
 *  paints the *same* matrix `run` does, not a separate table. Keys: digits / n /
 *  p move focus, r rerun (the one mutation), q quit. */
async function attachDashboard(
	client: OduClient,
	close: () => void,
): Promise<number> {
	const header = await firstHeader(client);
	let state: PipelineState | undefined;
	let attachedId: string | undefined;
	let log = "";
	let detachLog: (() => void) | undefined;
	let tick = 0;

	const repaint = (): void => {
		if (state === undefined) return;
		const frame = renderRunFrame({
			state,
			header,
			tick,
			startedAt: runStartedAt(state),
			now: Date.now(),
			columns: process.stdout.columns ?? 100,
			focusedId: attachedId,
		});
		const node = attachedId !== undefined ? state.nodes[attachedId] : undefined;
		process.stdout.write(
			`\x1b[2J\x1b[H${frame}\n${renderLogPane(node, log)}\n` +
				"\n[digits] focus · [n/p] cycle · [r] rerun · [q] quit\n",
		);
	};

	const attachLog = (id: string): (() => void) => {
		const controller = new AbortController();
		void (async () => {
			try {
				for await (const frame of await client.surface.nodeLog.get(
					{ id },
					{ signal: controller.signal },
				)) {
					log = applyLogFrame(log, frame as NodeLogFrame);
					repaint();
				}
			} catch (err) {
				if (controller.signal.aborted) return;
				log += `\n[odu] log stream error: ${(err as Error).message}\n`;
				repaint();
			}
		})();
		return () => controller.abort();
	};

	const attach = (id: string | undefined): void => {
		if (id === undefined || id === attachedId) return;
		attachedId = id;
		log = "";
		detachLog?.();
		detachLog = attachLog(id);
		repaint();
	};

	// Repaint on a timer too (not just on state deltas), so the matrix spinners
	// animate and the elapsed clock ticks between transitions. unref'd + cleared
	// on quit so it never holds the process open.
	const ticker = setInterval(() => {
		tick += 1;
		repaint();
	}, 250);
	ticker.unref?.();

	const quit = (code: number): void => {
		clearInterval(ticker);
		detachLog?.();
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
		close();
		process.exit(code);
	};

	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (key: string) => {
		if (key === "q" || key === "\x03" || key === "\x04") return quit(0);
		if (key === "r" && attachedId !== undefined) {
			void client.surface.node.rerun({ id: attachedId });
			return;
		}
		if (state === undefined) return;
		if (key === "n" || key === "p") {
			const idx =
				attachedId !== undefined ? state.order.indexOf(attachedId) : -1;
			const delta = key === "n" ? 1 : -1;
			attach(
				state.order[(idx + delta + state.order.length) % state.order.length],
			);
			return;
		}
		if (key >= "1" && key <= "9") {
			const next = state.order[Number(key) - 1];
			if (next !== undefined) attach(next);
		}
	});

	let first = true;
	for await (const next of await client.surface.nodes.get({})) {
		if (first) {
			first = false;
			attach(defaultAttachId(next));
		}
		state = next;
		repaint();
	}
	quit(state !== undefined && summarize(state).failedOverall ? 1 : 0);
	return 0;
}

/** The run's start wall-clock for the matrix's elapsed timer — the earliest
 *  node start the surface reports, else now (nothing has started yet). `run`
 *  knows this directly; an attached face derives it from the node states. */
function runStartedAt(state: PipelineState): number {
	let earliest = Number.POSITIVE_INFINITY;
	for (const id of state.order) {
		const startedAt = state.nodes[id]?.startedAt;
		if (startedAt !== null && startedAt !== undefined && startedAt < earliest) {
			earliest = startedAt;
		}
	}
	return Number.isFinite(earliest) ? earliest : Date.now();
}
