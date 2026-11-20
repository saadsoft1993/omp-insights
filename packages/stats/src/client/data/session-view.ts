/** How the live-sessions table reads a hub session row (pure, so it is tested without a DOM). */
import type { HubSession, HubSessionsMachine, HubTerminalReason } from "./hub";
import { needsYou, terminalWaiting } from "./plan-review";

export type SessionTone = "neutral" | "ok" | "warn" | "error";
/** The row's lead dot also has the accent colour, for Working. */
export type SessionDotTone = SessionTone | "accent";

export interface SessionStatus {
	label: string;
	tone: SessionTone;
	dot: SessionDotTone;
	/** A pulsing dot: the state is live (working, needs you). */
	live: boolean;
}

/** Last known, waiting on login, needs you, working (also while its subagents run), idle, unknown. */
export function sessionStatus(s: HubSession): SessionStatus {
	if (s.stale) return { label: "Last known", tone: "neutral", dot: "neutral", live: false };
	if (terminalWaiting(s)?.kind === "oauth")
		return { label: "Waiting on login", tone: "warn", dot: "warn", live: true };
	if (needsYou(s)) return { label: "Needs you", tone: "warn", dot: "warn", live: true };
	if (s.busy === true || (s.agentsRunning ?? 0) > 0)
		return { label: "Working", tone: "neutral", dot: "accent", live: true };
	if (s.busy === false) return { label: "Idle", tone: "ok", dot: "ok", live: false };
	return { label: "Unknown", tone: "neutral", dot: "neutral", live: false };
}

export function isWorking(s: HubSession): boolean {
	return !s.stale && (s.busy === true || (s.agentsRunning ?? 0) > 0);
}

/** What `#/sessions/<id>` names: omp's session id (the one alerts carry), else the Collab instance. */
export function sessionKey(s: HubSession): string {
	return s.sessionId ?? s.instanceId;
}

/** Rows are unique per machine and instance. */
export function rowKey(s: HubSession): string {
	return `${s.machine ?? ""}:${s.instanceId}`;
}

export function projectFolder(s: HubSession): string {
	return (s.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
}

/** "Opus 5.5" for `claude-opus-5-5`, "GPT 6.1 Sol" for `gpt-6.1-sol`. */
export function shortModelName(id: string | null | undefined): string {
	if (!id) return "Unknown";
	const parts = id.replace(/^claude-/, "").split("-");
	const words: string[] = [];
	const numbers: string[] = [];
	const flush = () => {
		if (numbers.length) words.push(numbers.splice(0).join("."));
	};
	for (const part of parts) {
		if (/^\d+(\.\d+)?$/.test(part)) {
			numbers.push(part);
			continue;
		}
		flush();
		words.push(part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1));
	}
	flush();
	return words.join(" ");
}

const PROVIDER_COLOR: Record<string, string> = {
	anthropic: "#ff7a59",
	openai: "#4ade80",
	"openai-codex": "#4ade80",
	google: "#5b8cff",
	gemini: "#5b8cff",
};

export function providerColor(provider: string | null | undefined): string {
	return PROVIDER_COLOR[provider ?? ""] ?? "#6c6c74";
}

/** Matches name, folder, workspace, machine and model, case-insensitively. */
export function matchesFilter(s: HubSession, query: string, machineName: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return [s.sessionName, s.cwd, s.workspace, machineName, s.model?.id, s.herdr?.tab, s.herdr?.workspace]
		.filter(Boolean)
		.some(value => String(value).toLowerCase().includes(q));
}

/** "1 needs you · 3 working · 2 idle" over the rows shown. */
export function countsLine(rows: readonly HubSession[]): string {
	const needs = rows.filter(s => !s.stale && needsYou(s)).length;
	const working = rows.filter(s => !needsYou(s) && isWorking(s)).length;
	const idle = rows.filter(s => !s.stale && !needsYou(s) && !isWorking(s)).length;
	const stale = rows.filter(s => s.stale).length;
	return [
		needs ? `${needs} need${needs === 1 ? "s" : ""} you` : null,
		`${working} working`,
		`${idle} idle`,
		stale ? `${stale} last known` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * The machine a row's controls are off for, or null when they stay on. Reachability is the machine's own `ok`: a
 * machine the hub holds through its grace period (`ok` with `stale` rows) keeps its controls, and only its data is
 * marked last known. Stale rows with no machine report (an older hub) count as unreachable.
 */
export function machineDown(
	s: HubSession,
	machines: readonly HubSessionsMachine[] | undefined,
): HubSessionsMachine | null {
	const m = machines?.find(item => item.id === s.machine);
	if (m) return m.ok ? null : m;
	return s.stale ? { id: s.machine ?? "", name: s.machine ?? "This machine", ok: false } : null;
}

/** The hub holds the machine through its grace period: reachable, but its rows are the last known state. */
export function machineHeld(s: HubSession, machines: readonly HubSessionsMachine[] | undefined): boolean {
	const m = machines?.find(item => item.id === s.machine);
	return m !== undefined && m.ok && (m.stale === true || s.stale === true);
}

/** The hub's own reason the terminal can't be read (`terminal.reason`). */
const TERMINAL_REASON: Record<HubTerminalReason, (machineName: string) => string> = {
	not_scanned_yet: m => `${m}'s hub hasn't listed herdr panes yet; it checks every 15 seconds.`,
	scan_failed: m => `herdr on ${m} didn't answer the hub's last check.`,
	scan_stale: m => `${m}'s hub's last herdr check is over 45 seconds old.`,
	ambiguous_panes: () => "More than one herdr pane shows this session.",
	not_in_herdr: m => `${m}'s hub hasn't matched this session to a herdr pane yet; it checks every 15 seconds.`,
};

/** The Terminal tab's state: open, or why the hub can't read this session's terminal right now. */
export function terminalAccess(
	s: HubSession,
	machineName: string,
): { on: true; reason: null } | { on: false; reason: string } {
	if (!s.sessionId)
		return { on: false, reason: "This session has not reported its id yet, so its terminal can't be matched." };
	const t = s.terminal;
	if (!t)
		return {
			on: false,
			reason: `${machineName}'s hub doesn't report terminals; update the hub there to use this tab.`,
		};
	if (t.available) return { on: true, reason: null };
	const exact = t.reason ? TERMINAL_REASON[t.reason]?.(machineName) : undefined;
	if (exact) return { on: false, reason: exact };
	// An older hub sends no reason: word it from `unknown` alone.
	if (t.unknown)
		return {
			on: false,
			reason: `${machineName}'s hub can't tell which herdr pane runs this session right now (herdr didn't answer, or more than one pane shows it). It looks again every 15 seconds.`,
		};
	// Only "the last scan didn't list it": not proof that the session runs outside herdr.
	return {
		on: false,
		reason: `${machineName}'s hub hasn't matched this session to a herdr pane yet; it checks every 15 seconds.`,
	};
}

/**
 * The live sessions table's subtitle: the counts, then which machines answered just now, which are held (their rows
 * are last known while the hub reconnects) and which didn't answer. "Click a row for its controls." only when a row is
 * shown (`shown`: the rows left after the filter).
 */
export function sessionsSubtitle(
	rows: readonly HubSession[],
	machines: readonly HubSessionsMachine[],
	shown: number = rows.length,
): string {
	const held = machines.filter(m => m.ok && m.stale === true);
	const down = machines.filter(m => !m.ok);
	const answered = machines.length - held.length - down.length;
	let health: string | null = null;
	if (held.length || down.length) {
		if (machines.length === 1)
			health = down.length ? `${machines[0].name} didn't answer` : `${machines[0].name}'s rows are last known`;
		else if (answered === 0 && held.length === 0) health = "no machine answered";
		else
			health = [
				`${answered} of ${machines.length} machines answered`,
				held.length ? `${held.length} last known` : null,
				down.length ? `${down.length} didn't` : null,
			]
				.filter(Boolean)
				.join(" · ");
	}
	return `${[countsLine(rows), health].filter(Boolean).join(" · ")}.${shown ? " Click a row for its controls." : ""}`;
}
