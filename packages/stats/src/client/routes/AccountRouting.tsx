/**
 * Account routing pieces shared by the Accounts page and the Overview card:
 * one line per provider with the measured request split of the last minutes
 * and which account first served recent new main sessions, and the
 * per-provider stacked traffic chart.
 */
import { format } from "@oh-my-pi/pi-utils/dates";
import { useMemo } from "react";
import { Legend, TimeChart } from "../charts";
import { buildColorLookup, OTHER_COLOR } from "../data/colors";
import { formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { bucketAxis, rangeMeta } from "../data/range";
import { pivotSeries } from "../data/series";
import type { AccountDashboardStats, AccountFlowStats, ProviderRouting, TimeRange } from "../types";
import { Swatch } from "../ui";
import "./accounts.css";

export type FlowMetric = "requests" | "tokens";

export const FLOW_OPTIONS = [
	{ value: "requests" as const, label: "Requests" },
	{ value: "tokens" as const, label: "Tokens" },
];

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

function formatClock(timestamp: number): string {
	const sameDay = new Date(timestamp).toDateString() === new Date().toDateString();
	return format(new Date(timestamp), sameDay ? "HH:mm" : "MMM d HH:mm");
}

/**
 * One provider's routing: the measured request split over the trailing
 * window first (the only view of current routing), then which account was
 * observed serving the first request of recent new main sessions.
 */
export function RoutingLine({
	routing,
	palette,
	detailed,
}: {
	routing: ProviderRouting;
	palette: AccountPalette;
	/** Also show the latest observed change of the new-session account. */
	detailed?: boolean;
}) {
	const { recent, newSessions, lastAssignmentChange } = routing;
	const recentMinutes = Math.round(recent.windowMs / 60_000);
	return (
		<div className="account-routing">
			<span className="mono cell-primary account-routing-provider">{routing.provider}</span>
			<div className="account-routing-body">
				<span className="account-routing-part">
					<span className="muted">last {recentMinutes} min:</span>
					{recent.requests === 0 ? (
						<span className="dim">no requests</span>
					) : (
						recent.accounts.map((share, i) => (
							<span key={share.accountKey} className="account-routing-share">
								{i > 0 && <span className="dim">·</span>}
								<Swatch color={palette.color(share.accountKey)} />
								<span>{palette.label(share.accountKey)}</span>
								<span className="num">{formatPercent(share.share, 0)}</span>
							</span>
						))
					)}
				</span>
				<span className="account-routing-part">
					{newSessions.latest === null ? (
						<span className="dim">no new main session in this range</span>
					) : (
						<>
							<span className="muted">latest new session started on</span>
							<Swatch color={palette.color(newSessions.latest.accountKey)} />
							<span>{palette.label(newSessions.latest.accountKey)}</span>
							<span className="muted">at {formatClock(newSessions.latest.at)}</span>
						</>
					)}
				</span>
				{newSessions.sessions > 0 && (
					<span className="account-routing-part dim">
						{`${formatInteger(newSessions.sessions)} new session${newSessions.sessions === 1 ? "" : "s"} in the last hour: ${newSessions.accounts
							.map(a => `${palette.label(a.accountKey)} ${formatInteger(a.sessions)}`)
							.join(", ")}`}
					</span>
				)}
				{detailed && lastAssignmentChange && (
					<span className="account-routing-part dim">
						new-session assignment last changed {palette.label(lastAssignmentChange.fromAccountKey)} →{" "}
						{palette.label(lastAssignmentChange.toAccountKey)} at {formatClock(lastAssignmentChange.at)}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * Providers with traffic on at least one stored account in the flow, busiest
 * first; providers seen only as unattributed traffic have no split to chart.
 */
export function flowProviders(flow: AccountFlowStats | null): string[] {
	const totals = new Map<string, number>();
	const withAccount = new Set<string>();
	const providerOf = new Map((flow?.series ?? []).map(s => [s.key, s.provider]));
	for (const series of flow?.series ?? []) if (series.accountKey !== null) withAccount.add(series.provider);
	for (const point of flow?.points ?? []) {
		const provider = providerOf.get(point.key);
		if (provider !== undefined) totals.set(provider, (totals.get(provider) ?? 0) + point.requests);
	}
	return [...totals]
		.filter(([provider, requests]) => requests > 0 && withAccount.has(provider))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([provider]) => provider);
}

/** Stacked traffic per account for one provider over the range, unattributed as its own series. */
export function AccountFlowChart({
	flow,
	provider,
	range,
	metric,
	palette,
	height,
	hidden,
	onToggle,
}: {
	flow: AccountFlowStats;
	provider: string;
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
		const keys = new Set(flow.series.filter(s => s.provider === provider).map(s => s.key));
		const points = flow.points.filter(p => keys.has(p.key));
		const buckets = bucketAxis(
			range,
			points.map(p => p.timestamp),
		);
		const colors = new Map([...keys].map(key => [key, palette.color(key)]));
		const values = pivotSeries(points, {
			buckets,
			key: p => p.key,
			label: palette.label,
			value: p => (metric === "tokens" ? p.tokens : p.requests),
			colors,
		}).map(s => ({ ...s, values: s.values.map(v => v || null) }));
		return { buckets, values };
	}, [flow, provider, range, metric, palette]);
	const valueFormat = metric === "tokens" ? formatCompact : formatInteger;
	return (
		<div className="stack" style={{ gap: 12 }}>
			<TimeChart
				buckets={series.buckets}
				bucketMs={meta.bucketMs}
				series={series.values}
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
