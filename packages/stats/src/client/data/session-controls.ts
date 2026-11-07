/**
 * Which Sessions-page controls a session offers, and why one is off. Mirrors the hub's own rules
 * (the hub's control module), which decide in the end.
 */
import type { HubSession } from "./hub";

export const RESTART_FOR_CONTROLS =
	"Restart this session to enable Stop and Rename: sessions started before the controls were installed don't have them.";

export interface ControlState {
	enabled: boolean;
	/** Why it is off (shown as the button's tooltip and under it). */
	reason: string | null;
}

export interface SessionControls {
	/** Stop is only shown while a turn runs. */
	showStop: boolean;
	stop: ControlState;
	rename: ControlState;
	kill: ControlState;
}

const on: ControlState = { enabled: true, reason: null };

export function projectName(s: HubSession): string {
	return (s.cwd ?? "").split("/").pop() ?? "";
}

export function sessionDisplayName(s: HubSession): string {
	return s.sessionName || projectName(s) || "omp session";
}

export function sessionControls(s: HubSession): SessionControls {
	const noId: ControlState = { enabled: false, reason: "omp did not report this session's id" };
	const extension: ControlState = !s.sessionId
		? noId
		: s.control
			? on
			: { enabled: false, reason: RESTART_FOR_CONTROLS };
	return {
		showStop: s.busy === true,
		stop: extension,
		rename: extension,
		kill: !s.sessionId
			? noId
			: typeof s.pid === "number"
				? on
				: { enabled: false, reason: "omp did not report this session's process" },
	};
}

/** The Kill confirmation the hub accepts: the session's exact name, or its project folder's name. */
export function killConfirmMatches(s: HubSession, typed: string): boolean {
	const value = typed.trim();
	if (!value) return false;
	return value === (s.sessionName ?? "").trim() || value === projectName(s);
}

/** "in herdr: sms › omp", or null when herdr doesn't know the session. */
export function herdrPlace(s: HubSession): string | null {
	const ws = s.herdr?.workspace;
	if (!ws) return null;
	return s.herdr?.tab ? `in herdr: ${ws} › ${s.herdr.tab}` : `in herdr: ${ws}`;
}

export const MAX_NAME_CHARS = 120;

/** Why the hub would refuse this name (same rule as the omp-hub-control extension), or null. */
export function nameProblem(raw: string): string | null {
	const name = raw.replace(/ +/g, " ").trim();
	const chars = [...name].length;
	if (chars < 1 || chars > MAX_NAME_CHARS) return `Use 1–${MAX_NAME_CHARS} characters.`;
	if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u.test(name)) {
		return "Remove control or invisible characters (such as text-direction marks).";
	}
	return null;
}
