import { useMemo, useState } from "react";
import { Chart, Sparkline } from "../../charts";
import { fetchHubReportPdf, getHubReport, getHubReportPart } from "../../data/hub";
import { useQuery } from "../../data/query";
import {
	Badge,
	Card,
	EmptyState,
	Modal,
	PageHeader,
	QueryView,
	Segmented,
	Skeleton,
	Stat,
	StatGrid,
	Table,
	type Column,
} from "../../ui";
import type { ControlCenterRouteProps } from "../controlCenter";
import {
	aggregate,
	highlights,
	personSeries,
	presetRange,
	score,
	spark,
	teamTotals,
	type DeliveryData,
	type PersonRow,
	type Sample,
} from "./deliveryModel";
import "./delivery.css";

type Detail = {
	reviews: number;
	unmerged: [string, string, string, string, number][];
	unmerged_total: number;
	open_mrs: [string, string, string, string][];
	closed_mrs: [string, string, string, string][];
	first: string | null;
	last: string | null;
	emails: string[];
};
type Details = Record<string, Detail>;
const presets = [
	["7d", 7],
	["14d", 14],
	["21d", 21],
	["30d", 30],
	["90d", 90],
	["6m", 180],
	["1y", 365],
	["All", null],
] as const;
const fmt = (n: number) => n.toLocaleString();

export default function DeliveryRoute({ active, params, setParams }: ControlCenterRouteProps) {
	const query = useQuery(["hub-report", "delivery"], ({ signal }) => getHubReport<DeliveryData>("delivery", signal), {
		enabled: active,
		scope: "local",
	});
	const [person, setPerson] = useState<number | null>(null);
	const [downloading, setDownloading] = useState(false);
	const [pdfError, setPdfError] = useState("");
	const data = query.data;
	const defaults = data ? presetRange(data, 21) : { from: "", to: "" };
	const from = params.from || defaults.from,
		to = params.to || defaults.to,
		team = params.team || "All",
		roster = params.roster !== "0";
	const list = useMemo(
		() => (data && from && to && from <= to ? aggregate(data, from, to, team, roster) : []),
		[data, from, to, team, roster],
	);
	const result = useMemo(() => score(list), [list]);
	const teams = useMemo(() => teamTotals(list), [list]);
	const rangeDays = Math.round((+new Date(to) - +new Date(from)) / 86400000) + 1;
	const lowest = result.ranked
		.filter(p => roster || p.roster)
		.slice(-3)
		.reverse();
	const activePreset = data
		? presets.find(([, days]) => {
				const range = presetRange(data, days);
				return range.from === from && range.to === to;
			})?.[0] || ""
		: "";
	const picks = useMemo(() => (data ? highlights(data, from, to, team, roster) : {}), [data, from, to, team, roster]);
	const authored = list.reduce((s, p) => s + p.authored, 0),
		delivered = list.reduce((s, p) => s + p.delivered, 0);
	const maxLines = Math.max(1, ...teams.map(t => t.lines)),
		maxScore = Math.max(1, ...result.ranked.map(p => Math.abs(p.score)));
	const teamColumns: Column<(typeof teams)[number]>[] = [
		{ key: "team", header: "Team", render: t => t.team, sort: t => t.team },
		...(["people", "delivered", "landing", "feature", "fix", "test", "avg", "lines"] as const).map(key => ({
			key,
			header: {
				people: "People",
				delivered: "Delivered / authored",
				landing: "Landing",
				feature: "Features",
				fix: "Fixes",
				test: "Tests",
				avg: "Avg days",
				lines: "Lines",
			}[key],
			sort: (t: (typeof teams)[number]) => t[key],
			render: (t: (typeof teams)[number]) =>
				key === "delivered"
					? `${fmt(t.delivered)} / ${fmt(t.authored)}`
					: key === "landing"
						? `${Math.round(t.landing * 100)}%`
						: key === "avg"
							? t.avg.toFixed(1)
							: fmt(t[key]),
		})),
		{
			key: "bar",
			header: "Lines share",
			render: t => (
				<div className="delivery-bar">
					<span style={{ width: `${Math.max(1.5, (t.lines / maxLines) * 100)}%` }} />
				</div>
			),
			sort: t => t.lines,
		},
	];
	const ranking: Column<PersonRow>[] = [
		{ key: "rank", header: "#", render: p => p.rank || "–", sort: p => p.rank || Number.MAX_SAFE_INTEGER },
		{
			key: "name",
			header: "Name",
			render: p => (
				<button className="delivery-link" onClick={() => setPerson(p.pi)}>
					{p.name}
					{!p.roster ? " · outside" : ""}
					{p.lead ? " · reviewer" : ""}
				</button>
			),
			sort: p => p.name,
		},
		{ key: "team", header: "Team", render: p => p.team, sort: p => p.team },
		...(["units", "feature", "fix", "delivered", "landing", "days"] as const).map(key => ({
			key,
			header: {
				units: "Units",
				feature: "Features",
				fix: "Fixes",
				delivered: "Delivered / authored",
				landing: "Landing",
				days: "Days",
			}[key],
			sort: (p: PersonRow) => p[key],
			render: (p: PersonRow) =>
				key === "delivered"
					? `${p.delivered} / ${p.authored}`
					: key === "landing"
						? `${Math.round(p.landing * 100)}%`
						: p[key],
		})),
		{
			key: "trend",
			header: "Trend",
			render: p => (data ? <Sparkline values={spark(data, p.pi, from, to)} width={72} height={20} /> : null),
			sort: p => p.delivered,
		},
		{
			key: "bar",
			header: "Score bar",
			render: p => (
				<svg width="120" height="16" viewBox="0 0 120 16" aria-label={`Score ${p.score.toFixed(2)}`}>
					<line x1="60" x2="60" y1="0" y2="16" stroke="currentColor" />
					<rect
						x={p.score >= 0 ? 60 : 60 - (Math.abs(p.score) / maxScore) * 60}
						y="3"
						width={(Math.abs(p.score) / maxScore) * 60}
						height="10"
						fill={p.score >= 0 ? "var(--chart-primary)" : "var(--chart-secondary)"}
					/>
				</svg>
			),
			sort: p => p.score,
		},
		{
			key: "score",
			header: "Score",
			render: p => (p.rank ? `${p.score >= 0 ? "+" : ""}${p.score.toFixed(2)}` : "–"),
			sort: p => (p.rank ? p.score : -Infinity),
		},
		{
			key: "stability",
			header: "Stability",
			render: p =>
				p.rank ? (
					<Badge
						tone={p.stab === "firm" ? "ok" : p.stab === "unstable" ? "bad" : "neutral"}
						title={`Rank ranged ${p.lo}–${p.hi} across 6 weightings`}
					>
						{p.stab === "soft" ? "±" : p.stab}
					</Badge>
				) : null,
			sort: p => p.hi - p.lo,
		},
	];
	async function download() {
		setDownloading(true);
		setPdfError("");
		try {
			const { blob, filename } = await fetchHubReportPdf("delivery", {
				from,
				to,
				team: team === "All" ? "" : team,
				roster: roster ? "1" : "0",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (error) {
			setPdfError(error instanceof Error ? error.message : "Unable to download PDF");
		} finally {
			setDownloading(false);
		}
	}
	const notBuilt =
		query.error?.message.toLowerCase().includes("not built yet") || query.error?.message.includes("404");
	return (
		<div className="page delivery-page">
			<PageHeader
				title="Delivery analytics"
				description="Work that reached an integration branch, excluding merge commits."
				actions={
					<button className="btn" disabled={downloading || !data} aria-busy={downloading} onClick={download}>
						{downloading ? "Preparing PDF…" : "Download PDF"}
					</button>
				}
			/>
			{pdfError && <p role="alert">{pdfError}</p>}
			{data && (
				<div className="delivery-controls">
					<label>
						From{" "}
						<input
							type="date"
							min={data.minDate}
							max={data.maxDate}
							value={from}
							onChange={e => setParams({ from: e.target.value })}
						/>
					</label>
					<label>
						To{" "}
						<input
							type="date"
							min={data.minDate}
							max={data.maxDate}
							value={to}
							onChange={e => setParams({ to: e.target.value })}
						/>
					</label>
					<div className="delivery-presets">
						<Segmented
							aria-label="Date range"
							value={activePreset}
							options={presets.map(([label]) => ({ value: label, label }))}
							onChange={label => {
								const preset = presets.find(([name]) => name === label);
								if (preset) setParams(presetRange(data, preset[1]));
							}}
						/>
					</div>
					<label>
						Team{" "}
						<select value={team} onChange={e => setParams({ team: e.target.value })}>
							<option>All</option>
							{[...new Set(data.people.map(p => p.team))].sort().map(t => (
								<option key={t}>{t}</option>
							))}
						</select>
					</label>
					<label>
						<input
							type="checkbox"
							checked={roster}
							onChange={e => setParams({ roster: e.target.checked ? "1" : "0" })}
						/>{" "}
						Active staff only
					</label>
				</div>
			)}
			<QueryView
				query={notBuilt ? { ...query, error: null, data: null, loading: true } : query}
				skeleton={notBuilt ? <EmptyState title="Report not built yet" /> : <Skeleton height={180} />}
				isEmpty={d => !d.daily.length}
				empty={<EmptyState title="No delivery data" />}
			>
				{() => (
					<>
						{from > to ? (
							<EmptyState title="Invalid date range" hint="Choose a start date before the end date." />
						) : (
							<>
								<StatGrid>
									{[
										["Commits delivered", fmt(delivered)],
										["Landing rate", authored ? `${Math.round((delivered / authored) * 100)}%` : "–"],
										["Features shipped", fmt(list.reduce((s, p) => s + p.feature, 0))],
										["Fixes shipped", fmt(list.reduce((s, p) => s + p.fix, 0))],
										["Test commits", fmt(list.reduce((s, p) => s + p.test, 0))],
										["People active", String(list.length)],
									].map(([label, value]) => (
										<Stat key={label} label={label} value={value} />
									))}
								</StatGrid>
								<div className="delivery-notes">
									{rangeDays < 14 && (
										<div>
											<h4>Short range — read landing rates with care</h4>
											<p>
												This range covers {rangeDays} days. Much of the work written in that time is still
												in review, so landing rates look low for reasons unrelated to quality. For judging
												people use 21 days or more.
											</p>
										</div>
									)}
									{result.none.length > 0 && (
										<div>
											<h4>{result.none.length} person(s) with nothing landed</h4>
											<p>
												{result.none.map(p => `${p.name} (${p.authored} commits authored)`).join(" · ")}
												{
													" — wrote code in this range that never reached an integration branch. Could be a long-running branch rather than a problem; worth one question each."
												}
											</p>
										</div>
									)}
									{result.ranked.length > 0 && (
										<div>
											<h4>Top three by delivered work</h4>
											<p>
												{result.ranked
													.slice(0, 3)
													.map(
														p =>
															`${p.name} (${p.units} units, ${Math.round(p.landing * 100)}% landed, ${p.days} days)`,
													)
													.join(" · ")}
											</p>
										</div>
									)}
									{lowest.length > 0 && (
										<div>
											<h4>Lowest delivered work</h4>
											<p>
												{lowest
													.map(
														p =>
															`${p.name} (${p.units} units, ${Math.round(p.landing * 100)}% landed, ${p.days} days)`,
													)
													.join(" · ")}
											</p>
										</div>
									)}
								</div>
								<Card title="By team" flush>
									<Table
										rows={teams}
										rowKey={t => t.team}
										columns={teamColumns}
										initialSort={{ key: "delivered", dir: "desc" }}
									/>
								</Card>
								<Card title="Ranking" flush>
									<div className="delivery-ranking">
										<Table
											rows={[...result.ranked, ...result.none]}
											rowKey={p => p.pi}
											columns={ranking}
											initialSort={{ key: "score", dir: "desc" }}
											empty={<EmptyState title="No activity in this range" />}
										/>
									</div>
								</Card>
								<Card title="What was delivered">
									{teams.map(t =>
										picks[t.team]?.length ? (
											<section key={t.team} className="delivery-team">
												<h3>
													{t.team}{" "}
													<small>
														{fmt(t.delivered)} delivered · {t.feature} features · {t.fix} fixes
														{t.test ? ` · ${t.test} tests` : ""}
													</small>
												</h3>
												<SampleList samples={picks[t.team]} data={data!} onPerson={setPerson} />
											</section>
										) : null,
									)}
								</Card>
								<Card title="Method">
									<p>
										Delivered work counts non-merge commits on integration branches. Units combine features,
										fixes, refactors and performance work. Scores combine standardized units, effort, active
										days and landing rate; stability compares six weightings.
									</p>
								</Card>
							</>
						)}
					</>
				)}
			</QueryView>
			{data && <PersonModal data={data} person={person} from={from} to={to} onClose={() => setPerson(null)} />}
		</div>
	);
}
function SampleList({
	samples,
	data,
	onPerson,
}: {
	samples: Sample[];
	data: DeliveryData;
	onPerson?: (pi: number) => void;
}) {
	return (
		<ul className="delivery-list">
			{samples.map((s, i) => (
				<li key={i}>
					<Badge>{s[3]}</Badge>
					<span>
						{s[5]}
						<br />
						<small>
							{s[2]} ·{" "}
							{onPerson ? (
								<button className="delivery-link" onClick={() => onPerson(s[0])}>
									{data.people[s[0]].name}
								</button>
							) : null}{" "}
							· {fmt(s[4])} lines · {s[1]}
						</small>
					</span>
				</li>
			))}
		</ul>
	);
}
function PersonModal({
	data,
	person,
	from,
	to,
	onClose,
}: {
	data: DeliveryData;
	person: number | null;
	from: string;
	to: string;
	onClose: () => void;
}) {
	const query = useQuery(
		["hub-report", "delivery", "details"],
		({ signal }) => getHubReportPart<Details>("delivery", "details", signal),
		{ enabled: person !== null, scope: "local" },
	);
	const p = person === null ? null : data.people[person],
		row = person === null ? null : aggregate(data, from, to, "All", false).find(x => x.pi === person),
		det = person === null ? null : query.data?.[String(person)];
	const series = person === null ? [] : personSeries(data, person, from, to),
		samples =
			person === null
				? []
				: data.samples
						.filter(s => s[0] === person && s[1] >= from && s[1] <= to)
						.sort((a, b) => a[6] - b[6] || b[4] - a[4]);
	const repos: Record<string, number> = {};
	for (const s of samples) repos[s[2]] = (repos[s[2]] || 0) + 1;
	const branches: Record<string, { key: string; n: number; lines: number; last: string; title: string }> = {};
	for (const u of det?.unmerged || []) {
		if (u[0] < from || u[0] > to) continue;
		const key = `${u[1]} · ${u[2]}`;
		const b = (branches[key] ||= { key, n: 0, lines: 0, last: u[0], title: u[3] });
		b.n++;
		b.lines += u[4];
		if (u[0] > b.last) {
			b.last = u[0];
			b.title = u[3];
		}
	}
	const branchRows = Object.values(branches).sort((a, b) => b.n - a.n);
	const columns = <T,>(keys: [string, (x: T) => string | number][]): Column<T>[] =>
		keys.map(([header, get]) => ({ key: header, header, render: get, sort: get }));
	return (
		<Modal open={person !== null} title={p?.name || "Person"} onClose={onClose} cancelLabel="Close">
			<QueryView query={query} skeleton={<Skeleton height={200} />}>
				{() => (
					<div className="delivery-detail">
						<p>
							{p?.team}
							{p?.lead ? " · reviewer" : ""}
							{p && !p.roster ? " · outside contributor" : ""}
							{det?.first ? ` · active ${det.first} → ${det.last}` : ""}
						</p>
						<StatGrid>
							{[
								["Units delivered", row?.units || 0],
								["Delivered / authored", `${row?.delivered || 0} / ${row?.authored || 0}`],
								["Landing rate", `${Math.round((row?.landing || 0) * 100)}%`],
								["Days active", row?.days || 0],
								["Features", row?.feature || 0],
								["Fixes", row?.fix || 0],
								["Tests", row?.test || 0],
								["MRs merged by them", det?.reviews || 0],
							].map(([label, value]) => (
								<Stat key={label} label={label} value={value} />
							))}
						</StatGrid>
						<h3>Trend — commits per period</h3>
						<Chart
							slots={series.length}
							kind="bars"
							stacked={false}
							tickLabel={i => series[i]?.from || ""}
							tooltipTitle={i => `${series[i]?.from} → ${series[i]?.to}`}
							series={[
								{
									key: "authored",
									label: "Authored",
									color: "var(--chart-secondary)",
									values: series.map(s => s.a),
								},
								{
									key: "delivered",
									label: "Delivered",
									color: "var(--chart-primary)",
									values: series.map(s => s.d),
								},
							]}
						/>
						<h3>Not on an integration branch</h3>
						<Table
							rows={branchRows}
							rowKey={b => b.key}
							columns={columns<(typeof branchRows)[number]>([
								["Repo · branch", b => b.key],
								["Commits", b => b.n],
								["Lines", b => b.lines],
								["Last commit", b => b.last],
								["Age", b => `${Math.round((+new Date(data.maxDate) - +new Date(b.last)) / 86400000)}d`],
								["Most recent work", b => b.title],
							])}
							empty="Everything this person wrote in this range reached an integration branch."
						/>
						<h3>Open merge requests</h3>
						<Table
							rows={det?.open_mrs || []}
							rowKey={m => m.join("|")}
							columns={columns<Detail["open_mrs"][number]>([
								["Raised", m => m[0]],
								["Age", m => `${Math.round((+new Date(data.maxDate) - +new Date(m[0])) / 86400000)}d`],
								["Repo", m => m[1]],
								["Target", m => m[2]],
								["Title", m => m[3]],
							])}
							empty="No open merge requests."
						/>
						<h3>Closed without merging</h3>
						<Table
							rows={(det?.closed_mrs || []).slice(0, 12)}
							rowKey={m => m.join("|")}
							columns={columns<Detail["closed_mrs"][number]>([
								["Raised", m => m[0]],
								["Repo", m => m[1]],
								["Target", m => m[2]],
								["Title", m => m[3]],
							])}
							empty="Nothing abandoned."
						/>
						<h3>Delivered in this range</h3>
						{samples.length ? (
							<SampleList samples={samples.slice(0, 14)} data={data} />
						) : (
							<p>Nothing landed in this range.</p>
						)}
						<h3>Where they worked</h3>
						<div className="delivery-repos">
							{Object.entries(repos)
								.sort((a, b) => b[1] - a[1])
								.slice(0, 10)
								.map(([name, count]) => (
									<Badge key={name}>
										{name} {count}
									</Badge>
								))}
						</div>
					</div>
				)}
			</QueryView>
		</Modal>
	);
}
