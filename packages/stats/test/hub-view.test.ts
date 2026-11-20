import { describe, expect, it } from "bun:test";
import type { HubQuota, HubQuotaWindow } from "../src/client/data/hub";
import {
	accountProblem,
	highest,
	noBackupNotes,
	quotaHeadline,
	resetsText,
	span,
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

describe("jobs hash route", () => {
	it("opens the Jobs section from the alert link", () => {
		expect(parseHash("#/jobs").section).toBe("jobs");
	});
});
