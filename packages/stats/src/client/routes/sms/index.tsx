import { useEffect, useMemo, useRef, useState } from "react";
import { getHubReport, getHubReportPart, getHubReports } from "../../data/hub";
import { useQuery } from "../../data/query";
import { Card, PageHeader, Segmented, Table, type Column } from "../../ui";
import type { ControlCenterRouteProps } from "../controlCenter";
import { ConfirmRunModal } from "./ConfirmRunModal";
import {
	STAGES,
	boardColumns,
	groupRows,
	matches,
	mrMatches,
	parseFilters,
	serializeFilters,
	type Issue,
	type MergeRequest,
	type SelectField,
	type TimelineMilestone,
} from "./smsModel";
import { ReportCharts } from "./ReportCharts";
import { PlanView, type PlanData } from "./PlanView";
import { TimelineView } from "./TimelineView";
import { TicketsView } from "./TicketsView";
import { FiltersBar } from "./FiltersBar";
import { MrsView } from "./MrsView";
import { OverviewStats } from "./OverviewStats";
import "./sms.css";

type Report = {
	group_url: string;
	synced_at: string;
	next_sync_hours: number;
	issues: Issue[];
	mrs: MergeRequest[];
	milestones: { title: string; due: string | null }[];
	timeline: {
		as_of: string;
		golive: (TimelineMilestone & { days_left: number | null }) | null;
		milestones: TimelineMilestone[];
		next: Issue[];
		next_milestone: string;
	} | null;
	plan: PlanData;
	history: { at: string; open: number; closed: number; by_status: Record<string, number> }[];
};
type Environment = {
	env?: string;
	smoke?: string;
	stage?: string;
	updatedAt?: string;
	hosts?: string[];
	log?: string;
	shas?: Record<string, string>;
	branches?: Record<string, string>;
	images?: Record<string, string>;
	last_good?: Record<string, string>;
};
const TABS = [
	["overview", "Overview"],
	["timeline", "Timeline"],
	["envs", "Environments"],
	["board", "Board"],
	["epics", "Epics"],
	["milestones", "Milestones"],
	["repos", "Repos"],
	["trends", "Trends"],
	["plan", "Plan & dependencies"],
	["tickets", "All tickets"],
	["mrs", "Merge requests"],
].map(([value, label]) => ({ value, label }));
const label = (s: string) => s.replaceAll("-", " ").replace(/\b\w/g, c => c.toUpperCase());
function Progress({
	items,
	field,
	onDrill,
}: {
	items: Issue[];
	field: SelectField;
	onDrill: (field: SelectField, value: string) => void;
}) {
	const rows = useMemo(() => groupRows(items, field), [items, field]);
	const cols: Column<(typeof rows)[number]>[] = [
		{ key: "key", header: label(field), sort: r => r.key, render: r => r.key },
		{ key: "total", header: "Total", sort: r => r.total, render: r => r.total },
		{ key: "done", header: "Done", sort: r => r.c.done, render: r => r.c.done },
		{ key: "open", header: "Open", render: r => r.total - r.c.done - r.c.canceled - r.c.duplicate },
		{
			key: "pct",
			header: "Done %",
			render: r => `${Math.round((1000 * r.c.done) / (r.total - r.c.canceled - r.c.duplicate || 1)) / 10}%`,
		},
	];
	return <Table rows={rows} columns={cols} rowKey={r => r.key} onRowClick={r => onDrill(field, r.key)} limit={100} />;
}
function Board({ items, group, setGroup }: { items: Issue[]; group: string; setGroup: (s: string) => void }) {
	const [shown, setShown] = useState<Record<string, number>>({});
	const groups = useMemo(
		() => (group === "none" ? [{ key: "All", items }] : groupRows(items, group as SelectField)),
		[items, group],
	);
	return (
		<>
			<label>
				Swimlanes{" "}
				<select
					value={group}
					onChange={e => {
						setGroup(e.target.value);
						setShown({});
					}}
				>
					{["none", "project", "release", "milestone", "epic", "area", "assignee"].map(x => (
						<option key={x}>{x}</option>
					))}
				</select>
			</label>
			{groups.map(g => {
				const cols = boardColumns(g.items);
				return (
					<section key={g.key}>
						<h2>
							{g.key} · {g.items.length}
						</h2>
						<div className="sms-board">
							{STAGES.filter(s => s !== "no-status" || cols[s].length).map(s => {
								const key = g.key + s;
								const count = shown[key] || 40;
								return (
									<div key={s}>
										<h3>
											{label(s)} · {cols[s].length}
										</h3>
										{cols[s].slice(0, count).map(i => (
											<a
												className="sms-ticket"
												href={i.url}
												target="_blank"
												rel="noopener noreferrer"
												key={i.ref}
											>
												<b>{i.key || i.ref}</b>
												<span>{i.title}</span>
												<small>
													{i.project} {i.mrs?.length ? `· ${i.mrs.length} MR` : ""}
												</small>
											</a>
										))}
										{cols[s].length > count && (
											<button className="btn" onClick={() => setShown({ ...shown, [key]: count + 80 })}>
												Show more
											</button>
										)}
									</div>
								);
							})}
						</div>
					</section>
				);
			})}
		</>
	);
}
function Environments({ active }: { active: boolean }) {
	const query = useQuery(
		["hub-report", "sms", "envs"],
		({ signal }) => getHubReportPart<Record<string, Environment>>("sms", "envs", signal),
		{ enabled: active, scope: "local" },
	);
	if (query.error) return <p role="alert">{query.error.message}</p>;
	if (!query.data) return <p>Loading environments…</p>;
	return (
		<div className="sms-grid">
			{Object.entries(query.data).map(([name, e]) => (
				<Card
					key={name}
					title={`${name} · ${e.smoke || "unknown"}`}
					description={`${e.stage || ""} ${e.updatedAt || ""}`}
				>
					<p>
						Hosts:{" "}
						{(e.hosts || []).map(h => (
							<span key={h}>
								<a href={`https://${h}`} target="_blank" rel="noopener noreferrer">
									{h}
								</a>{" "}
							</span>
						))}
					</p>
					<p>
						Log: <code>{e.log || "—"}</code>
					</p>
					<table>
						<thead>
							<tr>
								<th>Repo</th>
								<th>Branch</th>
								<th>SHA</th>
								<th>Image</th>
								<th>Last good</th>
							</tr>
						</thead>
						<tbody>
							{Object.keys(e.shas || {})
								.sort()
								.map(r => (
									<tr key={r}>
										<td>{r}</td>
										<td>{e.branches?.[r]}</td>
										<td>{e.shas?.[r]?.slice(0, 10)}</td>
										<td>{e.images?.[r]?.slice(0, 10)}</td>
										<td>{e.last_good?.[r]?.slice(0, 10)}</td>
									</tr>
								))}
						</tbody>
					</table>
				</Card>
			))}
		</div>
	);
}
export default function SmsRoute({ active, sub, params, setParams, setSub, setControl }: ControlCenterRouteProps) {
	const tab = TABS.some(t => t.value === sub) ? sub! : "overview";
	const meta = useQuery(["hub-reports"], ({ signal }) => getHubReports(signal), {
		enabled: active,
		scope: "local",
		pollMs: 60000,
	});
	const report = useQuery(["hub-report", "sms"], ({ signal }) => getHubReport<Report>("sms", signal), {
		enabled: active,
		scope: "local",
	});
	const mtime = meta.data?.reports.find(r => r.id === "sms")?.mtime;
	const previous = useRef<number | null | undefined>(undefined);
	useEffect(() => {
		if (mtime !== undefined && previous.current !== undefined && mtime !== previous.current) report.refetch();
		if (mtime !== undefined) previous.current = mtime;
	}, [mtime, report.refetch]);
	const filters = useMemo(() => parseFilters(params), [params]);
	const list = useMemo(() => report.data?.issues.filter(i => matches(i, filters)) || [], [report.data, filters]);
	const mrs = useMemo(() => report.data?.mrs.filter(m => mrMatches(m, filters)) || [], [report.data, filters]);
	const [confirm, setConfirm] = useState(false);
	const [notice, setNotice] = useState("");
	const drill = (field: SelectField, value: string) => {
		setControl({ sub: "board", params: { [field]: value } });
	};
	const data = report.data;
	return (
		<div className="page sms-page">
			<PageHeader
				title="SMS progress"
				description={
					data
						? `Synced ${new Date(data.synced_at).toLocaleString()} · next ≈ ${new Date(Date.parse(data.synced_at) + data.next_sync_hours * 3600000).toLocaleString()}`
						: "Report data"
				}
				actions={
					<>
						<button className="btn" onClick={() => setConfirm(true)}>
							Refresh now
						</button>
						{data && (
							<a href={`${data.group_url}/-/issues`} target="_blank" rel="noopener noreferrer">
								GitLab
							</a>
						)}
					</>
				}
			/>
			{notice && <p role="status">{notice}</p>}
			<ConfirmRunModal
				open={confirm}
				onClose={() => setConfirm(false)}
				onAccepted={() => {
					setNotice("Sync accepted; new data will load when available.");
					meta.refetch();
				}}
			/>
			<div className="sms-scroll">
				<Segmented value={tab} options={TABS} onChange={setSub} />
			</div>
			{report.error && <p role="alert">{report.error.message}</p>}
			{!data && <p>Loading report…</p>}
			{data && (
				<>
					{!["plan", "timeline", "envs"].includes(tab) && (
						<>
							<FiltersBar
								all={data.issues}
								mrs={data.mrs}
								milestones={data.milestones}
								filters={filters}
								onChange={f => setParams(serializeFilters(f))}
								mr={tab === "mrs"}
							/>
							<p>
								{tab === "mrs" ? mrs.length : list.length} of{" "}
								{tab === "mrs" ? data.mrs.length : data.issues.length} match
							</p>
						</>
					)}
					{tab === "envs" && <Environments active={active} />}
					{tab === "timeline" && <TimelineView data={data.timeline} />}
					{tab === "plan" && <PlanView data={data.plan} issues={data.issues} />}
					{tab === "board" && (
						<Board
							items={list}
							group={params.group || "none"}
							setGroup={group => setParams({ group: group === "none" ? null : group })}
						/>
					)}
					{tab === "tickets" && <TicketsView items={list} />}
					{tab === "mrs" && (
						<MrsView items={mrs} tab={params.mrtab || "all"} setTab={mrtab => setParams({ mrtab })} />
					)}
					{(["epics", "milestones", "repos"] as string[]).includes(tab) && (
						<Card title={label(tab)}>
							<Progress
								items={tab === "epics" ? list.filter(i => i.type !== "epic") : list}
								field={tab === "epics" ? "epic" : tab === "milestones" ? "milestone" : "project"}
								onDrill={drill}
							/>
						</Card>
					)}
					{tab === "overview" && (
						<>
							<OverviewStats issues={list} />
							<div className="sms-grid">
								{(["release", "milestone", "project", "area"] as const).map(field => (
									<Card key={field} title={`Progress by ${label(field)}`}>
										<Progress items={list} field={field} onDrill={drill} />
									</Card>
								))}
							</div>
							<ReportCharts issues={list} history={data.history} />
						</>
					)}
					{tab === "trends" && <ReportCharts issues={list} history={data.history} trends />}
				</>
			)}
		</div>
	);
}
