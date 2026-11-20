import { machinePath } from "../app/machine";
import { rangeMeta } from "./range";
import { withTimeout } from "./session-capabilities";
import { SUBAGENTS_TIMEOUT_MS } from "./session-subagents";
import type { TimeRange } from "../types";

export interface HistorySubagent {
	id: string;
	agent: string | null;
	title: string | null;
	models: string[];
	startedAt: number | null;
	endedAt: number | null;
	durationMs: number | null;
	costTotal: number;
	requests: number;
	status: "done" | "running" | "cut_off" | "unknown";
	toolErrors: number;
}

export function historyAfter(range: TimeRange, now = Date.now()): number | undefined {
	const span = rangeMeta(range).spanMs;
	return span === null ? undefined : now - span;
}

/** A row's subagents from its own machine; gives up after {@link SUBAGENTS_TIMEOUT_MS} with an error. */
export function getHistorySubagents(
	file: string,
	machine: string | undefined,
	parentLive: boolean,
	signal?: AbortSignal,
): Promise<HistorySubagent[]> {
	return withTimeout(
		SUBAGENTS_TIMEOUT_MS,
		signal,
		timed => readHistorySubagents(file, machine, parentLive, timed),
		"the machine",
	);
}

async function readHistorySubagents(
	file: string,
	machine: string | undefined,
	parentLive: boolean,
	signal: AbortSignal,
): Promise<HistorySubagent[]> {
	const params = new URLSearchParams({ file });
	if (parentLive) params.set("parentLive", "1");
	const response = await fetch(`${machinePath("/api/session/subagents", machine)}?${params}`, { signal });
	if (!response.ok) {
		let message = `Request failed (${response.status})`;
		try {
			const body = (await response.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			/* HTTP status is sufficient. */
		}
		throw new Error(message);
	}
	return response.json() as Promise<HistorySubagent[]>;
}
