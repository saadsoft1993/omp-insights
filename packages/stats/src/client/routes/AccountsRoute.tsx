import { useMemo, useState } from "react";
import { getAccountDashboardStats, getAccountFlowStats } from "../api";
import { useHiddenSeries } from "../charts";
import {
	formatCompact,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import type {
	AccountQuotaWindow,
	AccountStats,
	AccountStatus,
	ProviderAccountTotals,
	TimeRange,
	UnattributedUsage,
} from "../types";
import {
	Badge,
	Card,
	ChartSkeleton,
	type Column,
	Dot,
	EmptyState,
	LabelCell,
	MeterCell,
	PageHeader,
	QueryView,
	Segmented,
	Stat,
	StatGrid,
	Table,
	TableSkeleton,
	type Tone,
} from "../ui";
import {
	AccountFlowChart,
	FLOW_OPTIONS,
	type FlowMetric,
	flowProviders,
	RoutingLine,
	useAccountPalette,
} from "./AccountRouting";
import "./accounts.css";

export interface AccountsRouteProps {
	active: boolean;
	range: TimeRange;
}

const STATUS: Record<AccountStatus, { label: string; tone: Tone; rank: number }> = {
	needs_login: { label: "Needs login", tone: "bad", rank: 4 },
	blocked: { label: "Blocked", tone: "warn", rank: 3 },
	active: { label: "Active", tone: "ok", rank: 2 },
	idle: { label: "Idle", tone: "neutral", rank: 1 },
	never: { label: "Never used", tone: "neutral", rank: 0 },
};

const NOT_TIED_HINT =
	"Requests no stored credential is recorded for: background calls such as titles, memory and judges; API keys from the environment; gateways; and sessions from before turns recorded their credential.";

/** One provider's range total, split into requests on accounts and requests not tied to one; matches the Providers page. */
function ProviderTotalsLine({ totals }: { totals: ProviderAccountTotals }) {
	return (
		<div className="account-reconcile">
			<span className="mono cell-primary">{totals.provider}:</span>
			<span className="num">{formatInteger(totals.requests)}</span>
			<span className="muted">requests =</span>
			<span className="num">{formatInteger(totals.accountRequests)}</span>
			<span className="muted">on accounts +</span>
			<span className="num">{formatInteger(totals.unattributedRequests)}</span>
			<span className="muted">not tied to an account</span>
			{totals.unattributedRequests > 0 && (
				<span className="dim">(background calls such as titles, memory, judges; API keys; gateways)</span>
			)}
		</div>
	);
}

export function AccountsRoute({ active, range }: AccountsRouteProps) {
	const stats = useQuery(["accounts", range], ({ signal }) => getAccountDashboardStats(range, signal), {
		enabled: active,
	});
	const flow = useQuery(["account-flow", range], ({ signal }) => getAccountFlowStats(range, signal), {
		enabled: active,
	});
	const [metric, setMetric] = useState<FlowMetric>("requests");
	const [hidden, toggleHidden] = useHiddenSeries();
	const palette = useAccountPalette(stats.data, flow.data);
	const meta = rangeMeta(range);

	const totals = useMemo(() => {
		const t = { accounts: 0, active: 0, attention: 0, tokens: 0, cost: 0, unpriced: 0, onAccounts: 0, notTied: 0 };
		for (const a of stats.data?.accounts ?? []) {
			t.accounts++;
			if (a.status === "active") t.active++;
			if (a.status === "blocked" || a.status === "needs_login") t.attention++;
			t.tokens += a.totalTokens;
			t.cost += a.totalCost;
			t.unpriced += a.unpricedRequests;
		}
		for (const p of stats.data?.providerTotals ?? []) {
			t.onAccounts += p.accountRequests;
			t.notTied += p.unattributedRequests;
		}
		return t;
	}, [stats.data]);
	const allRequests = totals.onAccounts + totals.notTied;

	return (
		<div className="page">
			<PageHeader
				title="Accounts"
				description={`Which stored credential served each request over ${meta.windowLabel}, merged per account.`}
			/>

			<QueryView query={stats} skeleton={<ChartSkeleton height={112} />}>
				{() => (
					<div data-stale={stats.stale}>
						<StatGrid min={190}>
							<Stat
								label="Accounts"
								value={formatInteger(totals.accounts)}
								hint={
									totals.attention > 0
										? `${formatInteger(totals.active)} active · ${formatInteger(totals.attention)} need attention`
										: `${formatInteger(totals.active)} active in the last 24h`
								}
							/>
							<Stat
								label="Requests on accounts"
								title="Same range and source as the Providers page total"
								value={formatInteger(totals.onAccounts)}
								hint={
									allRequests > 0
										? `of ${formatInteger(allRequests)} requests (${formatPercent(totals.onAccounts / allRequests, 0)}) tied to an account`
										: undefined
								}
							/>
							<Stat
								label="Tokens on accounts"
								title="Uncached input + cache reads + cache writes + output"
								value={formatCompact(totals.tokens)}
							/>
							<Stat
								label="API-equivalent cost"
								title="What the usage on accounts would cost at public API rates"
								value={formatEstimatedCost(totals.cost, totals.unpriced)}
								hint={totals.unpriced > 0 ? `${formatInteger(totals.unpriced)} unpriced` : undefined}
							/>
							<Stat
								label="Not tied to an account"
								title={NOT_TIED_HINT}
								value={formatInteger(totals.notTied)}
								hint={
									allRequests > 0
										? `${formatPercent(totals.notTied / allRequests, 0)} of all requests`
										: undefined
								}
							/>
						</StatGrid>
					</div>
				)}
			</QueryView>

			<Card
				index={1}
				title="Traffic split"
				description="Measured share of each account's requests over the last 15 minutes. omp keeps a session on one credential but can rotate it, so the split is the only reliable view of current routing. New-session lines show which account first served recent main sessions (subagents follow their parent) and are historical observations."
				stale={stats.stale}
			>
				<QueryView query={stats} skeleton={<ChartSkeleton height={48} />}>
					{({ routing, providerTotals }) => (
						<div className="stack" style={{ gap: 14 }}>
							{providerTotals.length > 0 && (
								<div className="stack" style={{ gap: 6 }}>
									<div className="section-label" style={{ marginBottom: 0 }}>
										Requests in {meta.windowLabel}
									</div>
									{providerTotals.map(p => (
										<ProviderTotalsLine key={p.provider} totals={p} />
									))}
								</div>
							)}
							{routing.length === 0 ? (
								<EmptyState title="No requests on accounts in the last hour" />
							) : (
								<div className="stack" style={{ gap: 10 }}>
									{routing.map(r => (
										<RoutingLine key={r.provider} routing={r} palette={palette} detailed />
									))}
								</div>
							)}
						</div>
					)}
				</QueryView>
			</Card>

			<Card
				index={2}
				title="Traffic by account"
				description={`Per ${meta.bucketMs < 3_600_000 ? "5 minutes" : meta.bucketMs < 86_400_000 ? "hour" : "day"}, accounts stacked per provider; requests not tied to an account stay separate as Unattributed`}
				actions={<Segmented size="sm" options={FLOW_OPTIONS} value={metric} onChange={setMetric} />}
				stale={flow.stale}
			>
				<QueryView query={flow} skeleton={<ChartSkeleton height={220} />}>
					{data => {
						const providers = flowProviders(data);
						if (providers.length === 0) return <EmptyState title="No traffic in this range" />;
						return (
							<div className="stack" style={{ gap: 20 }}>
								{providers.map(provider => (
									<div key={provider} className="stack" style={{ gap: 8 }}>
										<div className="section-label mono" style={{ marginBottom: 0 }}>
											{provider}
										</div>
										<AccountFlowChart
											flow={data}
											provider={provider}
											range={range}
											metric={metric}
											palette={palette}
											height={200}
											hidden={hidden}
											onToggle={toggleHidden}
										/>
									</div>
								))}
							</div>
						);
					}}
				</QueryView>
			</Card>

			<Card
				index={3}
				title="Accounts"
				description="Credentials with the same provider, email and organization are one account. Status ignores the range: active means a request in the last 24 hours. Select a row for its quota windows."
				flush
				stale={stats.stale}
			>
				<QueryView query={stats} skeleton={<TableSkeleton rows={4} />}>
					{({ accounts, providerTotals }) => (
						<>
							{providerTotals.some(p => p.accountRequests > 0) && (
								<div className="account-reconcile-header">
									{providerTotals
										.filter(p => p.accountRequests > 0)
										.map(p => (
											<ProviderTotalsLine key={p.provider} totals={p} />
										))}
								</div>
							)}
							<AccountsTable accounts={accounts} />
						</>
					)}
				</QueryView>
			</Card>

			<Card index={4} title="Not tied to an account" description={NOT_TIED_HINT} flush stale={stats.stale}>
				<QueryView query={stats} skeleton={<TableSkeleton rows={3} />}>
					{({ unattributed }) => <UnattributedTable rows={unattributed} />}
				</QueryView>
			</Card>
		</div>
	);
}

function statusTitle(account: AccountStats): string | undefined {
	if (account.status === "needs_login") return account.disabledCause ?? "Every stored credential is disabled";
	if (account.blocks.length === 0) return undefined;
	return account.blocks
		.map(block => `${block.scope || "all models"} until ${new Date(block.until).toLocaleString()}`)
		.join("\n");
}

/** Highest used fraction across an account's latest quota readings. */
function peakQuota(quotas: readonly AccountQuotaWindow[]): number | null {
	let peak: number | null = null;
	for (const q of quotas) if (q.usedFraction !== null) peak = Math.max(peak ?? 0, q.usedFraction);
	return peak;
}

function quotaColor(fraction: number): string {
	return fraction >= 0.999 ? "var(--bad)" : fraction >= 0.8 ? "var(--warn)" : "var(--ok)";
}

function AccountsTable({ accounts }: { accounts: AccountStats[] }) {
	const [open, setOpen] = useState<string | null>(null);
	const columns = useMemo<Column<AccountStats>[]>(() => {
		let maxRequests = 0;
		let maxTokens = 0;
		for (const a of accounts) {
			maxRequests = Math.max(maxRequests, a.requests);
			maxTokens = Math.max(maxTokens, a.totalTokens);
		}
		return [
			{
				key: "account",
				header: "Account",
				sort: a => a.label,
				render: a => (
					<LabelCell
						primary={<span title={a.orgId ? `org ${a.orgId}` : undefined}>{a.label}</span>}
						secondary={
							<span className="mono">
								{a.provider} · #{a.credentialIds.join(", #")}
							</span>
						}
					/>
				),
			},
			{
				key: "status",
				header: "Status",
				sort: a => STATUS[a.status].rank,
				render: a => (
					<span title={statusTitle(a)}>
						<Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
					</span>
				),
			},
			{
				key: "now",
				header: "Now",
				title: "Share of the provider's requests in the last 15 minutes, and whether this account served the first request of the latest new main session",
				sort: a => (a.servedLatestNewSession ? 2 : 0) + a.recentShare,
				render: a => (
					<span className="row" style={{ gap: 8 }}>
						{a.servingNow ? (
							<span
								className="row"
								style={{ gap: 6 }}
								title={`${formatInteger(a.recentRequests)} requests in the last 15 minutes`}
							>
								<Dot tone="live" pulse />
								<span className="num">{formatPercent(a.recentShare, 0)}</span>
							</span>
						) : (
							<span className="dim">–</span>
						)}
						{a.servedLatestNewSession && <Badge tone="accent">Latest new session</Badge>}
					</span>
				),
			},
			{
				key: "requests",
				header: "Requests",
				align: "right",
				sort: a => a.requests,
				render: a => <MeterCell value={a.requests} max={maxRequests} display={formatInteger(a.requests)} />,
			},
			{
				key: "share",
				header: "Share",
				title: "Fraction of the provider's attributed requests in range",
				align: "right",
				sort: a => a.requestShare,
				render: a => <span className="num muted">{formatPercent(a.requestShare)}</span>,
			},
			{
				key: "tokens",
				header: "Tokens",
				title: "Uncached input + cache reads + cache writes + output",
				align: "right",
				sort: a => a.totalTokens,
				render: a => <MeterCell value={a.totalTokens} max={maxTokens} display={formatCompact(a.totalTokens)} />,
			},
			{
				key: "cost",
				header: "Cost",
				title: "API-equivalent estimate",
				align: "right",
				sort: a => a.totalCost,
				render: a => (
					<span
						className="num"
						title={a.unpricedRequests > 0 ? `${formatInteger(a.unpricedRequests)} unpriced` : undefined}
					>
						{formatEstimatedCost(a.totalCost, a.unpricedRequests)}
					</span>
				),
			},
			{
				key: "quota",
				header: "Quota",
				title: "Highest used fraction across the account's latest quota readings",
				align: "right",
				sort: a => peakQuota(a.quotas) ?? -1,
				render: a => {
					const peak = peakQuota(a.quotas);
					return peak === null ? (
						<span className="dim">–</span>
					) : (
						<MeterCell value={peak} max={1} display={formatPercent(peak, 0)} color={quotaColor(peak)} />
					);
				},
			},
			{
				key: "last",
				header: "Last used",
				align: "right",
				sort: a => a.lastUsed ?? 0,
				render: a => <span className="muted">{a.lastUsed ? formatRelativeTime(a.lastUsed) : "never"}</span>,
			},
		];
	}, [accounts]);

	return (
		<Table
			rows={accounts}
			rowKey={a => a.key}
			columns={columns}
			initialSort={{ key: "requests", dir: "desc" }}
			selectedKey={open}
			onRowClick={a => setOpen(prev => (prev === a.key ? null : a.key))}
			expanded={a => (a.key === open ? <QuotaWindows account={a} /> : null)}
			empty={
				<EmptyState
					title="No accounts yet"
					hint="Accounts appear once a stored credential serves a request or is logged in."
				/>
			}
		/>
	);
}

function QuotaWindows({ account }: { account: AccountStats }) {
	if (account.quotas.length === 0) {
		return (
			<div className="accounts-quotas">
				<span className="dim">
					No quota readings in the last 7 days. Readings are recorded whenever usage limits are fetched (TUI
					footer, /usage, omp usage).
				</span>
			</div>
		);
	}
	return (
		<div className="accounts-quotas">
			{account.quotas.map(q => (
				<div key={q.limitId} className="accounts-quota">
					<span className="truncate" title={q.limitId}>
						{q.label}
					</span>
					{q.usedFraction === null ? (
						<span className="dim">–</span>
					) : (
						<MeterCell
							value={q.usedFraction}
							max={1}
							display={formatPercent(q.usedFraction, 0)}
							color={quotaColor(q.usedFraction)}
						/>
					)}
					<span className="muted">{q.resetsAt ? `resets ${formatRelativeTime(q.resetsAt)}` : ""}</span>
					<span className="dim">read {formatRelativeTime(q.recordedAt)}</span>
				</div>
			))}
		</div>
	);
}

const UNATTRIBUTED_COLUMNS: Column<UnattributedUsage>[] = [
	{
		key: "provider",
		header: "Provider",
		sort: u => u.provider,
		render: u => <span className="mono cell-primary">{u.provider}</span>,
	},
	{
		key: "requests",
		header: "Requests",
		align: "right",
		sort: u => u.requests,
		render: u => <span className="num">{formatInteger(u.requests)}</span>,
	},
	{
		key: "tokens",
		header: "Tokens",
		title: "Uncached input + cache reads + cache writes + output",
		align: "right",
		sort: u => u.totalTokens,
		render: u => <span className="num">{formatCompact(u.totalTokens)}</span>,
	},
	{
		key: "cost",
		header: "Cost",
		title: "API-equivalent estimate",
		align: "right",
		sort: u => u.totalCost,
		render: u => <span className="num">{formatEstimatedCost(u.totalCost, u.unpricedRequests)}</span>,
	},
	{
		key: "last",
		header: "Last request",
		align: "right",
		sort: u => u.lastUsed ?? 0,
		render: u => <span className="muted">{u.lastUsed ? formatRelativeTime(u.lastUsed) : "–"}</span>,
	},
];

function UnattributedTable({ rows }: { rows: UnattributedUsage[] }) {
	return (
		<Table
			rows={rows}
			rowKey={u => u.provider}
			columns={UNATTRIBUTED_COLUMNS}
			initialSort={{ key: "requests", dir: "desc" }}
			empty={<EmptyState title="Every request in this range is tied to an account" />}
		/>
	);
}
