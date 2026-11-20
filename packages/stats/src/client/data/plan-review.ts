/** Rules for answering a plan review from the Sessions page (pure, so they are tested without a DOM). */
import { ApiError } from "../api";
import type { HubSession, PlanChoice, PlanOption } from "./hub";

/** Counted in UTF-16 code units (JS string length), the same way the hub and the plugin count. */
export const MAX_FEEDBACK_CHARS = 8000;

export const RESTART_FOR_PLAN = "Restart this session to answer plan reviews from here.";

export const PLAN_EDIT_NOTE = "This is the plan as proposed. Edits made inside the terminal review are not shown here.";

/** The default tier choice: send no role, so the terminal's own selection applies. */
export const TERMINAL_SELECTION = "Terminal's selection";

export const TRUNCATED_NOTICE =
	"This plan is longer than the hub can show in full, so approving is off here. Approve it at the Mac, or refine or save it.";

/** The restart hint when the Terminal panel can answer the review in the meantime. */
export const RESTART_FOR_PLAN_OR_TERMINAL = `${RESTART_FOR_PLAN} Or answer it in the Terminal tab.`;

/** The hub read a dialog off the session's terminal screen (the session itself did not report it). */
export function terminalWaiting(s: HubSession) {
	return s.terminal?.waiting ?? null;
}

/** A session needs you when it asks a question, a plan review is waiting, or a dialog waits in its terminal. */
export function needsYou(s: HubSession): boolean {
	return Boolean(s.inputRequired) || Boolean(s.planReview) || terminalWaiting(s) !== null;
}

/** execute, compact and keep start work (and take a tier); refine and save do not. */
export function isApproval(choice: PlanChoice): boolean {
	return choice === "execute" || choice === "compact" || choice === "keep";
}

/** Why Refine can't be sent yet, or null. */
export function feedbackProblem(feedback: string): string | null {
	if (feedback.trim() === "") return "Refine plan needs feedback: say what to change.";
	if (feedback.length > MAX_FEEDBACK_CHARS)
		return `Feedback can be at most ${MAX_FEEDBACK_CHARS} characters (an emoji counts as 2).`;
	return null;
}

/** Why this option's button is off right now, or null when it can be pressed. */
export function optionProblem(
	option: PlanOption,
	state: { truncated: boolean; feedback: string; busy: boolean; stale: boolean },
): string | null {
	if (state.busy) return "Sending an answer…";
	if (state.stale) return "This plan review is closed or was replaced.";
	if (option.disabled) return "The terminal offers this choice as unavailable right now.";
	if (state.truncated && isApproval(option.id)) return TRUNCATED_NOTICE;
	if (option.id === "refine") return feedbackProblem(state.feedback);
	return null;
}

/** The wording of the confirmation dialog for a choice. */
export function confirmText(choice: PlanChoice, title: string): string {
	switch (choice) {
		case "save":
			return "Save the plan, leave plan mode and start a fresh session? The omp process keeps running.";
		case "refine":
			return `Send your feedback and ask the agent to revise '${title}'?`;
		default:
			return `Approve '${title}' and start execution in this session?`;
	}
}

const CODE_MESSAGES: Record<string, string> = {
	not_accepted:
		"The terminal did not accept that answer: the review was closed or replaced, or that choice is unavailable.",
	restart_needed: RESTART_FOR_PLAN,
	changed: "The plan review changed while you were looking at it. Check the new plan, then answer again.",
	stale_session: "This session was restarted or replaced. Go back to the list and open it again.",
	truncated: TRUNCATED_NOTICE,
};

/** The message for a failed plan request: a known 409 code gets its own text, anything else the server's. */
export function planErrorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code && error.code in CODE_MESSAGES) return CODE_MESSAGES[error.code];
		if (error.status === 502) return "The hub could not reach the session. Try again in a moment.";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}
