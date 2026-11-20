import type { SessionSummary } from "../types";
import { compareSessionEnd, sessionRowKey } from "./session-rows";

export type HistoryRow = SessionSummary & { machine: string };
export interface Cursor {
	endedAt: number;
	file: string;
}
export interface PageState {
	cursor: Cursor | null;
	exhausted: boolean;
}
export interface HistoryState {
	rows: Map<string, HistoryRow>;
	pages: Record<string, PageState>;
}

export function historyName(row: SessionSummary): string {
	return (
		row.title?.trim() ||
		row.firstMessage?.trim() ||
		row.file
			.split("/")
			.pop()
			?.replace(/\.jsonl(?:\.gz)?$/, "") ||
		row.file
	);
}
export function indexHistorySessions(rows: Iterable<HistoryRow>): Map<string, HistoryRow> {
	const index = new Map<string, HistoryRow>();
	for (const row of rows) if (row.sessionId) index.set(`${row.machine}:${row.sessionId}`, row);
	return index;
}
export function compareRows(a: HistoryRow, b: HistoryRow): number {
	return compareSessionEnd(a, b) || a.file.localeCompare(b.file);
}
export function upsertPage(
	state: HistoryState,
	machine: string,
	page: SessionSummary[],
	limit: number,
	first = false,
): HistoryState {
	const rows = new Map(state.rows);
	let added = 0;
	for (const row of page) {
		const value = { ...row, machine };
		const key = sessionRowKey(value);
		if (!rows.has(key)) added++;
		rows.set(key, value);
	}
	const last = page.at(-1);
	const previous = state.pages[machine];
	const cursor = last ? { endedAt: last.endedAt, file: last.file } : null;
	return {
		rows,
		pages: {
			...state.pages,
			[machine]:
				first && previous ? previous : { cursor, exhausted: page.length < limit || (!first && added === 0) },
		},
	};
}
export function horizonMachines(pages: Record<string, PageState>, reachable: Set<string>): string[] {
	const candidates = Object.entries(pages).filter(([id, page]) => reachable.has(id) && !page.exhausted && page.cursor);
	if (!candidates.length) return [];
	const newest = Math.max(...candidates.map(([, page]) => page.cursor!.endedAt));
	return candidates.filter(([, page]) => page.cursor!.endedAt === newest).map(([id]) => id);
}
export function visibleHistory(state: HistoryState, reachable: Set<string>): HistoryRow[] {
	if ([...reachable].some(machine => !state.pages[machine])) return [];
	const horizon = horizonMachines(state.pages, reachable);
	const cutoff = horizon.length ? state.pages[horizon[0]].cursor!.endedAt : -Infinity;
	return [...state.rows.values()].filter(row => row.endedAt >= cutoff).sort(compareRows);
}
export function isRunning(row: HistoryRow, live: ReadonlySet<string>): boolean {
	return !!row.sessionId && live.has(`${row.machine}:${row.sessionId}`);
}

export type HistoryStatusLabel = "Running" | "Ended" | "Missing file" | "Status unavailable";

export interface HistoryStatus {
	label: HistoryStatusLabel;
	/** What the cell shows: "—" when live status is unavailable, else the label. */
	text: string;
	tone: "ok" | "warn" | "neutral";
	live: boolean;
	title?: string;
}

/**
 * A row's status. Running and Ended come only from the hub's fresh live list for the row's machine; without it the
 * row shows a quiet "—" ("Status unavailable" in the filter), never a guess from the transcript.
 */
export function historyStatus(
	row: HistoryRow,
	live: ReadonlySet<string>,
	liveKnown: boolean,
	machineName: string,
): HistoryStatus {
	if (row.missing) return { label: "Missing file", text: "Missing file", tone: "warn", live: false };
	if (!liveKnown)
		return {
			label: "Status unavailable",
			text: "—",
			tone: "neutral",
			live: false,
			title: `Live status unavailable for ${machineName}`,
		};
	return isRunning(row, live)
		? { label: "Running", text: "Running", tone: "ok", live: true }
		: { label: "Ended", text: "Ended", tone: "neutral", live: false };
}

/** "just now", "59m ago", "10h ago", "3d ago"; a week or more: "18 Nov". Fits a narrow Started column. */
export function compactAge(timestamp: number, now = Date.now()): string {
	const minutes = Math.floor((now - timestamp) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
	if (minutes < 7 * 1440) return `${Math.floor(minutes / 1440)}d ago`;
	return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Karachi" }).format(
		new Date(timestamp),
	);
}

/** "1 subagent", "3 subagents". */
export function subagentCount(count: number): string {
	return `${count} subagent${count === 1 ? "" : "s"}`;
}

/** "1 session", "3 sessions". */
function sessionCount(count: number): string {
	return `${count} session${count === 1 ? "" : "s"}`;
}

/**
 * The Old sessions table's subtitle. Only rows from machines that answered just now count as sessions; rows kept from
 * a machine that failed or is held are "last known", named by machine. "select a row for details" only when there is
 * a row to select.
 */
export function historySubtitle(state: {
	loading: boolean;
	/** Every row shown, fresh and last known. */
	rows: number;
	/** Shown rows from machines that didn't answer just now (failed or held), and those machines' names. */
	lastKnown: { rows: number; machines: readonly string[] };
	/** Under All machines: machines that answered, were held (last known) and failed. */
	fleet: { answered: number; held: number; failed: number; total: number } | null;
	/** One machine picked and its request failed. */
	failedMachine: string | null;
}): string {
	const select = state.rows > 0 ? " · select a row for details" : "";
	if (state.loading) return "Loading sessions…";
	const cached = state.lastKnown.rows;
	const cachedFrom = cached > 0 ? `${cached} last known from ${state.lastKnown.machines.join(", ")}` : null;
	if (state.failedMachine) {
		if (state.rows === 0) return `Sessions unavailable · ${state.failedMachine} didn't answer`;
		return `${state.rows} last known · ${state.failedMachine} didn't answer${select}`;
	}
	const fleet = state.fleet;
	const fresh = state.rows - cached;
	if (!fleet || (fleet.failed === 0 && fleet.held === 0 && cached === 0))
		return `${sessionCount(state.rows)}${select}`;
	if (fleet.answered === 0 && state.rows === 0 && fleet.held === 0)
		return "Sessions unavailable · no machine answered";
	return [
		fleet.answered === 0
			? "No machine answered just now"
			: `${sessionCount(fresh)} from ${fleet.answered} of ${fleet.total} machines`,
		cachedFrom,
		fleet.failed > 0 ? `${fleet.failed} didn't answer` : null,
	]
		.filter(Boolean)
		.join(" · ")
		.concat(select);
}
