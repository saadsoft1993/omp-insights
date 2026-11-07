/**
 * What a transcript says about its agent's progress, kept at ingest so the
 * Live view can show subagents without re-reading files: when it last wrote,
 * the last tool it started (name and omp's short intent text, never the
 * arguments), when it last exited, whether it ended its turn and is waiting,
 * and its parent session.
 */
import type { SessionEntry } from "./types";

/** Intent text is a short human label; anything longer is cut. */
const INTENT_MAX_CHARS = 120;

/** The last tool a transcript started. */
export interface TranscriptTool {
	name: string | null;
	intent: string | null;
	/** Epoch ms it started. */
	at: number | null;
}

/**
 * Activity gathered from one parsed stretch of a transcript. A tail parse sees
 * only appended entries, so absent facts mean "unchanged", not "none".
 */
export interface TranscriptActivity {
	/** Newest entry timestamp in the stretch. */
	lastAt: number | null;
	/** Last tool started in the stretch. */
	tool: TranscriptTool | null;
	/** Last `session_exit` in the stretch. */
	exit: { at: number | null; reason: string | null } | null;
	/**
	 * Turn state the stretch ends in: `{ at }` when it ended with a plain
	 * answer (waiting to be messaged), `{ at: null }` when a later tool start or
	 * user message cleared that, null when the stretch said nothing either way.
	 */
	yielded: { at: number | null } | null;
	/** `parentSession` of the session header, when the stretch includes it. */
	parent: string | null;
}

/** Stored activity of one transcript (the `transcript_activity` row). */
export interface TranscriptActivityRow {
	sessionFile: string;
	parent: string | null;
	lastAt: number | null;
	toolName: string | null;
	toolIntent: string | null;
	toolAt: number | null;
	exitAt: number | null;
	exitReason: string | null;
	yieldedAt: number | null;
}

export function emptyActivity(): TranscriptActivity {
	return { lastAt: null, tool: null, exit: null, yielded: null, parent: null };
}

function timestampOf(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/** Fold one transcript entry into the stretch's activity. */
export function trackActivity(activity: TranscriptActivity, entry: SessionEntry): void {
	const ts = "timestamp" in entry ? timestampOf(entry.timestamp) : null;
	if (ts !== null) activity.lastAt = Math.max(activity.lastAt ?? 0, ts);
	switch (entry.type) {
		case "session":
			if ("parentSession" in entry && typeof entry.parentSession === "string") activity.parent = entry.parentSession;
			return;
		case "custom": {
			if (!("customType" in entry)) return;
			const data = "data" in entry && entry.data && typeof entry.data === "object" ? entry.data : {};
			if (entry.customType === "tool_execution_start") {
				const name = "toolName" in data ? data.toolName : null;
				const intent = "intent" in data ? data.intent : null;
				activity.tool = {
					name: typeof name === "string" ? name : null,
					intent: typeof intent === "string" ? intent.slice(0, INTENT_MAX_CHARS) : null,
					at: ("startedAt" in data ? timestampOf(data.startedAt) : null) ?? ts,
				};
				activity.yielded = { at: null };
			} else if (entry.customType === "session_exit") {
				const reason = "reason" in data ? data.reason : null;
				activity.exit = { at: ts, reason: typeof reason === "string" ? reason : null };
			}
			return;
		}
		case "message": {
			if (!("message" in entry) || !entry.message || typeof entry.message !== "object") return;
			const message = entry.message;
			if (message.role === "user") activity.yielded = { at: null };
			// A plain answer (no tool call) ends the turn: done until someone messages the agent again.
			else if (message.role === "assistant" && "stopReason" in message && message.stopReason === "stop") {
				activity.yielded = { at: ts };
			}
			return;
		}
	}
}

/**
 * Stored row after a parsed stretch: the stretch alone when it covered the
 * transcript from the start, else merged over what an earlier parse stored.
 */
export function mergeActivity(
	sessionFile: string,
	previous: TranscriptActivityRow | null,
	activity: TranscriptActivity,
): TranscriptActivityRow {
	const base: TranscriptActivityRow = previous ?? {
		sessionFile,
		parent: null,
		lastAt: null,
		toolName: null,
		toolIntent: null,
		toolAt: null,
		exitAt: null,
		exitReason: null,
		yieldedAt: null,
	};
	return {
		sessionFile,
		parent: activity.parent ?? base.parent,
		lastAt: activity.lastAt === null ? base.lastAt : Math.max(base.lastAt ?? 0, activity.lastAt),
		toolName: activity.tool ? activity.tool.name : base.toolName,
		toolIntent: activity.tool ? activity.tool.intent : base.toolIntent,
		toolAt: activity.tool ? activity.tool.at : base.toolAt,
		exitAt: activity.exit ? activity.exit.at : base.exitAt,
		exitReason: activity.exit ? activity.exit.reason : base.exitReason,
		yieldedAt: activity.yielded ? activity.yielded.at : base.yieldedAt,
	};
}
