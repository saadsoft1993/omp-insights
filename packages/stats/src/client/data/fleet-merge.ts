import type {
	AccountDashboardStats,
	AccountFlowStats,
	AccountQuotaWindow,
	AccountStats,
	AggregatedStats,
	CostDashboardStats,
	FolderStats,
	FrustrationCounts,
	FrustrationDashboardStats,
	GainDashboardStats,
	GainSourceTotals,
	LiveTrafficStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	ProviderDashboardStats,
	ProviderHourlyPoint,
	SessionSummary,
	ToolDashboardStats,
} from "../types";
import { compareSessionEnd } from "./session-rows";

export type MachineAnswer<T> = { machine: string; data: T };
export type HomeAnswer<T> = MachineAnswer<T> & { home: string | null };

function group<T>(rows: T[], key: (row: T) => string, merge: (a: T, b: T) => T): T[] {
	const result = new Map<string, T>();
	for (const row of rows) {
		const k = key(row);
		const previous = result.get(k);
		result.set(k, previous === undefined ? row : merge(previous, row));
	}
	return [...result.values()];
}

function add<T>(a: T, b: T, fields: readonly string[]): T {
	const result = { ...a } as T;
	const out = result as Record<string, unknown>;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	for (const field of fields) out[field] = Number(left[field] ?? 0) + Number(right[field] ?? 0);
	return result;
}

function weighted(a: number | null, an: number, b: number | null, bn: number): number | null {
	const left = a == null ? 0 : an || 0;
	const right = b == null ? 0 : bn || 0;
	return left + right ? ((a ?? 0) * left + (b ?? 0) * right) / (left + right) : null;
}

const aggregateFields = [
	"totalRequests",
	"successfulRequests",
	"failedRequests",
	"totalInputTokens",
	"totalOutputTokens",
	"totalCacheReadTokens",
	"totalCacheWriteTokens",
	"totalCost",
	"unpricedRequests",
	"totalPremiumRequests",
	"durationN",
	"ttftN",
	"tpsN",
	"noCacheInputCost",
	"cachedPromptCost",
];
function mergeAggregate<T extends AggregatedStats>(a: T, b: T): T {
	const r = add(a, b, aggregateFields);
	r.avgDuration = weighted(a.avgDuration, a.durationN, b.avgDuration, b.durationN);
	r.avgTtft = weighted(a.avgTtft, a.ttftN, b.avgTtft, b.ttftN);
	r.avgTokensPerSecond = weighted(a.avgTokensPerSecond, a.tpsN, b.avgTokensPerSecond, b.tpsN);
	const prompt = r.totalInputTokens + r.totalCacheReadTokens;
	r.cacheRate = prompt ? r.totalCacheReadTokens / prompt : 0;
	r.errorRate = r.totalRequests ? r.failedRequests / r.totalRequests : 0;
	r.cacheSavings = r.noCacheInputCost ? (r.noCacheInputCost - r.cachedPromptCost) / r.noCacheInputCost : 0;
	r.firstTimestamp = Math.min(a.firstTimestamp, b.firstTimestamp);
	r.lastTimestamp = Math.max(a.lastTimestamp, b.lastTimestamp);
	return r;
}
const key = (...parts: unknown[]) => JSON.stringify(parts);
const byTime = <T extends { timestamp: number }>(a: T, b: T) => a.timestamp - b.timestamp;

const attributionFields = [
	"totalRequests",
	"totalInputTokens",
	"totalOutputTokens",
	"totalCacheReadTokens",
	"totalCacheWriteTokens",
	"totalCost",
];
export function mergeOverview(answers: OverviewStats[]): OverviewStats {
	return {
		overall: answers.map(x => x.overall).reduce(mergeAggregate),
		byAgentType: group(
			answers.flatMap(x => x.byAgentType),
			x => x.agentType,
			(a, b) => add(a, b, attributionFields),
		),
		bySideChannel: group(
			answers.flatMap(x => x.bySideChannel ?? []),
			x => key(x.category, x.decision),
			(a, b) => add(a, b, attributionFields),
		),
		timeSeries: group(
			answers.flatMap(x => x.timeSeries),
			x => String(x.timestamp),
			(a, b) =>
				add(a, b, [
					"requests",
					"errors",
					"tokens",
					"cost",
					"durationN",
					"ttftN",
					"tpsN",
					"noCacheInputCost",
					"cachedPromptCost",
				]),
		).sort(byTime),
	};
}
export function mergeModels(answers: ModelDashboardStats[]): ModelDashboardStats {
	return {
		byModel: group(
			answers.flatMap(x => x.byModel),
			x => key(x.model, x.provider),
			mergeAggregate,
		),
		modelSeries: group(
			answers.flatMap(x => x.modelSeries),
			x => key(x.timestamp, x.model, x.provider),
			(a, b) => add(a, b, ["requests"]),
		).sort(byTime),
		modelPerformanceSeries: group(
			answers.flatMap(x => x.modelPerformanceSeries),
			x => key(x.timestamp, x.model, x.provider),
			(a, b) => ({
				...add(a, b, ["requests", "ttftN", "tpsN"]),
				avgTtft: weighted(a.avgTtft, a.ttftN, b.avgTtft, b.ttftN),
				avgTokensPerSecond: weighted(a.avgTokensPerSecond, a.tpsN, b.avgTokensPerSecond, b.tpsN),
			}),
		).sort(byTime),
	};
}
export function mergeCosts(answers: CostDashboardStats[]): CostDashboardStats {
	return {
		costSeries: group(
			answers.flatMap(x => x.costSeries),
			x => key(x.timestamp, x.model, x.provider),
			(a, b) =>
				add(a, b, [
					"cost",
					"unpricedRequests",
					"costInput",
					"costOutput",
					"costCacheRead",
					"costCacheWrite",
					"requests",
				]),
		).sort(byTime),
	};
}
export function mergeTools(answers: ToolDashboardStats[]): ToolDashboardStats {
	const fields = [
		"calls",
		"errors",
		"argsChars",
		"resultChars",
		"totalTokensShare",
		"outputTokensShare",
		"costShare",
		"unpricedRequestsShare",
	];
	const combine = <T extends { lastUsed: number }>(a: T, b: T): T => ({
		...add(a, b, fields),
		lastUsed: Math.max(a.lastUsed, b.lastUsed),
	});
	return {
		byTool: group(
			answers.flatMap(x => x.byTool),
			x => x.tool,
			combine,
		),
		byToolModel: group(
			answers.flatMap(x => x.byToolModel),
			x => key(x.tool, x.model, x.provider),
			combine,
		),
		series: group(
			answers.flatMap(x => x.series),
			x => key(x.timestamp, x.tool),
			(a, b) => add(a, b, ["calls", "errors"]),
		).sort(byTime),
	};
}
export function normalizeHome(path: string, home: string | null): string {
	if (!home) return path;
	const prefix = home.replace(/\/+$/, "");
	return prefix && (path === prefix || path.startsWith(`${prefix}/`)) ? `~${path.slice(prefix.length)}` : path;
}
export function mergeProjects(answers: HomeAnswer<FolderStats[]>[]): FolderStats[] {
	return group(
		answers.flatMap(x => x.data.map(row => ({ ...row, folder: normalizeHome(row.folder, x.home) }))),
		x => x.folder,
		mergeAggregate,
	);
}
function mergeGainTotals(a: GainSourceTotals, b: GainSourceTotals): GainSourceTotals {
	const r = add(a, b, ["savedTokens", "savedBytes", "hits", "outputBytes", "originalBytes"]);
	r.reductionPercent = r.originalBytes ? r.savedBytes / r.originalBytes : null;
	return r;
}
/** Overall totals: a machine whose savings have no known original size (null with hits) keeps the fleet's null. */
function mergeGainOverall(a: GainSourceTotals, b: GainSourceTotals): GainSourceTotals {
	const r = mergeGainTotals(a, b);
	const unknown = (t: GainSourceTotals) => t.hits > 0 && t.reductionPercent === null;
	return unknown(a) || unknown(b) ? { ...r, outputBytes: 0, originalBytes: 0, reductionPercent: null } : r;
}
export function mergeGain(answers: HomeAnswer<GainDashboardStats>[]): GainDashboardStats {
	return {
		overall: answers.map(x => x.data.overall).reduce(mergeGainOverall),
		bySource: {
			snapcompact: answers.map(x => x.data.bySource.snapcompact).reduce(mergeGainTotals),
			compaction: answers.map(x => x.data.bySource.compaction).reduce(mergeGainTotals),
		},
		timeSeries: group(
			answers.flatMap(x => x.data.timeSeries),
			x => x.date,
			(a, b) => add(a, b, ["snapcompact", "compaction", "total"]),
		).sort((a, b) => a.date.localeCompare(b.date)),
		project: answers[0]?.data.project ? normalizeHome(answers[0].data.project, answers[0].home) : null,
		projects: [...new Set(answers.flatMap(x => x.data.projects.map(p => normalizeHome(p, x.home))))].sort(),
	};
}
const frustrationFields = ["messages", "judged", "annoyed", "atAssistant", "angry"];
export function mergeFrustration(answers: FrustrationDashboardStats[]): FrustrationDashboardStats {
	return {
		...answers[0],
		overall: answers.map(x => x.overall).reduce((a, b) => add<FrustrationCounts>(a, b, frustrationFields)),
		byModel: group(
			answers.flatMap(x => x.byModel),
			x => x.key,
			(a, b) => ({
				...add(a, b, frustrationFields),
				models: [...new Set([...a.models, ...b.models])],
				firstSeen: Math.min(a.firstSeen, b.firstSeen),
			}),
		),
		judgeAvailable: false,
	};
}

function latestQuotas(rows: AccountQuotaWindow[]): AccountQuotaWindow[] {
	return group(
		rows,
		x => x.limitId,
		(a, b) => (b.recordedAt > a.recordedAt ? b : a),
	).sort((a, b) => b.recordedAt - a.recordedAt);
}
export function mergeAccounts(
	answers: MachineAnswer<AccountDashboardStats>[],
): AccountDashboardStats & { machineAccounts: { machine: string; account: AccountStats }[] } {
	const machineAccounts = answers.flatMap(x => x.data.accounts.map(account => ({ machine: x.machine, account })));
	const accounts = group(
		machineAccounts.map(x => ({ ...x.account })),
		x => x.key,
		(a, b) => ({
			...add(a, b, ["requests", "failedRequests", "totalTokens", "totalCost", "unpricedRequests", "recentRequests"]),
			lastUsed: Math.max(a.lastUsed ?? 0, b.lastUsed ?? 0) || null,
			quotas: latestQuotas([...a.quotas, ...b.quotas]),
			servingNow: a.servingNow || b.servingNow,
		}),
	);
	const unattributed = group(
		answers.flatMap(x => x.data.unattributed),
		x => x.provider,
		(a, b) => ({
			...add(a, b, ["requests", "failedRequests", "totalTokens", "totalCost", "unpricedRequests"]),
			lastUsed: Math.max(a.lastUsed ?? 0, b.lastUsed ?? 0) || null,
		}),
	);
	const providerTotals = group(
		answers.flatMap(x => x.data.providerTotals),
		x => x.provider,
		(a, b) => add(a, b, ["requests", "accountRequests", "unattributedRequests"]),
	);
	const routing = group(
		answers.flatMap(x => x.data.routing),
		x => x.provider,
		(a, b) => {
			const recentAccounts = group(
				[...a.recent.accounts, ...b.recent.accounts],
				x => x.accountKey,
				(p, q) => add(p, q, ["requests"]),
			);
			const requests = a.recent.requests + b.recent.requests;
			const sessions = a.newSessions.sessions + b.newSessions.sessions;
			const latest =
				(a.newSessions.latest?.at ?? 0) >= (b.newSessions.latest?.at ?? 0)
					? a.newSessions.latest
					: b.newSessions.latest;
			return {
				...a,
				recent: {
					...a.recent,
					requests,
					accounts: recentAccounts
						.map(x => ({ ...x, share: requests ? x.requests / requests : 0 }))
						.sort((p, q) => q.requests - p.requests),
				},
				newSessions: {
					...a.newSessions,
					sessions,
					accounts: group(
						[...a.newSessions.accounts, ...b.newSessions.accounts],
						x => x.accountKey,
						(p, q) => add(p, q, ["sessions"]),
					),
					latest,
					lastAccount: latest?.accountKey ?? null,
					lastAccountSince:
						latest === a.newSessions.latest ? a.newSessions.lastAccountSince : b.newSessions.lastAccountSince,
				},
				lastAssignmentChange:
					(a.lastAssignmentChange?.at ?? 0) >= (b.lastAssignmentChange?.at ?? 0)
						? a.lastAssignmentChange
						: b.lastAssignmentChange,
			};
		},
	);
	for (const account of accounts) {
		const siblings = accounts.filter(x => x.provider === account.provider);
		const requests = siblings.reduce((n, x) => n + x.requests, 0);
		const tokens = siblings.reduce((n, x) => n + x.totalTokens, 0);
		const recent = siblings.reduce((n, x) => n + x.recentRequests, 0);
		account.servedLatestNewSession = routing.some(
			x => x.provider === account.provider && x.newSessions.latest?.accountKey === account.key,
		);
		account.requestShare = requests ? account.requests / requests : 0;
		account.tokenShare = tokens ? account.totalTokens / tokens : 0;
		account.recentShare = recent ? account.recentRequests / recent : 0;
	}
	return { accounts, unattributed, providerTotals, routing, machineAccounts };
}
export function mergeAccountFlow(answers: AccountFlowStats[]): AccountFlowStats {
	return {
		series: group(
			answers.flatMap(x => x.series),
			x => x.key,
			a => a,
		),
		points: group(
			answers.flatMap(x => x.points),
			x => key(x.timestamp, x.key),
			(a, b) => add(a, b, ["requests", "tokens"]),
		).sort(byTime),
	};
}
export function mergeProviders(
	answers: MachineAnswer<ProviderDashboardStats>[],
): ProviderDashboardStats & { hourlyByMachine: { machine: string; hourly: ProviderHourlyPoint[] }[] } {
	return {
		providers: group(
			answers.flatMap(x => x.data.providers),
			x => x.provider,
			(a, b) => ({
				...add(a, b, [
					"totalRequests",
					"failedRequests",
					"totalInputTokens",
					"totalOutputTokens",
					"totalCacheReadTokens",
					"totalCacheWriteTokens",
					"totalTokens",
					"totalCost",
					"unpricedRequests",
					"totalPremiumRequests",
					"tpsN",
				]),
				models: Math.max(a.models, b.models),
				avgTokensPerSecond: weighted(a.avgTokensPerSecond, a.tpsN, b.avgTokensPerSecond, b.tpsN),
			}),
		),
		hourly: [],
		hourlyByMachine: answers.map(x => ({ machine: x.machine, hourly: x.data.hourly })),
		series: group(
			answers.flatMap(x => x.data.series),
			x => key(x.timestamp, x.provider),
			(a, b) => add(a, b, ["totalTokens", "cost", "unpricedRequests", "requests"]),
		).sort(byTime),
	};
}
export function mergeRequests(
	answers: MachineAnswer<MessageStats[]>[],
	limit = 50,
): (MessageStats & { machine: string })[] {
	return answers
		.flatMap(x => x.data.map(row => ({ ...row, machine: x.machine })))
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, limit);
}
export const mergeErrors = mergeRequests;
export function mergeTraces(
	answers: MachineAnswer<SessionSummary[]>[],
	limit = 100,
): (SessionSummary & { machine: string })[] {
	return answers
		.flatMap(x => x.data.map(row => ({ ...row, machine: x.machine })))
		.sort(compareSessionEnd)
		.slice(0, limit);
}
export function mergeLive(answers: MachineAnswer<LiveTrafficStats>[]): LiveTrafficStats & {
	sessions: (LiveTrafficStats["sessions"][number] & { machine: string })[];
	targets: (LiveTrafficStats["targets"][number] & {
		states: Record<string, LiveTrafficStats["targets"][number]["state"]>;
	})[];
} {
	const first = answers[0].data;
	const targets = group(
		answers.flatMap(x => x.data.targets.map(target => ({ ...target, states: { [x.machine]: target.state } }))),
		x => x.key,
		(a, b) => ({
			...a,
			states: { ...a.states, ...b.states },
			rpm: a.rpm + b.rpm,
			tpm: a.tpm + b.tpm,
			last: Math.max(a.last ?? 0, b.last ?? 0) || null,
			quotas: latestQuotas([...a.quotas, ...b.quotas]),
			quotaWarning: a.quotaWarning || b.quotaWarning,
			breakdown:
				a.breakdown && b.breakdown
					? {
							housekeeping: a.breakdown.housekeeping + b.breakdown.housekeeping,
							turns: a.breakdown.turns + b.breakdown.turns,
							purposes: group(
								[...a.breakdown.purposes, ...b.breakdown.purposes],
								x => x.purpose,
								(p, q) => add(p, q, ["requests"]),
							),
						}
					: (a.breakdown ?? b.breakdown),
		}),
	);
	for (const target of targets) {
		const states = Object.values(target.states);
		target.state = states.includes("rate_limited")
			? "rate_limited"
			: states.includes("needs_login")
				? "needs_login"
				: states.every(state => state === "removed")
					? "removed"
					: target.rpm > 0
						? "active"
						: "quiet";
	}
	return {
		...first,
		now: Math.max(...answers.map(x => x.data.now)),
		sessions: answers.flatMap(x =>
			x.data.sessions.map(s => ({ ...s, id: `${x.machine}:${s.id}`, machine: x.machine })),
		),
		targets,
		edges: answers.flatMap(x => x.data.edges.map(e => ({ ...e, from: `${x.machine}:${e.from}` }))),
		recent: answers
			.flatMap(x => x.data.recent.map(r => ({ ...r, session: `${x.machine}:${r.session}` })))
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 25),
	};
}
