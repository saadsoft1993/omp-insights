import { useMemo, useState } from "react";
import { Chart, Sparkline, type ChartSeries } from "../../charts";
import { getHubReport } from "../../data/hub";
import { useQuery } from "../../data/query";
import {
	Badge,
	Card,
	EmptyState,
	PageHeader,
	QueryView,
	SearchInput,
	Segmented,
	Skeleton,
	Stat,
	StatGrid,
	Table,
	type Column,
} from "../../ui";
import type { ControlCenterRouteProps } from "../controlCenter";
import {
	addDays,
	awsModel,
	callouts,
	explain,
	money,
	pivot,
	pivotCsv,
	recoverable,
	shortName,
	total,
	usageRows,
	type AwsData,
	type AwsModel,
	type AwsResource,
	type PivotGroup,
	type PivotOptions,
	type PivotRow,
	type ServiceRow,
} from "./awsModel";
import "./aws.css";

const colors = [
	"var(--chart-primary)",
	"#e78039",
	"#35a778",
	"#dbb039",
	"#c66d9c",
	"#5b9f48",
	"#8e7bd0",
	"#d35b5b",
	"#8a939b",
];
const monthLabel = (m: string) =>
	new Date(m + "T00:00:00Z").toLocaleString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
const cash = (n: number) => money(n);
const stringColumn = <T,>(key: string, header: string, fn: (r: T) => string): Column<T> => ({
	key,
	header,
	render: fn,
	sort: fn,
});
const amountColumn = <T,>(key: string, header: string, fn: (r: T) => number): Column<T> => ({
	key,
	header,
	align: "right",
	render: r => money(fn(r)),
	sort: fn,
});
const tableEmpty = <EmptyState title="No data" />;

export default function AwsRoute({ active, params, setParams }: ControlCenterRouteProps) {
	const query = useQuery(["hub-report", "aws"], ({ signal }) => getHubReport<AwsData>("aws", signal), {
		enabled: active,
		scope: "local",
	});
	const notBuilt = !!query.error && /404|not built yet/i.test(query.error.message);
	return (
		<div className="page aws-page">
			<PageHeader title="AWS costs" description="Usage before credits, billed amounts and resource estimates." />
			{notBuilt && !query.data ? (
				<EmptyState title="Report not built yet" hint="The AWS report has not been built on this hub." />
			) : (
				<QueryView query={query} skeleton={<Skeleton height={180} />}>
					{data => <AwsScreen data={data} params={params} setParams={setParams} />}
				</QueryView>
			)}
		</div>
	);
}
function AwsScreen({
	data,
	params,
	setParams,
}: {
	data: AwsData;
	params: Readonly<Record<string, string>>;
	setParams: ControlCenterRouteProps["setParams"];
}) {
	const view = data.accounts.some(a => a.key === params.view) ? params.view : "all";
	const model = useMemo(() => awsModel(data, view), [data, view]);
	const groups: PivotGroup[] = ["Project", "Client", "Environment", "Service"];
	const group = groups.includes(params.group as PivotGroup) ? (params.group as PivotGroup) : "Client";
	const splitOptions =
		group === "Service" ? ["none", "account", "Project", "Client", "Environment"] : ["service", "account", "none"];
	const split = splitOptions.includes(params.split) ? params.split : splitOptions[0];
	const opts: PivotOptions = { group, split, months: params.months === "6" ? 6 : 13 };
	const p = useMemo(() => pivot(model, opts), [model, group, split, opts.months]);
	const [pvOpen, setPvOpen] = useState(""),
		[svcOpen, setSvcOpen] = useState("");
	const [status, setStatus] = useState("all"),
		[kind, setKind] = useState("all"),
		[search, setSearch] = useState("");
	const accountName = (key: string) => data.accounts.find(a => a.key === key)?.label || key;
	const globalTotals: Record<string, number> = {};
	for (const a of data.accounts)
		for (const m of Object.values(a.costs.monthly))
			for (const [s, v] of Object.entries(m)) globalTotals[s] = (globalTotals[s] || 0) + v;
	const top = Object.keys(globalTotals)
		.sort((a, b) => globalTotals[b] - globalTotals[a])
		.slice(0, 8);
	const monthly = model.months.map(m => model.sumBy("monthly", m));
	const series: ChartSeries[] = top.map((s, i) => ({
		key: s,
		label: shortName(s),
		color: colors[i],
		values: monthly.map(m => m[s] || 0),
	}));
	series.push({
		key: "other",
		label: "Other",
		color: colors[8],
		values: monthly.map(m =>
			Object.entries(m)
				.filter(([s]) => !top.includes(s))
				.reduce((t, [, v]) => t + v, 0),
		),
	});
	series.push({
		key: "billed",
		label: "Billed",
		color: "var(--text)",
		kind: "dots",
		values: model.months.map((m, i) => {
			const b = model.billed("monthly", m);
			return Math.abs(b - total(monthly[i])) >= 0.5 ? b : null;
		}),
	});
	series.push({
		key: "forecast",
		label: "Forecast",
		color: "var(--text-muted)",
		kind: "line",
		dashed: true,
		values: model.months.map((_, i) => (i === 11 ? total(monthly[i]) : i === 12 ? model.forecast : null)),
	});
	const days = Array.from({ length: 91 }, (_, i) => addDays(data.today, i - 90)),
		daily = days.map(d => {
			const x = model.sumBy("daily", d);
			delete x.Tax;
			return x;
		});
	const pseries: ChartSeries[] = p.rows.map((r, i) => ({
		key: r.g,
		label: r.g,
		color: colors[i % colors.length],
		values: r.per,
	}));
	const pivotCols: Column<PivotRow>[] = [
		{ key: "name", header: group, render: r => (r.g === "\u0000total" ? "Total" : r.g) },
		...p.months.map((m, i) => ({
			key: m,
			header: monthLabel(m),
			align: "right" as const,
			render: (r: PivotRow) => money(r.per[i]),
		})),
		{ key: "total", header: "Total", align: "right", render: r => money(r.tot) },
	];
	const svcCols: Column<ServiceRow>[] = [
		stringColumn("svc", "Service", r => shortName(r.svc)),
		stringColumn("acc", "Account", r => accountName(r.acc)),
		amountColumn("last", "Last month", r => r.last),
		amountColumn("mtd", "So far", r => r.mtd),
		amountColumn("rr", "Run-rate / mo", r => r.rr),
		{ key: "change", header: "Change", render: r => (r.change == null ? "–" : `${Math.round(r.change * 100)}%`) },
		{ key: "history", header: "13 months", render: r => <Sparkline values={r.spark} /> },
		{
			key: "trend",
			header: "Trend",
			render: r =>
				r.trend ? (
					<Badge tone={r.trend === "up" || r.trend === "new" ? "warn" : "ok"}>
						{({ up: "growing", down: "shrinking", new: "new", gone: "gone" } as Record<string, string>)[r.trend]}
					</Badge>
				) : null,
		},
	];
	const visible = model.resources
		.filter(
			r =>
				(status === "all" || r.status === status) &&
				(kind === "all" || r.kind === kind) &&
				(!search ||
					[r.name, r.id, r.project, r.evidence].join(" ").toLowerCase().includes(search.toLowerCase().trim())),
		)
		.sort((a, b) => (b.monthly || 0) - (a.monthly || 0));
	const resourceCols: Column<AwsResource>[] = [
		{
			key: "status",
			header: "Status",
			render: r => (
				<Badge tone={r.status === "dead" ? "bad" : r.status === "idle" ? "warn" : "ok"}>{r.status}</Badge>
			),
		},
		stringColumn("kind", "Type", r => r.kind),
		stringColumn("name", "Name", r => r.name),
		stringColumn("account", "Account", r => accountName(r.account)),
		stringColumn("region", "Region", r => r.region),
		stringColumn("project", "Project", r => r.project || ""),
		{
			key: "monthly",
			header: "Est. / mo",
			align: "right",
			render: r => (r.monthly == null ? "In bundle" : money(r.monthly)),
			sort: r => r.monthly,
		},
		stringColumn("evidence", "Evidence", r => [r.state, r.evidence, r.action].filter(Boolean).join(" · ")),
		stringColumn("since", "Since", r => r.since || ""),
	];
	const csv = () => {
		const url = URL.createObjectURL(new Blob([pivotCsv(p, opts)], { type: "text/csv" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `aws-cost-by-${group.toLowerCase()}-${view}-${data.today}.csv`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	};
	const hasAdjustments = model.accounts.some(a =>
		model.months.some(m => Math.abs(model.adjustment(a, "monthly", m)) >= 0.01),
	);
	const lastBilled = model.billed("monthly", model.last);
	const change = model.lastTotal ? ((model.forecast ?? model.rr) - model.lastTotal) / model.lastTotal : 0;
	const changeLabel =
		change >= 4 ? `×${Math.round(change + 1)}` : `${change > 0 ? "+" : ""}${Math.round(change * 100)}%`;
	return (
		<>
			<div className="aws-controls">
				<Segmented
					aria-label="Account"
					value={view}
					options={[
						{ value: "all", label: "Both accounts" },
						...data.accounts.map(a => ({ value: a.key, label: a.label })),
					]}
					onChange={v => setParams({ view: v })}
				/>
				<span>Collected {data.generated}</span>
			</div>
			<Card index={1} title="Headlines">
				<StatGrid>
					<Stat
						label="This month so far"
						value={money(model.mtd, 0)}
						hint={`${Number(data.today.slice(8, 10))} days in${hasAdjustments ? " · usage before credits" : ""}`}
					/>
					{hasAdjustments && (
						<Stat
							label="Credits this month"
							value={money(
								total(model.sumBy("credits_monthly", model.cur)) +
									total(model.sumBy("refunds_monthly", model.cur)),
								0,
							)}
							hint="paid by AWS credits / refunds"
						/>
					)}
					<Stat
						label="Billed so far"
						value={money(model.billed("monthly", model.cur), 0)}
						hint={`after credits, incl. RI fees · ${monthLabel(model.last)} ${money(lastBilled, 0)}`}
					/>
					{model.grants.length > 0 && (
						<Stat
							label="Credit left"
							value={money(model.creditLeft, 0)}
							hint={`${model.monthsLeft == null ? "" : `≈${model.monthsLeft} months at run-rate · `}expires ${model.grants.map(g => g.end).sort()[0]}`}
						/>
					)}
					<Stat
						label="Forecast month-end"
						value={model.forecast == null ? "–" : money(model.forecast, 0)}
						hint={`AWS forecast${hasAdjustments ? " of usage" : ""} · ${changeLabel} vs ${monthLabel(model.last)}`}
					/>
					<Stat
						label="Last month"
						value={money(model.lastTotal, 0)}
						hint={`${monthLabel(model.last)}${Math.abs(lastBilled - model.lastTotal) >= 0.5 ? ` · billed ${money(lastBilled, 0)}` : ""}`}
					/>
					<Stat label="Run-rate / month" value={money(model.rr, 0)} hint="last 7 complete days × 30 + tax" />
					<Stat
						label="On dead + idle / mo"
						value={money(model.wasteTotal, 0)}
						hint={`${model.waste.length} resources · estimate`}
					/>
				</StatGrid>
				<div className="aws-notes">
					{callouts(model, view).map(n => (
						<div key={n.title}>
							<h4>{n.title}</h4>
							<p>{n.text}</p>
						</div>
					))}
				</div>
			</Card>
			<Card
				index={2}
				title="Credits and what is actually billed"
				description="Usage before credits, promotional credits and refunds, and the unblended invoice."
			>
				{model.accounts.map(a => (
					<CreditSection key={a.key} model={model} account={a} />
				))}
			</Card>
			<Card
				index={3}
				title="Month by month"
				description="Monthly usage by service; dots mark billed amounts, dashed line shows forecast."
			>
				<Chart
					slots={model.months.length}
					tickLabel={i => monthLabel(model.months[i])}
					series={series}
					height={270}
					format={cash}
				/>
				<div className="aws-legend">
					{series.map(s => (
						<span key={s.key}>
							<i style={{ background: s.color }} />
							{s.label}
						</span>
					))}
				</div>
			</Card>
			<Card
				index={4}
				title="Monthly cost by project, client and environment"
				description="Tags are not retroactive; amounts are usage before credits."
			>
				<div className="aws-controls">
					<Segmented
						aria-label="Group by"
						options={groups.map(g => ({ value: g, label: g }))}
						value={group}
						onChange={g => setParams({ group: g, split: null })}
					/>
					<Segmented
						aria-label="Break down by"
						options={splitOptions.map(s => ({
							value: s,
							label: s === "none" ? "Nothing" : s === "service" ? "Service" : s === "account" ? "Account" : s,
						}))}
						value={split}
						onChange={s => setParams({ split: s })}
					/>
					<Segmented
						aria-label="Months"
						options={[
							{ value: "6", label: "Last 6" },
							{ value: "13", label: "Last 13" },
						]}
						value={String(opts.months)}
						onChange={v => setParams({ months: v })}
					/>
					<button className="btn" type="button" onClick={csv}>
						Download CSV
					</button>
				</div>
				<Chart slots={p.months.length} tickLabel={i => monthLabel(p.months[i])} series={pseries} format={cash} />
				{p.missing.length > 0 && <p>{p.missing.join(", ")} has no tag; costs are untagged.</p>}
				{p.duplicates.map(d => (
					<p key={d.join()}>Same value tagged differently: {d.join(" / ")}</p>
				))}
				{Object.keys(p.aliases).length > 0 && (
					<p>
						Old spellings merged:{" "}
						{Object.entries(p.aliases)
							.map(([k, v]) => `${k} → ${v}`)
							.join(" · ")}
					</p>
				)}
				<Table
					rows={[...p.rows, { g: "\u0000total", per: p.totals, tot: p.totals.reduce((a, b) => a + b, 0) }]}
					rowKey={r => r.g}
					columns={pivotCols}
					onRowClick={r => {
						if (r.g !== "\u0000total") setPvOpen(pvOpen === r.g ? "" : r.g);
					}}
					expanded={r =>
						pvOpen === r.g ? (
							<div className="aws-detail">
								<Table
									rows={Object.entries(p.data[r.g])
										.filter(([k]) => k)
										.map(([g, vs]) => {
											const per = p.months.map(m => vs[m] || 0);
											return { g, per, tot: per.reduce((a, b) => a + b, 0) };
										})
										.filter(x => Math.abs(x.tot) >= 0.01)
										.sort((a, b) => b.tot - a.tot)}
									rowKey={x => x.g}
									columns={pivotCols}
								/>
							</div>
						) : null
					}
					empty={tableEmpty}
				/>
			</Card>
			<Card
				index={5}
				title="Daily spend"
				description="90 days of usage, excluding tax; recent days may be incomplete."
			>
				<Chart
					slots={days.length}
					tickLabel={i => days[i].slice(5)}
					tooltipTitle={i => days[i]}
					series={[{ key: "usage", label: "Usage", color: colors[0], values: daily.map(total) }]}
					format={cash}
					tooltipExtra={i => (
						<>
							{Object.entries(daily[i])
								.sort((a, b) => b[1] - a[1])
								.slice(0, 5)
								.map(([s, v]) => (
									<div className="chart-tooltip-row" key={s}>
										<span>{shortName(s)}</span>
										<span>{money(v)}</span>
									</div>
								))}
						</>
					)}
				/>
			</Card>
			<Card index={6} title="Where the money goes, by service" description="Select a service for its usage types.">
				<Table
					rows={model.rows}
					rowKey={r => `${r.acc}:${r.svc}`}
					columns={svcCols}
					onRowClick={r => {
						const k = `${r.acc}:${r.svc}`;
						setSvcOpen(svcOpen === k ? "" : k);
					}}
					expanded={r =>
						svcOpen === `${r.acc}:${r.svc}` ? (
							<div className="aws-detail">
								{usageRows(model, r)
									.slice(0, 25)
									.map(u => (
										<div key={u.u}>
											<strong>{u.u}</strong> {explain(u.u)} · last {money(u.last)} · so far {money(u.mtd)} ·
											run-rate {money(u.rr)}
										</div>
									))}
							</div>
						) : null
					}
					empty={tableEmpty}
				/>
			</Card>
			<Card index={7} title="By project and by region">
				<div className="aws-two">
					<Breakdown model={model} tag />
					<Breakdown model={model} />
				</div>
			</Card>
			<Card index={8} title="Dead and idle — money to recover">
				<Reservations model={model} />
				{model.waste.length === 0 ? (
					<EmptyState title="Nothing dead or idle was found" />
				) : (
					<div className="aws-waste">
						{model.waste.map((r, i) => (
							<article key={`${r.account}:${r.id}:${i}`}>
								<strong>{r.name}</strong>
								<span>{r.monthly == null ? "–" : money(recoverable(r))}/mo</span>
								<p>
									<Badge tone={r.status === "dead" ? "bad" : "warn"}>{r.status}</Badge> {r.kind} ·{" "}
									{accountName(r.account)} · {r.region}
								</p>
								<p>{r.evidence}</p>
								{r.action && <p>{r.action}</p>}
							</article>
						))}
					</div>
				)}
			</Card>
			<Card
				index={9}
				title="Everything that exists right now"
				description={`${visible.length} of ${model.resources.length} resources · ≈${money(
					visible.reduce((t, r) => t + (r.monthly || 0), 0),
					0,
				)}/mo`}
			>
				<div className="aws-controls">
					<Segmented
						aria-label="Status"
						value={status}
						options={["all", "live", "idle", "dead"].map(s => ({
							value: s,
							label: s[0].toUpperCase() + s.slice(1),
						}))}
						onChange={setStatus}
					/>
					<label>
						Type{" "}
						<select value={kind} onChange={e => setKind(e.target.value)}>
							<option value="all">All types</option>
							{[...new Set(model.resources.map(r => r.kind))].sort().map(k => (
								<option key={k}>{k}</option>
							))}
						</select>
					</label>
					<SearchInput value={search} onChange={setSearch} placeholder="Name, ID, project" />
				</div>
				<Table
					rows={visible}
					rowKey={r => `${r.account}:${r.kind}:${r.id}`}
					columns={resourceCols}
					limit={50}
					empty={<EmptyState title="No resources match" />}
				/>
			</Card>
			<Card index={10} title="Method and limits">
				<ul>
					<li>
						<strong>Monthly by tag</strong> (section 04) is one Cost Explorer call per tag key over 13 months,
						grouped by tag value and service. Two tags cannot be crossed in one view (Cost Explorer groups by at
						most two dimensions), so a breakdown is always by service or account, or a service broken down by one
						tag.
					</li>
					<li>
						<strong>Service, usage-type, region and tag amounts are exact</strong> — unblended cost straight from
						Cost Explorer, including tax, <strong>before credits and refunds</strong> (record types Credit and
						Refund are excluded and collected separately).
					</li>
					<li>
						<strong>Usage is amortized</strong> — a Reserved Instance's monthly fee is spread over the hours it
						covers (AmortizedCost). For a completed month it equals the bill before credits; in the current month
						the bill is higher early on because AWS charges the RI fee on the 1st. <strong>Billed</strong> is
						always the unblended invoice amount after credits.
					</li>
					<li>
						<strong>Credits and refunds are exact</strong> — Cost Explorer record types Credit / Refund, by month,
						day and service. Billed = usage + credits + refunds for a completed month. The forecast is of usage,
						because credits can run out without notice. Credit balances and expiry come from the Billing API (
						<code>aws billing get-credits</code>); that needs IAM access to billing to be activated on the
						account.
					</li>
					<li>
						<strong>Per-resource monthly figures are estimates.</strong> Resource-level billing is not enabled on
						either account, so they come from on-demand list prices × 730 hours plus storage. They exclude data
						transfer and request charges and ignore Savings Plans or credits.
					</li>
					<li>
						<strong>Idle</strong> means average CPU under 3% over the last {data.lookback_days} days (unless the
						box moves real traffic, like a NAT instance), or a database with at most one connection;{" "}
						<strong>dead</strong> means stopped, detached, zero connections or zero healthy targets. Check before
						deleting — a quiet disaster-recovery box looks exactly like a dead one.
					</li>
					<li>
						<strong>Refreshed daily at 07:30</strong> by <code>automation/aws_costs/daily.py</code>. Each refresh
						makes about 20 Cost Explorer calls plus about 9 for verification, which AWS bills at $0.01 each
						(≈$9/month). Problems (failed refresh or verification, credits stopping or running low) are sent as a
						Slack DM.
					</li>
					<li>
						Read-only, with one exception: the daily job keeps the Project, Client and Environment cost-allocation
						tags activated in Billing. Nothing else is changed.
					</li>
				</ul>
			</Card>
		</>
	);
}
function CreditSection({ model, account: a }: { model: AwsModel; account: AwsData["accounts"][number] }) {
	const rows = [...model.months].reverse().map(m => {
		const usage = total(a.costs.monthly[m] || {}),
			credits = total(a.costs.credits_monthly?.[m] || {}),
			refunds = total(a.costs.refunds_monthly?.[m] || {});
		return { m, usage, credits, refunds, billed: a.costs.billed_monthly?.[m] ?? usage + credits + refunds };
	});
	const cols = [
		stringColumn<(typeof rows)[number]>("m", "Month", r => monthLabel(r.m)),
		amountColumn<(typeof rows)[number]>("usage", "Usage", r => r.usage),
		amountColumn<(typeof rows)[number]>("credits", "Credits", r => r.credits),
		amountColumn<(typeof rows)[number]>("refunds", "Refunds", r => r.refunds),
		amountColumn<(typeof rows)[number]>("billed", "Billed", r => r.billed),
	];
	const grants = a.credit_grants || [],
		active = grants.filter(
			g => g.remaining >= 0.01 && (g.status || "ENABLED") === "ENABLED" && (g.end || "9") >= model.data.today,
		),
		inactive = grants.filter(g => !active.includes(g));
	const grantCols: Column<(typeof grants)[number]>[] = [
		stringColumn("description", "Description", g => g.description || g.type || ""),
		{
			key: "remaining",
			header: "Remaining of initial",
			render: g => `${money(g.remaining, 0)} of ${money(g.initial, 0)}`,
		},
		stringColumn("end", "Expiry", g => g.end),
		{
			key: "estimated",
			header: "Estimated after this month",
			render: g => (g.estimated_remaining == null ? "–" : money(g.estimated_remaining, 0)),
		},
	];
	const ref = Math.abs(total(a.costs.credits_monthly?.[model.cur] || {})) >= 0.01 ? model.cur : model.last;
	return (
		<div className="aws-account">
			<h3>
				{a.label} · {a.account_id}
			</h3>
			{active.length > 0 && (
				<Table rows={active} rowKey={g => `${g.description || g.type}:${g.end}`} columns={grantCols} />
			)}
			{inactive.length > 0 && (
				<p>
					Used up or expired:{" "}
					{inactive
						.map(
							g =>
								`${g.description || g.type} ${money(g.initial, 0)}${g.exhausted ? ` (used up ${g.exhausted})` : ` (expired ${g.end})`}`,
						)
						.join(" · ")}
				</p>
			)}
			{a.credit_grants_error && (
				<p>
					Credit balances unavailable on this account ({a.credit_grants_error.replace(/^aws: \[ERROR\]: /, "")}).
					{/not activated/.test(a.credit_grants_error)
						? ' Enable "IAM user and role access to Billing information" in Account settings to show them.'
						: ""}
				</p>
			)}
			<Table rows={rows} rowKey={r => r.m} columns={cols} />
			<p>
				Credits by service:{" "}
				{Object.entries(a.costs.credits_monthly?.[ref] || {})
					.sort((x, y) => x[1] - y[1])
					.slice(0, 6)
					.map(([s, v]) => `${shortName(s)} ${money(-v)}`)
					.join(" · ") || "None"}
			</p>
		</div>
	);
}
function Breakdown({ model, tag = false }: { model: AwsModel; tag?: boolean }) {
	const current = +model.data.today.slice(8, 10) <= 3 ? model.last : model.cur;
	const rows: Record<string, { name: string; last: number; current: number; rr: number }> = {};
	for (const a of model.accounts) {
		const source = tag ? a.costs.tags?.Project : a.costs.region;
		for (const [period, key] of [
			[model.last, "last"],
			[current, "current"],
		] as const)
			for (const [name, v] of Object.entries(source?.[period] || {})) {
				const r = (rows[name] ||= { name, last: 0, current: 0, rr: 0 });
				r[key] += v;
			}
		if (tag)
			for (const d of model.rrDays)
				for (const [name, v] of Object.entries(a.costs.tags_daily?.Project?.[d] || {})) {
					const r = (rows[name] ||= { name, last: 0, current: 0, rr: 0 });
					r.rr += (v / 7) * 30;
				}
	}
	const list = Object.values(rows)
		.filter(r => r.last >= 0.01 || r.current >= 0.01 || r.rr >= 0.01)
		.sort((a, b) => b.rr - a.rr || b.last - a.last);
	const cols = [
		stringColumn<(typeof list)[number]>("name", "Name", r => r.name),
		amountColumn<(typeof list)[number]>("last", "Last month", r => r.last),
		amountColumn<(typeof list)[number]>("current", "Selected month", r => r.current),
		...(tag ? [amountColumn<(typeof list)[number]>("rr", "Run-rate", r => r.rr)] : []),
	];
	return (
		<section>
			<h3>{tag ? "By project" : "By region"}</h3>
			<Table rows={list} rowKey={r => r.name} columns={cols} empty={tableEmpty} />
		</section>
	);
}
function Reservations({ model }: { model: AwsModel }) {
	const rows = model.accounts.flatMap(a =>
		(a.reservations || []).map((r, i) => ({ ...r, account: a.label, key: `${a.key}:${i}` })),
	);
	if (!rows.length) return null;
	const cols = [
		stringColumn<(typeof rows)[number]>("type", "Reservation", r => `${r.count}× ${r.type}`),
		stringColumn<(typeof rows)[number]>("account", "Account", r => r.account),
		stringColumn<(typeof rows)[number]>("region", "Region", r => r.region),
		amountColumn<(typeof rows)[number]>("fee", "Fee / mo", r => r.hourly * r.count * 730),
		stringColumn<(typeof rows)[number]>("util", "Utilisation", r => `${Math.round(r.utilisation * 100)}%`),
		amountColumn<(typeof rows)[number]>("unused", "Unused / mo", r => r.unused_monthly),
		stringColumn<(typeof rows)[number]>("end", "Ends", r => r.end),
	];
	return (
		<>
			<h3>Reserved Instances — paid whether used or not</h3>
			<Table rows={rows} rowKey={r => r.key} columns={cols} />
		</>
	);
}
