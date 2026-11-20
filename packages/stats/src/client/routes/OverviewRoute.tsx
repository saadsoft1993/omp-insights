import { ALL_MACHINES, concreteMachine, useSelectedMachine } from "../app/machine";
import { MissingMachineNumbers } from "../app/MachineBanner";
import { fleetQueryView, useFleetQuery } from "../data/fleet-query";
import { mergeOverview } from "../data/fleet-merge";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { getOverviewStats } from "../api";
import { Legend, ShareBar, TimeChart } from "../charts";
import {
	formatCompact,
	formatDurationMs,
	formatErrorRate,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatTokensPerSecond,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { bucketAxis, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import { buildAgentTokenShare, sumConversationTokens } from "../data/view-models";
import type { AgentType, TimeRange } from "../types";
import { Card, ChartSkeleton, PageHeader, QueryView, Segmented, Stat, StatGrid } from "../ui";

export interface OverviewRouteProps {
	active: boolean;
	range: TimeRange;
	onRequestClick: (id: number, machine?: string) => void;
}

type ActivityMetric = "requests" | "tokens" | "cost";

const ACTIVITY_OPTIONS = [
	{ value: "requests" as const, label: "Requests" },
	{ value: "tokens" as const, label: "Tokens" },
	{ value: "cost" as const, label: "Cost" },
];

const AGENT_LABEL: Record<AgentType, string> = { main: "Main agent", subagent: "Subagents", advisor: "Advisor" };
const AGENT_COLOR: Record<AgentType, string> = {
	main: "var(--chart-primary)",
	subagent: "var(--chart-secondary)",
	advisor: "#9d7bff",
};

const TOKEN_MIX = [
	{ key: "input", label: "Uncached input", color: "#5b8cff" },
	{ key: "cacheRead", label: "Cache read", color: "var(--chart-primary)" },
	{ key: "cacheWrite", label: "Cache write", color: "#f5b54a" },
	{ key: "output", label: "Output", color: "var(--chart-secondary)" },
] as const;

export function OverviewRoute({ active, range }: OverviewRouteProps) {
	const allMachines = useSelectedMachine() === ALL_MACHINES;
	const singleOverview = useQuery(
		["overview", range],
		({ signal }) => getOverviewStats(range, signal, concreteMachine()),
		{ enabled: active && !allMachines },
	);
	const fleetOverview = useFleetQuery(
		["overview", range],
		(machine, signal) => getOverviewStats(range, signal, machine),
		mergeOverview,
		{ enabled: active && allMachines },
	);
	const overview = allMachines ? fleetQueryView(singleOverview, fleetOverview) : singleOverview;
	const [metric, setMetric] = useState<ActivityMetric>("requests");
	const meta = rangeMeta(range);

	const series = useMemo(() => {
		const points = overview.data?.timeSeries ?? [];
		const buckets = bucketAxis(
			range,
			points.map(p => p.timestamp),
		);
		return {
			buckets,
			requests: densify(points, buckets, p => p.requests - p.errors),
			errors: densify(points, buckets, p => p.errors),
			tokens: densify(points, buckets, p => p.tokens),
			cost: densify(points, buckets, p => p.cost),
			all: densify(points, buckets, p => p.requests),
		};
	}, [overview.data, range]);

	const chartSeries =
		metric === "requests"
			? [
					{ key: "ok", label: "Succeeded", color: "var(--chart-primary)", values: series.requests },
					{ key: "err", label: "Failed", color: "var(--bad)", values: series.errors },
				]
			: metric === "tokens"
				? [{ key: "tokens", label: "Tokens", color: "var(--chart-primary)", values: series.tokens }]
				: [{ key: "cost", label: "API-equivalent", color: "var(--chart-secondary)", values: series.cost }];

	return (
		<div className="page">
			{allMachines && <MissingMachineNumbers machines={fleetOverview.machines} />}
			<PageHeader title="Overview" description={`Everything omp did across your sessions in ${meta.windowLabel}.`} />

			<QueryView query={overview} skeleton={<ChartSkeleton height={112} />}>
				{({ overall }) => (
					<div data-stale={overview.stale} className="stack" style={{ gap: 16 }}>
						<StatGrid min={190}>
							<Stat
								label="API-equivalent cost"
								title="What this usage would cost at public API rates"
								value={formatEstimatedCost(overall.totalCost, overall.unpricedRequests)}
								hint={
									overall.unpricedRequests > 0
										? `${formatInteger(overall.unpricedRequests)} unpriced`
										: undefined
								}
								spark={series.cost}
								sparkColor="var(--chart-secondary)"
							/>
							<Stat
								label="Requests"
								value={formatInteger(overall.totalRequests)}
								hint={`${formatInteger(overall.failedRequests)} failed`}
								spark={series.all}
							/>
							<Stat
								label="Conversation tokens"
								title="Uncached input + cache reads + cache writes + output"
								value={formatCompact(sumConversationTokens(overall))}
								hint={`${formatCompact(overall.totalOutputTokens)} output`}
								spark={series.tokens}
							/>
							<Stat
								label="Cache rate"
								title="Cache reads ÷ (uncached input + cache reads)"
								value={formatPercent(overall.cacheRate)}
								hint={`${formatPercent(overall.cacheSavings)} saved`}
							/>
							<Stat
								label="Error rate"
								value={formatErrorRate(overall.errorRate)}
								hint={`${formatInteger(overall.successfulRequests)} succeeded`}
								spark={series.errors}
								sparkColor="var(--bad)"
							/>
						</StatGrid>
						<StatGrid min={140}>
							<Stat size="sm" label="Uncached input" value={formatCompact(overall.totalInputTokens)} />
							<Stat size="sm" label="Cache read" value={formatCompact(overall.totalCacheReadTokens)} />
							<Stat size="sm" label="Cache write" value={formatCompact(overall.totalCacheWriteTokens)} />
							<Stat size="sm" label="Output" value={formatCompact(overall.totalOutputTokens)} />
							<Stat
								size="sm"
								label="Premium requests"
								value={formatInteger(Math.round(overall.totalPremiumRequests * 100) / 100)}
							/>
							<Stat size="sm" label="Tokens/s" value={formatTokensPerSecond(overall.avgTokensPerSecond)} />
							<Stat size="sm" label="Avg latency" value={formatDurationMs(overall.avgDuration)} />
							<Stat size="sm" label="Avg TTFT" value={formatDurationMs(overall.avgTtft)} />
						</StatGrid>
					</div>
				)}
			</QueryView>

			<div className="grid grid-main-side">
				<Card
					index={1}
					title="Activity"
					description={`Per ${meta.bucketMs < 3_600_000 ? "5 minutes" : meta.bucketMs < 86_400_000 ? "hour" : "day"}`}
					actions={<Segmented size="sm" options={ACTIVITY_OPTIONS} value={metric} onChange={setMetric} />}
					stale={overview.stale}
				>
					<QueryView hideError query={overview} skeleton={<ChartSkeleton height={260} />}>
						{() => (
							<TimeChart
								buckets={series.buckets}
								bucketMs={meta.bucketMs}
								series={chartSeries}
								height={260}
								format={metric === "cost" ? v => formatEstimatedCost(v, 0) : formatCompact}
							/>
						)}
					</QueryView>
				</Card>

				<Card index={2} title="Token mix" description="Where conversation tokens went" stale={overview.stale}>
					<QueryView hideError query={overview} skeleton={<ChartSkeleton height={260} />}>
						{({ overall, byAgentType }) => {
							const mix = {
								input: overall.totalInputTokens,
								cacheRead: overall.totalCacheReadTokens,
								cacheWrite: overall.totalCacheWriteTokens,
								output: overall.totalOutputTokens,
							};
							const total = sumConversationTokens(overall);
							const agents = buildAgentTokenShare(byAgentType);
							return (
								<div className="stack" style={{ gap: 18 }}>
									<div className="stack" style={{ gap: 10 }}>
										<ShareBar
											segments={TOKEN_MIX.map(t => ({
												key: t.key,
												label: t.label,
												value: mix[t.key],
												color: t.color,
											}))}
										/>
										<Legend
											items={TOKEN_MIX.map(t => ({
												key: t.key,
												label: t.label,
												color: t.color,
												value: total > 0 ? formatPercent(mix[t.key] / total, 0) : "–",
											}))}
										/>
									</div>
									<div className="stack" style={{ gap: 10 }}>
										<div className="section-label" style={{ marginBottom: 0 }}>
											By agent
										</div>
										<ShareBar
											segments={agents.segments.map(s => ({
												key: s.agentType,
												label: AGENT_LABEL[s.agentType],
												value: s.tokens,
												color: AGENT_COLOR[s.agentType],
											}))}
										/>
										{agents.segments.map(s => (
											<div key={s.agentType} className="row" style={{ justifyContent: "space-between" }}>
												<span className="row">
													<span className="swatch" style={{ background: AGENT_COLOR[s.agentType] }} />
													{AGENT_LABEL[s.agentType]}
													<span className="dim num">{formatInteger(s.requests)} req</span>
												</span>
												<span className="row">
													<span className="dim num">{formatCompact(s.tokens)}</span>
													<span className="num" style={{ minWidth: 48, textAlign: "right" }}>
														{formatPercent(s.share)}
													</span>
												</span>
											</div>
										))}
									</div>
								</div>
							);
						}}
					</QueryView>
				</Card>
			</div>

			<div className="row">
				<a className="btn" data-size="sm" data-variant="ghost" href={`#/accounts?range=${range}`}>
					Accounts &amp; quota <ArrowRight size={13} />
				</a>
				<a className="btn" data-size="sm" data-variant="ghost" href={`#/requests?range=${range}`}>
					All requests <ArrowRight size={13} />
				</a>
			</div>
		</div>
	);
}
