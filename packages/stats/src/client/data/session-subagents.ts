/**
 * Subagents of a live session: find its transcript in the machine's stats (by session id), then ask that machine
 * for the child rollups. `parentLive=1` only when the hub listed the session as live in a fresh (not stale) reply.
 */
import { ApiError, getSessions } from "../api";
import { machinePrefix } from "../app/machine";
import { namedStatsReason } from "../app/stats-reasons";
import type { HubSession } from "./hub";
import { withTimeout } from "./session-capabilities";

export type SubagentStatus = "done" | "running" | "cut_off" | "unknown";

export interface SessionSubagent {
	id: string;
	agent: string | null;
	title: string | null;
	models: string[];
	startedAt: number;
	endedAt: number;
	durationMs: number;
	costTotal: number;
	requests: number;
	status: SubagentStatus;
	toolErrors: number;
}

/** The stats rows searched start an hour before the session, like the hub's live-cost join. */
const LOOKBACK_MS = 3_600_000;

export async function findTranscript(session: HubSession, signal?: AbortSignal): Promise<string | null> {
	if (!session.sessionId) return null;
	const after = typeof session.startedAt === "number" ? Math.max(0, session.startedAt - LOOKBACK_MS) : undefined;
	const rows = await getSessions(200, undefined, signal, session.machine, after !== undefined ? { after } : undefined);
	return rows.find(row => row.sessionId === session.sessionId)?.file ?? null;
}

export function subagentsUrl(file: string, machine: string | undefined, parentLive: boolean): string {
	const params = new URLSearchParams({ file });
	if (parentLive) params.set("parentLive", "1");
	return `${machinePrefix(machine)}/api/session/subagents?${params}`;
}

/** How long a subagent list (transcript lookup included) may take before the expander shows an error with Try again. */
export const SUBAGENTS_TIMEOUT_MS = 10_000;

/**
 * "Could not list the subagents: Ada MacBook's stats didn't answer in time." The raw reason goes in a tooltip.
 * `refreshing`: the list asks again by itself (the Sessions expander, a running session in Old sessions), so the
 * clock and busy phrases may say "retrying"; otherwise only Try again asks again, and they don't.
 */
export function subagentsFailure(machineName: string, raw: string, refreshing: boolean): string {
	return `Could not list the subagents: ${namedStatsReason(machineName, raw, { refreshing })}.`;
}

/** The expander's line for a session whose machine is unreachable: nothing is fetched. */
export function subagentsUnavailable(machineName: string): string {
	return `${machineName} unreachable; subagents unavailable`;
}

export function getSessionSubagents(
	session: HubSession,
	parentLive: boolean,
	signal?: AbortSignal,
): Promise<SessionSubagent[] | null> {
	return withTimeout(
		SUBAGENTS_TIMEOUT_MS,
		signal,
		timed => readSessionSubagents(session, parentLive, timed),
		"the machine",
	);
}

async function readSessionSubagents(
	session: HubSession,
	parentLive: boolean,
	signal: AbortSignal,
): Promise<SessionSubagent[] | null> {
	const file = await findTranscript(session, signal);
	if (!file) return null;
	const url = subagentsUrl(file, session.machine, parentLive);
	const res = await fetch(url, { signal });
	const body = (await res.json().catch(() => null)) as unknown;
	if (!res.ok) {
		const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
		throw new ApiError(res.status, url, typeof error === "string" ? error : `HTTP error ${res.status}`);
	}
	if (!Array.isArray(body)) throw new Error("The subagent list was not the expected shape.");
	return body as SessionSubagent[];
}

export const SUBAGENT_STATUS: Record<SubagentStatus, { label: string; tone: "ok" | "warn" | "neutral" | "error" }> = {
	done: { label: "Done", tone: "ok" },
	running: { label: "Running", tone: "warn" },
	cut_off: { label: "Cut off", tone: "error" },
	unknown: { label: "Unknown", tone: "neutral" },
};
