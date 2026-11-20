import { describe, expect, it } from "bun:test";
import {
	mergeAccountFlow,
	mergeAccounts,
	mergeCosts,
	mergeErrors,
	mergeFrustration,
	mergeGain,
	mergeLive,
	mergeModels,
	mergeOverview,
	mergeProjects,
	mergeProviders,
	mergeRequests,
	mergeTools,
	mergeTraces,
	normalizeHome,
} from "./fleet-merge";
import type {
	AccountDashboardStats,
	AggregatedStats,
	FrustrationDashboardStats,
	GainDashboardStats,
	LiveTrafficStats,
	MessageStats,
	ProviderDashboardStats,
	SessionSummary,
} from "../types";

const aggregate = (requests: number, n: number, avg: number): AggregatedStats => ({
	totalRequests: requests,
	successfulRequests: requests - 1,
	failedRequests: 1,
	errorRate: 0,
	totalInputTokens: 10,
	totalOutputTokens: 5,
	totalCacheReadTokens: 10,
	totalCacheWriteTokens: 0,
	cacheRate: 0,
	cacheSavings: 0,
	noCacheInputCost: 10,
	cachedPromptCost: 5,
	durationN: n,
	ttftN: n,
	tpsN: n,
	totalCost: 1,
	unpricedRequests: 0,
	totalPremiumRequests: 0,
	avgDuration: avg,
	avgTtft: avg,
	avgTokensPerSecond: avg,
	firstTimestamp: 1,
	lastTimestamp: 2,
});

describe("fleet merges", () => {
	it("weights overview averages by measured counts and aligns buckets", () => {
		const point = {
			timestamp: 10,
			requests: 1,
			errors: 0,
			tokens: 3,
			cost: 1,
			durationN: 1,
			ttftN: 1,
			tpsN: 1,
			noCacheInputCost: 1,
			cachedPromptCost: 0.5,
		};
		const a = { overall: aggregate(10, 1, 10), byAgentType: [], bySideChannel: [], timeSeries: [point] };
		const b = { overall: aggregate(20, 3, 30), byAgentType: [], bySideChannel: [], timeSeries: [point] };
		const merged = mergeOverview([a, b]);
		expect(merged.overall.avgDuration).toBe(25);
		expect(merged.overall.errorRate).toBe(2 / 30);
		expect(merged.overall.cacheSavings).toBe(0.5);
		expect(merged.timeSeries[0].requests).toBe(2);
		expect(mergeOverview([a]).overall.totalRequests).toBe(10);
		const side = (totalRequests: number) => ({
			category: "title",
			decision: false,
			totalRequests,
			totalInputTokens: totalRequests,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			totalCost: 0,
		});
		const sides = mergeOverview([
			{ ...a, bySideChannel: [side(2)] },
			{ ...b, bySideChannel: [side(3), { ...side(1), decision: true }] },
		]).bySideChannel;
		expect(sides.map(row => [row.decision, row.totalRequests])).toEqual([
			[false, 5],
			[true, 1],
		]);
	});
	it("merges model counts, performance, and costs", () => {
		const performance = {
			timestamp: 1,
			model: "m",
			provider: "p",
			requests: 10,
			ttftN: 1,
			tpsN: 1,
			avgTtft: 10,
			avgTokensPerSecond: 10,
		};
		const m = {
			byModel: [{ ...aggregate(10, 1, 10), model: "m", provider: "p" }],
			modelSeries: [{ timestamp: 1, model: "m", provider: "p", requests: 1 }],
			modelPerformanceSeries: [performance],
		};
		const other = {
			...m,
			modelPerformanceSeries: [{ ...performance, ttftN: 3, tpsN: 3, avgTtft: 30, avgTokensPerSecond: 30 }],
		};
		expect(mergeModels([m, other]).modelPerformanceSeries[0].avgTtft).toBe(25);
		expect(mergeModels([m]).byModel[0].totalRequests).toBe(10);
		const c = {
			costSeries: [
				{
					timestamp: 1,
					model: "m",
					provider: "p",
					cost: 1,
					unpricedRequests: 0,
					costInput: 1,
					costOutput: 0,
					costCacheRead: 0,
					costCacheWrite: 0,
					requests: 1,
				},
			],
		};
		expect(mergeCosts([c, c]).costSeries[0].cost).toBe(2);
		expect(mergeCosts([c]).costSeries).toHaveLength(1);
	});
	it("normalizes homes, combines folders and computes gain fractions", () => {
		expect(normalizeHome("/tmp/me2/a", "/tmp/me")).toBe("/tmp/me2/a");
		const folders = [
			{ machine: "a", home: "/home/me", data: [{ ...aggregate(2, 1, 1), folder: "/home/me/p" }] },
			{ machine: "b", home: "/Users/me", data: [{ ...aggregate(2, 1, 1), folder: "/Users/me/p" }] },
		];
		expect(mergeProjects(folders)[0].totalRequests).toBe(4);
		expect(mergeProjects(folders.slice(0, 1))[0].folder).toBe("~/p");
		const totals = {
			savedTokens: 5,
			savedBytes: 20,
			hits: 1,
			outputBytes: 80,
			originalBytes: 100,
			reductionPercent: 0.2,
		};
		const gain: GainDashboardStats = {
			overall: totals,
			bySource: { snapcompact: totals, compaction: totals },
			timeSeries: [{ date: "2026-01-01", snapcompact: 5, compaction: 0, total: 5 }],
			project: null,
			projects: ["/home/me/p"],
		};
		expect(
			mergeGain([
				{ machine: "a", home: "/home/me", data: gain },
				{ machine: "b", home: "/home/me", data: gain },
			]).overall.reductionPercent,
		).toBe(0.2);
		expect(mergeGain([{ machine: "a", home: "/home/me", data: gain }]).projects).toEqual(["~/p"]);
		// Imaged tool results record no original size: one such machine keeps the fleet's reduction unknown.
		const unsized = {
			savedTokens: 100,
			savedBytes: 400,
			hits: 2,
			outputBytes: 0,
			originalBytes: 0,
			reductionPercent: null,
		};
		const sized = {
			savedTokens: 150,
			savedBytes: 600,
			hits: 1,
			outputBytes: 400,
			originalBytes: 1000,
			reductionPercent: 0.6,
		};
		const overall = mergeGain([
			{ machine: "a", home: "/home/me", data: { ...gain, overall: unsized } },
			{ machine: "b", home: "/home/me", data: { ...gain, overall: sized } },
		]).overall;
		expect(overall).toEqual({
			savedTokens: 250,
			savedBytes: 1000,
			hits: 3,
			outputBytes: 0,
			originalBytes: 0,
			reductionPercent: null,
		});
	});
	it("adds tool, flow and frustration counts", () => {
		const tool = { byTool: [], byToolModel: [], series: [{ timestamp: 1, tool: "read", calls: 2, errors: 1 }] };
		expect(mergeTools([tool, tool]).series[0].calls).toBe(4);
		expect(mergeTools([tool]).series[0].calls).toBe(2);
		const flow = {
			series: [{ key: "a", provider: "p", label: "a", accountKey: "a" }],
			points: [{ timestamp: 1, key: "a", requests: 2, tokens: 4 }],
		};
		expect(mergeAccountFlow([flow, flow]).points[0].tokens).toBe(8);
		expect(mergeAccountFlow([flow]).points[0].requests).toBe(2);
		const f = {
			overall: { messages: 2, judged: 1, annoyed: 1, atAssistant: 0, angry: 0 },
			byModel: [],
			judgeAvailable: true,
			job: {},
		} as unknown as FrustrationDashboardStats;
		expect(mergeFrustration([f, f]).overall.messages).toBe(4);
		expect(mergeFrustration([f]).judgeAvailable).toBe(false);
	});
	it("keeps latest quota and per-machine states without mutating inputs", () => {
		const account: AccountDashboardStats["accounts"][number] = {
			key: "p:a",
			provider: "p",
			label: "a",
			email: null,
			orgId: null,
			credentialType: "oauth",
			credentialIds: [],
			disabledCause: null,
			requests: 2,
			failedRequests: 0,
			totalTokens: 4,
			totalCost: 1,
			unpricedRequests: 0,
			recentRequests: 1,
			lastUsed: 1,
			requestShare: 1,
			tokenShare: 1,
			recentShare: 1,
			servingNow: true,
			servedLatestNewSession: false,
			quotas: [
				{
					limitId: "x",
					label: "x",
					windowLabel: null,
					status: null,
					resetsAt: null,
					recordedAt: 1,
					usedFraction: 0.2,
				},
			],
			status: "active",
			blocks: [],
		};
		const a = { accounts: [account], unattributed: [], providerTotals: [], routing: [] };
		const b = {
			...a,
			accounts: [
				{
					...account,
					status: "blocked" as const,
					quotas: [{ ...account.quotas[0], recordedAt: 2, usedFraction: 0.8 }],
				},
			],
		};
		const result = mergeAccounts([
			{ machine: "a", data: a },
			{ machine: "b", data: b },
		]);
		expect(result.accounts[0].requests).toBe(4);
		expect(result.accounts[0].quotas[0].usedFraction).toBe(0.8);
		expect(result.machineAccounts[1].account.status).toBe("blocked");
		expect(mergeAccounts([{ machine: "a", data: a }]).accounts[0].requests).toBe(2);
	});
	it("marks only the account serving the newest session for each provider", () => {
		const account = (key: string, latest: boolean) => ({
			key,
			provider: "p",
			servedLatestNewSession: latest,
			requests: 1,
			failedRequests: 0,
			totalTokens: 1,
			totalCost: 1,
			unpricedRequests: 0,
			recentRequests: 1,
			lastUsed: 1,
			quotas: [],
			servingNow: false,
		});
		const data = (key: string, at: number) =>
			({
				accounts: [account("a", key === "a"), account("b", key === "b")],
				unattributed: [],
				providerTotals: [],
				routing: [
					{
						provider: "p",
						recent: { windowMs: 1, requests: 1, accounts: [{ accountKey: key, requests: 1, share: 1 }] },
						newSessions: {
							windowMs: 1,
							sessions: 1,
							accounts: [{ accountKey: key, sessions: 1 }],
							lastAccount: key,
							lastAccountSince: at,
							latest: { accountKey: key, at },
						},
						lastAssignmentChange: null,
					},
				],
			}) as unknown as AccountDashboardStats;
		const result = mergeAccounts([
			{ machine: "server", data: data("a", 10) },
			{ machine: "mini", data: data("b", 20) },
		]);
		expect(result.accounts.filter(account => account.servedLatestNewSession).map(account => account.key)).toEqual([
			"b",
		]);
	});
	it("preserves local hourly histograms and merges provider series", () => {
		const p: ProviderDashboardStats = {
			providers: [],
			hourly: [{ provider: "p", hour: 1, totalTokens: 5, outputTokens: 1, requests: 1 }],
			series: [{ timestamp: 1, provider: "p", totalTokens: 5, cost: 1, unpricedRequests: 0, requests: 1 }],
		};
		const result = mergeProviders([
			{ machine: "a", data: p },
			{ machine: "b", data: p },
		]);
		expect(result.hourly).toEqual([]);
		expect(result.hourlyByMachine).toHaveLength(2);
		expect(result.series[0].totalTokens).toBe(10);
		expect(mergeProviders([{ machine: "a", data: p }]).series[0].requests).toBe(1);
	});
	it("sorts machine-labelled requests, errors and traces", () => {
		const rows = [
			{ machine: "a", data: [{ timestamp: 1 } as MessageStats] },
			{ machine: "b", data: [{ timestamp: 3 } as MessageStats] },
		];
		expect(mergeRequests(rows, 1)[0].machine).toBe("b");
		expect(mergeErrors(rows.slice(0, 1))[0].timestamp).toBe(1);
		expect(
			mergeTraces([
				{ machine: "a", data: [{ endedAt: 1 } as SessionSummary] },
				{ machine: "b", data: [{ endedAt: 2 } as SessionSummary] },
			])[0].machine,
		).toBe("b");
	});
	it("preserves machine states and derives fleet activity from summed traffic", () => {
		const target = {
			key: "p:a",
			provider: "p",
			kind: "account",
			label: "a",
			meta: null,
			state: "quiet",
			quotaWarning: false,
			rpm: 0,
			tpm: 0,
			last: 1,
			quotas: [],
			breakdown: null,
		} as LiveTrafficStats["targets"][number];
		const data = (state: typeof target.state, rpm: number): LiveTrafficStats => ({
			now: 1,
			windowMs: 60_000,
			flowWindowMs: 300_000,
			sessions: [],
			targets: [{ ...target, state, rpm, tpm: rpm * 20 }],
			edges: [],
			recent: [],
		});
		const merge = (server: LiveTrafficStats, mini: LiveTrafficStats) =>
			mergeLive([
				{ machine: "server", data: server },
				{ machine: "mini", data: mini },
			]).targets[0];
		const active = merge(data("quiet", 0), data("active", 5));
		expect(active.states).toEqual({ server: "quiet", mini: "active" });
		expect(active.state).toBe("active");
		expect(active.rpm).toBe(5);
		expect(active.tpm).toBe(100);
		expect(merge(data("quiet", 0), data("active", 0)).state).toBe("quiet");
		expect(merge(data("needs_login", 0), data("active", 5)).state).toBe("needs_login");
		expect(merge(data("needs_login", 0), data("rate_limited", 5)).state).toBe("rate_limited");
		expect(merge(data("removed", 0), data("removed", 0)).state).toBe("removed");
		expect(merge(data("removed", 0), data("quiet", 0)).state).toBe("quiet");
	});
	it("prefixes live session references and caps recent traffic", () => {
		const data = {
			now: 1,
			windowMs: 60,
			flowWindowMs: 300,
			sessions: [{ id: "s" }],
			targets: [],
			edges: [{ from: "s", to: "t" }],
			recent: Array.from({ length: 20 }, (_, ts) => ({ ts, session: "s" })),
		} as unknown as LiveTrafficStats;
		const result = mergeLive([
			{ machine: "a", data },
			{ machine: "b", data },
		]);
		expect(result.sessions[0].id).toBe("a:s");
		expect(result.edges[1].from).toBe("b:s");
		expect(result.recent).toHaveLength(25);
		expect(mergeLive([{ machine: "a", data }]).sessions).toHaveLength(1);
	});
});
