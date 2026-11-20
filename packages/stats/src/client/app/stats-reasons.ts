/**
 * Plain wording for why a machine's stats request failed. The hub and the browser report technical reasons
 * ("the stats port answered without the dashboard's proof…", "no answer in time", "machine unreachable"); pages show
 * the plain sentence and keep the raw reason for a tooltip or details.
 *
 * Every reason the hub can send to the dashboard is listed by its exact text (omp_hub/serve.py and fleet.py), so a
 * change of wording there shows up as a failing row in test/stats-reasons.test.ts rather than a wrong class.
 */

export type StatsFailureKind =
	/** A real proof or identity mismatch: the other side runs a different version (or key). */
	| "version"
	/** It answered, but not with data (wrong content type, unparseable body). */
	| "unexpected"
	/** A signed request was refused for its timestamp: clocks differ, or the receiving hub just restarted. */
	| "clock"
	| "timeout"
	/** Not answering: nothing listening, refused or reset, or too slow to answer at all (STATS_DOWN). */
	| "down"
	| "loading"
	/** Too many streams or requests at once; it will retry. */
	| "busy"
	/** The hub lacks a key it needs for this machine. */
	| "setup"
	| "unknown";

export interface StatsFailure {
	kind: StatsFailureKind;
	/** The raw reason, for a tooltip or details; null when there was none. */
	detail: string | null;
}

/** Exact reasons from the hub (serve.py, fleet.py) and the browser. */
export const KNOWN_STATS_REASONS: ReadonlyMap<string, StatsFailureKind> = new Map<string, StatsFailureKind>([
	// serve.py STATS_NO_PROOF and fleet.forward's proof check (fleet.py), surfaced as is by the gatherer.
	["the stats port answered without the dashboard's proof; nothing was passed on", "version"],
	["machine identity check failed", "version"],
	// fleet.Verifier on a node (fleet.py) and the node listener's 401.
	["bad signature", "version"],
	// The node listener answers this for every refused signed request, clock and replay rejections included,
	// so it does not prove a different version.
	["bad fleet signature", "unknown"],
	// Malformed signing headers: not an identity mismatch, so no "different version" claim.
	["bad time", "unknown"],
	["bad nonce", "unknown"],
	["request too old", "clock"],
	["request from the future", "clock"],
	["request predates this process", "clock"],
	["nonce reused", "unknown"],
	// Answers that were not data.
	["the stats dashboard answered something other than data", "unexpected"],
	["machine answered something other than data", "unexpected"],
	["bad answer", "unexpected"],
	// Time limits: fleet.py _describe / Gatherer, fleet.forward, and the browser's own request deadline.
	["no answer in time", "timeout"],
	["deadline passed", "timeout"],
	["connect timed out", "timeout"],
	["timeout", "timeout"],
	// Nothing answering.
	["the stats dashboard is not answering; see launchd/logs/omp_stats.error.log", "down"],
	[
		"port 3850 is not held by our stats dashboard (is com.example.omp-stats running?); see launchd/logs/omp_stats.error.log",
		"down",
	],
	["machine unreachable", "down"],
	["unreachable", "down"],
	["stats unavailable", "down"],
	["answer too large", "unexpected"],
	// Starting up.
	["stats status is still loading", "loading"],
	["sessions are still loading; try again in a few seconds", "loading"],
	// Capacity.
	["busy", "busy"],
	// Configuration.
	["machine key missing", "setup"],
	["the hub has no stats key yet; restart the hub", "setup"],
]);

/** Reasons with a variable part: matched by their fixed start. */
const PREFIXES: readonly [string, StatsFailureKind][] = [
	["too many dashboard tabs are streaming", "busy"],
	["stats answered ", "unexpected"],
	["the machine answered ", "unexpected"],
];

/** Operating-system wording that can reach a reason through an OSError. */
const SYSTEM: readonly [RegExp, StatsFailureKind][] = [
	[/ECONNREFUSED|ECONNRESET|connection refused|connection reset/i, "down"],
	[/timed out|did not answer within|AbortError|operation was aborted/i, "timeout"],
];

export function classifyStatsFailure(reason: string | null | undefined): StatsFailure {
	const detail = reason?.trim() || null;
	if (!detail) return { kind: "unknown", detail: null };
	// A Map, not an object: inherited keys such as "constructor" or "__proto__" must not match.
	const exact = KNOWN_STATS_REASONS.get(detail);
	if (exact) return { kind: exact, detail };
	for (const [prefix, kind] of PREFIXES) if (detail.startsWith(prefix)) return { kind, detail };
	for (const [pattern, kind] of SYSTEM) if (pattern.test(detail)) return { kind, detail };
	return { kind: "unknown", detail };
}

/**
 * "<machine>'s stats server is a different version; numbers may be missing until it's updated." and friends.
 * Without a machine name the sentence speaks of "the stats" (a page showing one machine's numbers).
 */
export function statsFailureSentence(
	machine: string | null | undefined,
	reason: string | null | undefined,
	{ refreshing = false }: { refreshing?: boolean } = {},
): string {
	// "retrying" only where something really asks again by itself; otherwise the reader is pointed at Try again.
	const next = refreshing ? "retrying" : "try again";
	const stats = machine ? `${machine}'s stats` : "The stats";
	const server = machine ? `${machine}'s stats server` : "The stats server";
	switch (classifyStatsFailure(reason).kind) {
		case "version":
			return `${server} is a different version; numbers may be missing until it's updated.`;
		case "unexpected":
			return `${stats} sent an unexpected answer; numbers may be missing.`;
		case "clock":
			return `${stats}: clocks are out of sync or the hub restarted; ${next}.`;
		case "timeout":
			return `${stats} didn't answer in time; numbers may be missing.`;
		case "down":
			return `${server} isn't answering; numbers may be missing.`;
		case "loading":
			return `${stats} are still loading; numbers may be missing.`;
		case "busy":
			return `${stats} are busy; ${next}.`;
		case "setup":
			return `The hub isn't set up to read ${machine ? `${machine}'s stats` : "these stats"} yet; numbers may be missing.`;
		case "unknown":
			return `${stats} didn't answer; numbers may be missing.`;
	}
}

/** A short phrase for inline use ("Could not list the subagents: <phrase>"), without the machine name. */
export function plainStatsReason(
	reason: string | null | undefined,
	{ refreshing = false }: { refreshing?: boolean } = {},
): string {
	switch (classifyStatsFailure(reason).kind) {
		case "version":
			return "its stats server is a different version until it's updated";
		case "unexpected":
			return "it sent an unexpected answer";
		case "clock":
			return `clocks are out of sync or the hub restarted${refreshing ? "; retrying" : ""}`;
		case "timeout":
			return "it didn't answer in time";
		case "down":
			return "its stats server isn't answering";
		case "loading":
			return "its stats are still loading";
		case "busy":
			return refreshing ? "it's busy; retrying" : "it's busy";
		case "setup":
			return "the hub isn't set up for it yet";
		case "unknown":
			return "it didn't answer";
	}
}

/**
 * The reason as a phrase that names its subject, for sentences that stand alone (a tooltip, a note) where "its"
 * would have no referent: "Ada Server's stats server is a different version until it's updated". Without a
 * machine name it speaks of "the stats".
 */
export function namedStatsReason(
	machine: string | null | undefined,
	reason: string | null | undefined,
	{ refreshing = false }: { refreshing?: boolean } = {},
): string {
	const stats = machine ? `${machine}'s stats` : "the stats";
	const server = machine ? `${machine}'s stats server` : "the stats server";
	switch (classifyStatsFailure(reason).kind) {
		case "version":
			return `${server} is a different version until it's updated`;
		case "unexpected":
			return `${stats} sent an unexpected answer`;
		case "clock":
			return `${stats}: clocks are out of sync or the hub restarted${refreshing ? "; retrying" : ""}`;
		case "timeout":
			return `${stats} didn't answer in time`;
		case "down":
			return `${server} isn't answering`;
		case "loading":
			return `${stats} are still loading`;
		case "busy":
			return `${stats} are busy${refreshing ? "; retrying" : ""}`;
		case "setup":
			return `the hub isn't set up to read ${machine ? `${machine}'s stats` : "these stats"} yet`;
		case "unknown":
			return `${stats} didn't answer`;
	}
}
