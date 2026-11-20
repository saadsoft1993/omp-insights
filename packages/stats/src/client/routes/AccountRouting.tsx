/** Account traffic charts and labels for the Accounts page. */
import { useMemo } from "react";
import { Legend, TimeChart } from "../charts";
import { buildColorLookup, OTHER_COLOR } from "../data/colors";
import { formatCompact, formatInteger } from "../data/formatters";
import { bucketAxis, rangeMeta } from "../data/range";
import { pivotSeries } from "../data/series";
import type { AccountDashboardStats, AccountFlowStats, TimeRange } from "../types";
import "./accounts.css";

export type FlowMetric = "requests" | "tokens";

/** Labels and colors per account key (flow series keys included), stable across a page's charts and lines. */
export interface AccountPalette {
	label(key: string): string;
	color(key: string): string;
}

export function useAccountPalette(stats: AccountDashboardStats | null, flow: AccountFlowStats | null): AccountPalette {
	return useMemo(() => {
		const labels = new Map<string, string>();
		for (const series of flow?.series ?? []) labels.set(series.key, series.label);
		for (const account of stats?.accounts ?? []) labels.set(account.key, account.label);
		const colors = buildColorLookup((stats?.accounts ?? []).map(a => ({ key: a.key, weight: a.requests })));
		return {
			label: key => labels.get(key) ?? key,
			color: key => colors.get(key) ?? OTHER_COLOR,
		};
	}, [stats, flow]);
}

/** One line per account across all providers, excluding unattributed traffic. */
export function AccountFlowChart({
	flow,
	range,
	metric,
	palette,
	height,
	hidden,
	onToggle,
}: {
	flow: AccountFlowStats;
	range: TimeRange;
	metric: FlowMetric;
	palette: AccountPalette;
	height: number;
	hidden?: ReadonlySet<string>;
	/** Show a toggleable legend under the chart. */
	onToggle?: (key: string) => void;
}) {
	const meta = rangeMeta(range);
	const series = useMemo(() => {
		const accountKeys = new Map(
			flow.series.filter(s => s.accountKey !== null).map(s => [s.key, s.accountKey as string]),
		);
		const points = flow.points.filter(p => accountKeys.has(p.key));
		const buckets = bucketAxis(
			range,
			points.map(p => p.timestamp),
		);
		const colors = new Map([...accountKeys.values()].map(key => [key, palette.color(key)]));
		const values = pivotSeries(points, {
			buckets,
			key: p => accountKeys.get(p.key) as string,
			label: palette.label,
			value: p => (metric === "tokens" ? p.tokens : p.requests),
			colors,
		}).map((s, index) => ({ ...s, dashed: index % 2 === 1, values: s.values.map(v => v || null) }));
		return { buckets, values };
	}, [flow, range, metric, palette]);
	const valueFormat = metric === "tokens" ? formatCompact : formatInteger;
	return (
		<div className="stack" style={{ gap: 12 }}>
			<TimeChart
				buckets={series.buckets}
				bucketMs={meta.bucketMs}
				series={series.values}
				kind="line"
				stacked={false}
				hidden={hidden}
				height={height}
				format={formatCompact}
				formatTooltip={valueFormat}
				emptyLabel="No traffic in this range"
			/>
			{onToggle && (
				<Legend
					items={series.values.map(s => ({
						key: s.key,
						label: s.label,
						color: s.color,
						value: valueFormat(s.values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
					}))}
					hidden={hidden}
					onToggle={onToggle}
				/>
			)}
		</div>
	);
}
