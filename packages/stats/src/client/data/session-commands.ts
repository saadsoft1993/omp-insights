/** Rules for the Sessions page's session commands (model, thinking level, mode, compact): pure, so they are tested without a DOM. */
import { ApiError } from "../api";
import type { HubModelRef, HubSessionAdvisor, HubSessionGoal, HubSessionInfo, ModeStatus, SessionCommand } from "./hub";

/** Counted in UTF-16 code units, the same way the plugin counts. */
export const MAX_INSTRUCTIONS_CHARS = 2000;
export const MAX_OBJECTIVE_CHARS = 2000;

export const COMPACTING_TEXT = "Compacting… this can take a few minutes";
export const COMPACT_TIMEOUT_TEXT = "Compaction is taking longer than expected";
export const NO_THINKING_LEVELS = "This model has no thinking levels";
/** Compaction can run up to 3 minutes; the card checks every 10 s and gives up after this many checks. */
/** How often the card re-reads what the session reports while it is on screen. */
export const INFO_REFRESH_MS = 10_000;
export const COMPACT_POLL_MS = 10_000;
export const COMPACT_MAX_POLLS = 30;

export const RESTART_FOR_COMMANDS =
	"Restart this session to use these controls: it still runs an older session-control plugin.";

const CODE_MESSAGES: Record<string, string> = {
	restart_needed: RESTART_FOR_COMMANDS,
	changed: "The session changed while you were looking at it. Check its state, then try again.",
	stale_session: "This session was restarted or replaced. Go back to the list and open it again.",
	invalid: "The session refused that value. Pick again from the list, or shorten the text.",
	socket: "The hub could not reach the session's control plugin. Try again in a moment.",
	busy: "Another change is still running in this session.",
	unsupported: "This version of omp can't do that from here.",
};

/** The message for a failed command: a known code gets its own text; `failed` carries omp's own (short, secret-free) reason. */
export function commandErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "failed") return error.message;
		if (error.code && error.code in CODE_MESSAGES) return CODE_MESSAGES[error.code];
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export function isRestartNeeded(error: unknown): boolean {
	return error instanceof ApiError && error.code === "restart_needed";
}

export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

export function modelLabel(m: HubModelRef): string {
	return m.name ? `${m.name} (${modelKey(m)})` : modelKey(m);
}

/** Why the compact instructions can't be sent, or null. */
export function instructionsProblem(text: string): string | null {
	if (text.length > MAX_INSTRUCTIONS_CHARS)
		return `Instructions can be at most ${MAX_INSTRUCTIONS_CHARS} characters (an emoji counts as 2).`;
	return null;
}

/** Why a goal can't be started with this objective, or null. */
export function objectiveProblem(text: string): string | null {
	if (text.trim() === "") return "Say what the goal is.";
	if (text.length > MAX_OBJECTIVE_CHARS)
		return `The objective can be at most ${MAX_OBJECTIVE_CHARS} characters (an emoji counts as 2).`;
	return null;
}

/** The Compact command: instructions are sent only when there is something to say. */
export function compactCommand(instructions: string): SessionCommand {
	const trimmed = instructions.trim();
	return { op: "compact", args: trimmed ? { instructions: trimmed } : {} };
}

export type ModeCommandArgs = Extract<SessionCommand, { op: "set-mode" }>["args"];

export function modeCommand(
	mode: ModeCommandArgs["mode"],
	action: ModeCommandArgs["action"],
	objective?: string,
): SessionCommand {
	return {
		op: "set-mode",
		args: { mode, action, ...(objective !== undefined ? { objective: objective.trim() } : {}) },
	};
}

/** The confirmation dialog for a command: its title, the question and the confirm button's label. */
export function commandConfirm(
	command: SessionCommand,
	opts?: { resume?: boolean },
): { title: string; question: string; label: string } {
	switch (command.op) {
		case "compact":
			return {
				title: "Compact",
				label: "Compact",
				question: "Compact this session's context now? It summarises the conversation so far and can take a while.",
			};
		case "set-model":
			return {
				title: "Change model",
				label: "Change model",
				question: `Switch this session to ${command.args.provider}/${command.args.id}?`,
			};
		case "set-thinking":
			return {
				title: "Change thinking level",
				label: "Change level",
				question: `Set this session's thinking level to ${command.args.level}?`,
			};
		case "set-advisor":
			if (command.args.enabled === true)
				return {
					title: "Turn on the advisor?",
					question:
						"A second model will review each turn of this session and send extra requests. It stays on until you turn it off or omp restarts.",
					label: "Turn on",
				};
			if (command.args.enabled === false)
				return {
					title: "Turn off the advisor?",
					question: "The advisor stops for this session. New sessions start with it off.",
					label: "Turn off",
				};
			return {
				title: "Change the advisor model?",
				question: `The advisor of this session will use ${command.args.provider}/${command.args.id} until omp restarts.`,
				label: "Change",
			};
		case "set-mode": {
			const { mode, action } = command.args;
			const verb =
				action === "enter" && opts?.resume
					? "Resume"
					: action === "enter"
						? "Enter"
						: action === "exit"
							? "Exit"
							: action[0].toUpperCase() + action.slice(1);
			const noun = mode === "plan" ? "plan mode" : mode === "vibe" ? "vibe mode" : mode;
			return {
				title: `${verb} ${noun}`,
				label: verb,
				question:
					action === "drop"
						? "Drop the current goal? Its progress is discarded."
						: `${verb} ${noun} in this session?`,
			};
		}
	}
}

export function commandDone(command: SessionCommand): string {
	switch (command.op) {
		case "compact":
			return "Compacted.";
		case "set-model":
			return `Model is now ${command.args.provider}/${command.args.id}.`;
		case "set-thinking":
			return `Thinking level is now ${command.args.level}.`;
		case "set-advisor":
			return command.args.enabled === true
				? "Advisor on"
				: command.args.enabled === false
					? "Advisor off"
					: `Advisor model: ${command.args.provider}/${command.args.id}`;
		case "set-mode":
			return `Done: ${commandConfirm(command).title.toLowerCase()}.`;
	}
}

/** The model the session runs, if the list has it (a select can only show a listed value). */
export function currentModelKey(info: HubSessionInfo): string {
	if (!info.model) return "";
	const key = modelKey(info.model);
	return info.models.some(m => modelKey(m) === key) ? key : "";
}

export function advisorSummary(advisor: HubSessionAdvisor): string {
	if (!advisor.enabled) return "Off";
	return `On · ${advisor.model ? modelKey(advisor.model) : "no model"}${advisor.advisors
		.filter(a => a.status !== "running")
		.map(a => ` · ${a.name} ${a.status.replace("_", " ")}`)
		.join("")}`;
}

function parseAdvisor(raw: unknown): HubSessionAdvisor | null {
	if (typeof raw !== "object" || raw === null) return null;
	const a = raw as Record<string, unknown>;
	if (typeof a.enabled !== "boolean" || typeof a.active !== "boolean" || !Array.isArray(a.advisors)) return null;
	const model = a.model as Record<string, unknown> | null;
	const validModel =
		model && typeof model === "object" && typeof model.provider === "string" && typeof model.id === "string"
			? { provider: model.provider, id: model.id }
			: null;
	const advisors: HubSessionAdvisor["advisors"] = [];
	for (const entry of a.advisors) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.name !== "string" ||
			!["running", "paused", "quota_exhausted", "error", "no_model"].includes(entry.status)
		)
			return null;
		advisors.push({ name: entry.name, status: entry.status });
	}
	return { enabled: a.enabled, active: a.active, model: validModel, advisors };
}

/** The plugin's answer, or null when it is not the shape the page relies on (an older hub or a wrong reply). */
export function parseSessionInfo(raw: unknown): HubSessionInfo | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Partial<HubSessionInfo>;
	const status = (v: unknown, fallback: boolean): ModeStatus =>
		v === "active" || v === "paused" || v === "inactive" ? v : fallback ? "active" : "inactive";
	const given = (typeof r.modeStatus === "object" && r.modeStatus !== null ? r.modeStatus : {}) as Record<
		string,
		unknown
	>;
	if (!Array.isArray(r.models) || !Array.isArray(r.thinkingLevels)) return null;
	if (typeof r.mode !== "object" || r.mode === null) return null;
	return {
		model: r.model ?? null,
		thinkingLevel: r.thinkingLevel ?? null,
		thinkingLevels: r.thinkingLevels,
		models: r.models,
		advisor: parseAdvisor(r.advisor),
		mode: { plan: !!r.mode.plan, goal: !!r.mode.goal, loop: !!r.mode.loop, vibe: !!r.mode.vibe },
		modeStatus: {
			plan: status(given.plan, !!r.mode.plan),
			vibe: status(given.vibe, !!r.mode.vibe),
			goal: status(given.goal, !!r.mode.goal),
			loop: status(given.loop, !!r.mode.loop),
		},
		compacting: r.compacting === true,
		goal: parseGoal(r.goal),
		interruptMode: r.interruptMode === "immediate" || r.interruptMode === "wait" ? r.interruptMode : null,
		planNotes: r.planNotes ?? null,
	};
}

/** The goal objective as text, or null for no goal, an older plugin, or a value that isn't the expected shape. */
function parseGoal(raw: unknown): HubSessionGoal | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { objective, tokenBudget } = raw as { objective?: unknown; tokenBudget?: unknown };
	if (typeof objective !== "string" || !objective.trim()) return null;
	return typeof tokenBudget === "number" && Number.isFinite(tokenBudget) ? { objective, tokenBudget } : { objective };
}
