import { describe, expect, it } from "bun:test";
import type { HubJob, HubQuota, HubQuotaWindow } from "../src/client/data/hub";
import {
	accountProblem,
	gapText,
	highest,
	jobOrder,
	logText,
	noBackupNotes,
	quotaHeadline,
	resetsText,
	span,
	statusCounts,
	statusLabel,
	windowView,
} from "../src/client/data/hub-view";
import { parseHash } from "../src/client/data/useHashRoute";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function win(over: Partial<HubQuotaWindow> = {}): HubQuotaWindow {
	return {
		label: "5h",
		usedPercent: 40,
		resetsAt: NOW + 200 * MIN,
		observedAt: NOW - 3 * MIN,
		state: "ok",
		high: false,
		...over,
	};
}

function job(over: Partial<HubJob> = {}): HubJob {
	return {
		label: "com.example.x",
		file: "com.example.x.plist",
		readable: true,
		note: null,
		schedule: "daily 07:00",
		status: "ok",
		exit: "last exit ok",
		pid: null,
		lastLogWrite: NOW - 90 * MIN,
		...over,
	};
}

describe("quota windows", () => {
	it("shows percent, reset time and reading age for a current reading", () => {
		expect(windowView(win(), NOW)).toEqual({ percent: "40%", detail: "resets in 3h 20m · read 3m ago", tone: "ok" });
	});

	it("marks 95 % and above as bad and 80 % as a warning", () => {
		expect(windowView(win({ usedPercent: 97, high: true }), NOW).tone).toBe("bad");
		expect(windowView(win({ usedPercent: 82 }), NOW).tone).toBe("warn");
	});

	it("never turns a stale reading into a number", () => {
		const view = windowView(win({ state: "stale", usedPercent: null }), NOW);
		expect(view.percent).toBe("stale");
		expect(view.percent).not.toContain("0");
		expect(view.detail).toContain("not current");
		expect(view.tone).toBe("warn");
	});

	it("never turns an unknown reading into 0 %", () => {
		const view = windowView(win({ state: "unknown", usedPercent: null, observedAt: null }), NOW);
		expect(view).toEqual({ percent: "unknown", detail: "no usable reading", tone: "neutral" });
	});

	it("shows a real 0 % and a decimal", () => {
		expect(windowView(win({ usedPercent: 0 }), NOW).percent).toBe("0%");
		expect(windowView(win({ usedPercent: 45.7 }), NOW).percent).toBe("45.7%");
	});

	it("says when the reset time has passed", () => {
		expect(resetsText(NOW - MIN, NOW)).toBe("reset time passed");
		expect(resetsText(null, NOW)).toBeNull();
	});
});

describe("quota card summary", () => {
	const quota: HubQuota = {
		generatedAt: NOW,
		cacheAgeMs: 0,
		cacheStale: false,
		source: "local usage records",
		providers: { "openai-codex": 1, anthropic: 2 },
		accounts: [
			{
				provider: "openai-codex",
				label: "a@example.com",
				state: "active",
				windows: [win({ usedPercent: 97, high: true })],
			},
			{
				provider: "anthropic",
				label: "b@example.com",
				state: "needs_login",
				windows: [win({ state: "stale", usedPercent: null })],
			},
			{ provider: "anthropic", label: "c@example.com", state: "rate_limited", windows: [] },
		],
	};

	it("finds the highest current usage and skips stale readings", () => {
		expect(highest(quota)).toEqual({ percent: 97, provider: "Codex" });
		expect(highest({ ...quota, accounts: [quota.accounts[1]] })).toBeNull();
	});

	it("writes the collapsed phone headline", () => {
		expect(quotaHeadline(quota)).toBe("Codex 97% used · 2 accounts need attention");
		expect(quotaHeadline({ ...quota, accounts: [quota.accounts[1]] })).toBe(
			"no current readings · 1 account needs attention",
		);
	});

	it("notes a Codex account with no backup", () => {
		expect(noBackupNotes(quota)).toEqual(["Codex: one account, no backup"]);
		expect(noBackupNotes({ ...quota, providers: { "openai-codex": 2 } })).toEqual([]);
	});

	it("names account problems", () => {
		expect(accountProblem(quota.accounts[1])).toEqual({ label: "Needs login", tone: "bad" });
		expect(accountProblem(quota.accounts[2])).toEqual({ label: "Rate limited", tone: "warn" });
		expect(accountProblem(quota.accounts[0])).toBeNull();
	});
});

describe("jobs", () => {
	it("words the statuses: last exit ok, failed with its exit, not loaded", () => {
		expect(statusLabel(job())).toEqual({ label: "Last exit ok", tone: "ok" });
		expect(statusLabel(job({ status: "failed", exit: "last exit 78" }))).toEqual({
			label: "Failed, exit 78",
			tone: "bad",
		});
		expect(statusLabel(job({ status: "not loaded", exit: null })).label).toBe("Not loaded");
		expect(statusLabel(job({ status: "running", exit: null })).label).toBe("Running");
		expect(statusLabel(job({ status: "unknown", exit: null })).label).toBe("Unknown");
	});

	it("calls the log time a last log write, not a last run", () => {
		expect(logText(job(), NOW)).toBe("last log write 1h 30m ago");
		expect(logText(job({ lastLogWrite: null }), NOW)).toBe("no log written");
	});

	it("lists failed first, then unknown, running, ok, not loaded", () => {
		const jobs = [
			job({ label: "z-ok" }),
			job({ label: "a-off", status: "not loaded" }),
			job({ label: "m-fail", status: "failed" }),
			job({ label: "b-run", status: "running" }),
			job({ label: "c-unk", status: "unknown" }),
		];
		expect(jobs.sort(jobOrder).map(j => j.label)).toEqual(["m-fail", "c-unk", "b-run", "z-ok", "a-off"]);
	});

	it("counts statuses for the header", () => {
		expect(statusCounts([job(), job(), job({ status: "failed" })])).toEqual([
			{ status: "failed", count: 1 },
			{ status: "ok", count: 2 },
		]);
	});

	it("writes a gap with its length", () => {
		const start = new Date(2026, 10, 12, 8, 10).getTime();
		const text = gapText({ start, end: start + 45 * MIN, alerted: true });
		expect(text).toContain("(45m)");
		expect(text).toContain("–");
	});

	it("spans minutes, hours and days", () => {
		expect([span(30_000), span(59 * MIN), span(61 * MIN), span(600 * MIN), span(72 * 60 * MIN)]).toEqual([
			"<1m",
			"59m",
			"1h 1m",
			"10h",
			"3d",
		]);
	});
});

describe("jobs hash route", () => {
	it("opens the Jobs section from the alert link", () => {
		expect(parseHash("#/jobs").section).toBe("jobs");
	});
});
