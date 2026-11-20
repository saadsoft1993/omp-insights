import { expect, test } from "bun:test";
import { missingMachineNotes } from "../src/client/app/MachineBanner";
import {
	classifyStatsFailure,
	KNOWN_STATS_REASONS,
	plainStatsReason,
	statsFailureSentence,
} from "../src/client/app/stats-reasons";

/** One row per real reason: the hub's exact text (omp_hub/serve.py, fleet.py) or the browser's, and its class. */
const CASES = [
	["the stats port answered without the dashboard's proof; nothing was passed on", "version"],
	["machine identity check failed", "version"],
	["bad signature", "version"],
	["bad fleet signature", "unknown"],
	["bad time", "unknown"],
	["bad nonce", "unknown"],
	["request too old", "clock"],
	["request from the future", "clock"],
	["request predates this process", "clock"],
	["nonce reused", "unknown"],
	["the stats dashboard answered something other than data", "unexpected"],
	["machine answered something other than data", "unexpected"],
	["bad answer", "unexpected"],
	["answer too large", "unexpected"],
	["stats answered 404", "unexpected"],
	["the machine answered 500", "unexpected"],
	["no answer in time", "timeout"],
	["deadline passed", "timeout"],
	["connect timed out", "timeout"],
	["timeout", "timeout"],
	["Ada MacBook did not answer within 10 s", "timeout"],
	["The operation was aborted.", "timeout"],
	["the stats dashboard is not answering; see launchd/logs/omp_stats.error.log", "down"],
	[[...KNOWN_STATS_REASONS.keys()].find(reason => reason.startsWith("port 3850 is not held"))!, "down"],
	["machine unreachable", "down"],
	["unreachable", "down"],
	["stats unavailable", "down"],
	["connect ECONNREFUSED 127.0.0.1:3850", "down"],
	["connection reset by peer", "down"],
	["stats status is still loading", "loading"],
	["sessions are still loading; try again in a few seconds", "loading"],
	["busy", "busy"],
	[
		"too many dashboard tabs are streaming (at most 6 per machine, 18 in all); close a tab, then reload this one",
		"busy",
	],
	["machine key missing", "setup"],
	["the hub has no stats key yet; restart the hub", "setup"],
	["unknown machine", "unknown"],
	["not available on remote machines", "unknown"],
	["forbidden", "unknown"],
	["HTTP error 500 on /api/stats/overview", "unknown"],
	["Failed to fetch", "unknown"],
	[null, "unknown"],
	["", "unknown"],
] as const;

for (const [reason, kind] of CASES)
	test(`classifies ${JSON.stringify(reason)} as ${kind}`, () => {
		expect(classifyStatsFailure(reason).kind).toBe(kind);
	});

test("each kind has a plain sentence with no technical reason in it", () => {
	const proof = "the stats port answered without the dashboard's proof; nothing was passed on";
	expect(statsFailureSentence("Ada Server", proof)).toBe(
		"Ada Server's stats server is a different version; numbers may be missing until it's updated.",
	);
	expect(statsFailureSentence("Ada MacBook", "timeout")).toBe(
		"Ada MacBook's stats didn't answer in time; numbers may be missing.",
	);
	expect(statsFailureSentence("Ada Mac mini", "connect ECONNREFUSED 127.0.0.1:3850")).toBe(
		"Ada Mac mini's stats server isn't answering; numbers may be missing.",
	);
	expect(statsFailureSentence("Ada Server", "stats status is still loading")).toBe(
		"Ada Server's stats are still loading; numbers may be missing.",
	);
	expect(statsFailureSentence("Ada Server", "the stats dashboard answered something other than data")).toBe(
		"Ada Server's stats sent an unexpected answer; numbers may be missing.",
	);
	expect(statsFailureSentence("Ada Server", "request predates this process")).toBe(
		"Ada Server's stats: clocks are out of sync or the hub restarted; try again.",
	);
	expect(statsFailureSentence("Ada Server", "busy")).toBe("Ada Server's stats are busy; try again.");
	expect(statsFailureSentence("Ada Server", "busy", { refreshing: true })).toBe(
		"Ada Server's stats are busy; retrying.",
	);
	expect(statsFailureSentence("Ada Server", "machine key missing")).toBe(
		"The hub isn't set up to read Ada Server's stats yet; numbers may be missing.",
	);
	expect(statsFailureSentence("Ada Server", "something odd")).toBe(
		"Ada Server's stats didn't answer; numbers may be missing.",
	);
	expect(plainStatsReason(proof)).toBe("its stats server is a different version until it's updated");
	expect(plainStatsReason("timeout")).toBe("it didn't answer in time");
	expect(plainStatsReason("ECONNRESET")).toBe("its stats server isn't answering");
	expect(plainStatsReason("request too old")).toBe("clocks are out of sync or the hub restarted");
	expect(plainStatsReason("request too old", { refreshing: true })).toBe(
		"clocks are out of sync or the hub restarted; retrying",
	);
	expect(plainStatsReason("busy")).toBe("it's busy");
	expect(plainStatsReason("busy", { refreshing: true })).toBe("it's busy; retrying");
	expect(plainStatsReason("machine answered something other than data")).toBe("it sent an unexpected answer");
	expect(plainStatsReason(undefined)).toBe("it didn't answer");
});

test("the banner keeps the raw reason only as detail", () => {
	const proof = "the stats port answered without the dashboard's proof; nothing was passed on";
	const notes = missingMachineNotes([
		{ id: "server", name: "Ada Server", ok: false, error: proof, stale: false, outdated: false, lastKnown: false },
	]);
	expect(notes).toEqual([
		{
			text: "Ada Server's stats server is a different version; numbers may be missing until it's updated.",
			detail: proof,
		},
	]);
	expect(notes[0]!.text).not.toContain("proof");
});

test("only a proof or identity mismatch says different version", () => {
	const versionRows = CASES.filter(([, kind]) => kind === "version").map(([reason]) => reason);
	expect(versionRows).toEqual([
		"the stats port answered without the dashboard's proof; nothing was passed on",
		"machine identity check failed",
		"bad signature",
	]);
	// The node listener says this for clock and replay rejections too: no version claim.
	expect(statsFailureSentence("M", "bad fleet signature")).toBe("M's stats didn't answer; numbers may be missing.");
	for (const reason of [
		"request too old",
		"request from the future",
		"request predates this process",
		"the stats dashboard answered something other than data",
	])
		expect(statsFailureSentence("M", reason)).not.toContain("different version");
});

test("a down or slow stats server is never called not running", () => {
	for (const [reason, kind] of CASES)
		if (kind === "down") {
			expect(statsFailureSentence("M", reason)).toBe("M's stats server isn't answering; numbers may be missing.");
			expect(statsFailureSentence("M", reason)).not.toContain("running");
		}
});

test("inherited object keys are unknown reasons, never a crash or a function kind", () => {
	for (const reason of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
		expect(classifyStatsFailure(reason)).toEqual({ kind: "unknown", detail: reason });
		expect(statsFailureSentence("M", reason)).toBe("M's stats didn't answer; numbers may be missing.");
		expect(plainStatsReason(reason)).toBe("it didn't answer");
	}
});

test("named reasons stand alone: every group names the machine, never a bare its", async () => {
	const { namedStatsReason } = await import("../src/client/app/stats-reasons");
	const expected: Record<string, string> = {
		version: "Ada Server's stats server is a different version until it's updated",
		unexpected: "Ada Server's stats sent an unexpected answer",
		clock: "Ada Server's stats: clocks are out of sync or the hub restarted",
		timeout: "Ada Server's stats didn't answer in time",
		down: "Ada Server's stats server isn't answering",
		loading: "Ada Server's stats are still loading",
		busy: "Ada Server's stats are busy",
		setup: "the hub isn't set up to read Ada Server's stats yet",
		unknown: "Ada Server's stats didn't answer",
	};
	const seen = new Set<string>();
	for (const [reason, kind] of CASES) {
		if (seen.has(kind)) continue;
		seen.add(kind);
		const phrase = namedStatsReason("Ada Server", reason);
		expect(phrase).toBe(expected[kind]!);
		// "until it's updated" refers back to the named server; a bare leading "its"/"it" would have no referent.
		expect(phrase).not.toMatch(/\bits\b|^it\b/);
	}
	expect(seen.size).toBe(Object.keys(expected).length);
	expect(namedStatsReason(null, "busy", { refreshing: true })).toBe("the stats are busy; retrying");
});
