/**
 * Approve a plan with notes: the plugin approves at once (202) and sends the notes as the session's next message
 * once the approved plan has started. The page then polls the instance's current session for the outcome.
 */
import { ApiError } from "../api";
import { type HubPlanNotesStatus, hubFetch, hubPost } from "./hub";

export type NotesChoice = "execute" | "compact" | "keep";

export interface PlanNotesRequest {
	sessionId: string;
	reviewId: string;
	choice: NotesChoice;
	notes: string;
	requestId: string;
	role?: string;
}

export interface PlanNotesAccepted {
	approved: true;
	requestId: string;
	notes: "pending" | "sent" | "failed" | "uncertain";
	duplicate?: true;
	reason?: string;
}

export const PLAN_NOTES_POLL_MS = 2000;
/** Notes can stay pending for up to 30 minutes (a cancelled compaction has no end event); the page waits a little longer. */
export const PLAN_NOTES_MAX_MS = 31 * 60_000;
export const MAX_NOTES_CHARS = 8000;
export const NOTES_NEED_OMP = "needs omp 18.19";

/** Keyed by instance: the session id changes when execute starts a fresh session. */
export function postPlanNotes(
	instanceId: string,
	body: PlanNotesRequest,
	machine: string | undefined,
): Promise<PlanNotesAccepted> {
	return hubPost(`instances/${encodeURIComponent(instanceId)}/plan-notes`, { ...body }, machine);
}

/** Read-only: the hub resolves the instance's current session itself, so this follows execute's session switch. */
export function getPlanNotesStatus(
	instanceId: string,
	requestId: string,
	machine: string | undefined,
	signal?: AbortSignal,
): Promise<HubPlanNotesStatus> {
	return hubFetch(
		`instances/${encodeURIComponent(instanceId)}/plan-notes?requestId=${encodeURIComponent(requestId)}`,
		{ signal },
		machine,
	);
}

export function notesProblem(notes: string): string | null {
	if (notes.trim() === "") return "Write the changes to send with the approval.";
	if (notes.length > MAX_NOTES_CHARS)
		return `Notes can be at most ${MAX_NOTES_CHARS} characters (an emoji counts as 2).`;
	return null;
}

/** How a notes request ended (or that the page stopped waiting). */
export type PlanNotesOutcome =
	| { state: "sent" }
	| { state: "failed"; reason: string }
	| { state: "refused"; reason: string }
	| { state: "unknown"; reason: string }
	/** The hub has no record of this request (instance gone, or its receipt expired). */
	| { state: "unconfirmed" };

export function outcomeText(outcome: PlanNotesOutcome): string {
	switch (outcome.state) {
		case "sent":
			return "Plan approved; notes sent as the session's next message.";
		case "failed":
			return `Plan approved; notes not sent: ${outcome.reason}`;
		case "refused":
			return `The plan was not approved: ${outcome.reason}`;
		case "unknown":
			return `Plan approved; ${outcome.reason}`;
		case "unconfirmed":
			return UNCONFIRMED_NOTES_TEXT;
	}
}

export const PENDING_TEXT = "Plan approved; the notes go out once the plan has started…";

export const UNCONFIRMED_NOTES_TEXT = "Couldn't confirm the notes; check the session.";

/** Read one status into an outcome, or null while it is still pending. */
export function statusOutcome(status: HubPlanNotesStatus): PlanNotesOutcome | null {
	if (status.state === "unknown") return { state: "unconfirmed" };
	if (status.approved === false) return { state: "refused", reason: status.reason ?? "the session refused it" };
	if (status.state === "sent") return { state: "sent" };
	if (status.state === "failed") return { state: "failed", reason: status.reason ?? "no reason given" };
	if (status.state === "uncertain")
		return { state: "unknown", reason: status.reason ?? "notes may not have been delivered; check the session" };
	return null;
}

/** One status read may take this long before it counts as failed. */
export const PLAN_NOTES_READ_MS = 10_000;

/**
 * Poll every `intervalMs` until the notes are sent or failed. A 404 (the hub has not seen the request on the
 * instance yet) keeps waiting; any other error, a read that takes longer than `readMs`, or running past `maxMs`
 * ends in `unknown`. Only reads: the approval is never sent again. Each read is bounded by the overall deadline too.
 */
export async function pollPlanNotes(opts: {
	instanceId: string;
	requestId: string;
	machine: string | undefined;
	signal: AbortSignal;
	intervalMs?: number;
	maxMs?: number;
	readMs?: number;
	read?: typeof getPlanNotesStatus;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
}): Promise<PlanNotesOutcome> {
	const interval = opts.intervalMs ?? PLAN_NOTES_POLL_MS;
	const maxMs = opts.maxMs ?? PLAN_NOTES_MAX_MS;
	const readMs = opts.readMs ?? PLAN_NOTES_READ_MS;
	const read = opts.read ?? getPlanNotesStatus;
	const sleep = opts.sleep ?? abortableSleep;
	const now = opts.now ?? Date.now;
	const deadline = now() + maxMs;
	const timedOut: PlanNotesOutcome = {
		state: "unknown",
		reason: "the notes are still pending after 30 minutes. Check the session before sending them again.",
	};
	for (;;) {
		await sleep(interval, opts.signal);
		const left = deadline - now();
		if (left <= 0) return timedOut;
		const limit = new AbortController();
		const stop = () => limit.abort(opts.signal.reason);
		opts.signal.addEventListener("abort", stop, { once: true });
		const timer = setTimeout(() => limit.abort(new Error("timeout")), Math.min(readMs, left));
		try {
			// Raced against the limit too, so a read that ignores its signal still can't outlast it.
			const outcome = statusOutcome(
				await Promise.race([
					read(opts.instanceId, opts.requestId, opts.machine, limit.signal),
					aborted(limit.signal),
				]),
			);
			if (outcome) return outcome;
		} catch (error) {
			if (opts.signal.aborted) throw error;
			if (!(error instanceof ApiError && error.status === 404))
				return {
					state: "unknown",
					reason: limit.signal.aborted
						? "the hub did not answer in time. Check the session, or check again."
						: `could not check the notes (${error instanceof Error ? error.message : String(error)}). Check the session.`,
				};
		} finally {
			clearTimeout(timer);
			opts.signal.removeEventListener("abort", stop);
		}
		if (now() >= deadline) return timedOut;
	}
}

function aborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal.reason);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
