import { useState } from "react";
import { Chart } from "../../charts";
import { Card } from "../../ui";
import { PlanDag, type Lane, type PlanNode } from "./PlanDag";
import type { Issue } from "./smsModel";
interface Phase {
	id: string;
	name: string;
	release?: string;
	key_prefix?: string;
	waves: number[];
	exit: string;
}
export interface PlanData {
	nodes: (PlanNode & { phase: string })[];
	scopes: string[];
	chains: Record<string, number>;
	rules: {
		lanes: (Lane & { checker: string; note: string })[];
		phases: Phase[];
		execution: { mode: string; rules: string[] };
		integrator: { name: string; repos: string[]; model: string; note: string };
	};
}
export function PlanView({ data, issues }: { data: PlanData; issues: Issue[] }) {
	const [scope, setScope] = useState("");
	if (!data?.nodes.length) return <p>No plan data yet.</p>;
	const selected = data.scopes.includes(scope) ? scope : data.scopes[0];
	const nodes = data.nodes.filter(n => n.release === selected);
	const done = nodes.filter(n => n.status === "done");
	const live = nodes.filter(n => n.status !== "canceled" && n.status !== "duplicate");
	const critical = nodes.filter(n => n.critical);
	const start = nodes.filter(n => n.startable);
	const waves = Math.max(0, ...nodes.map(n => n.wave));
	const hot = new Map<string, number>();
	for (const n of nodes) for (const repo of n.repos) hot.set(repo, (hot.get(repo) || 0) + 1);
	const sum = (list: PlanNode[]) => list.reduce((s, n) => s + (n.points || 0), 0);
	return (
		<>
			<div className="sms-grid">
				{[
					["Stories in plan", `${nodes.length} · ${sum(nodes)} pts`],
					["Done", `${done.length} · ${live.length ? Math.round((done.length / live.length) * 1000) / 10 : 0}%`],
					[
						"Critical path",
						`${critical.filter(n => n.status === "done").length} / ${critical.filter(n => live.includes(n)).length} · ${data.chains[selected]} pts`,
					],
					["Waves", String(waves)],
					["Can start now", String(start.length)],
					["Lanes", String(data.rules.lanes.length)],
				].map(([name, value]) => (
					<Card key={name} title={name}>
						<strong>{value}</strong>
					</Card>
				))}
			</div>
			<Card title="Delivery phases" description={data.rules.execution.mode}>
				<div className="sms-scroll">
					<table>
						<thead>
							<tr>
								{["Phase", "Name", "Scope", "Items", "Pts", "Done", "Progress", "Exit test"].map(h => (
									<th key={h}>{h}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{(data.rules.phases || []).map(ph => {
								const ns = ph.release ? data.nodes.filter(n => n.phase === ph.id) : [];
								const own = ph.key_prefix ? issues.filter(i => i.key?.startsWith(ph.key_prefix!)) : [];
								const total = ph.release ? ns.length : own.length;
								const dn = ph.release
									? ns.filter(n => n.status === "done").length
									: own.filter(i => i.state === "closed").length;
								return (
									<tr key={ph.id}>
										<td>{ph.id}</td>
										<td>{ph.name}</td>
										<td>
											{ph.release
												? `${ph.release} · waves ${ph.waves[0]}–${ph.waves[1] > 90 ? "end" : ph.waves[1]}`
												: "tracked tasks"}
										</td>
										<td>{total}</td>
										<td>{ph.release ? sum(ns) : "—"}</td>
										<td>{dn}</td>
										<td>
											<progress value={dn} max={total || 1} />
										</td>
										<td>{ph.exit}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<ul>
					{data.rules.execution.rules.map(r => (
						<li key={r}>{r}</li>
					))}
				</ul>
			</Card>
			<Card
				title="Dependency graph"
				description="Columns are waves and rows are lanes. The outlined nodes are on the critical path; hover to trace dependencies."
				actions={
					<select value={selected} onChange={e => setScope(e.target.value)}>
						{data.scopes.map(s => (
							<option key={s}>{s}</option>
						))}
					</select>
				}
			>
				<PlanDag nodes={nodes} lanes={data.rules.lanes} />
			</Card>
			<Card
				title="Can start now"
				description="Open stories whose dependencies are all done, by lane, lowest slack first."
			>
				<div className="sms-board">
					{data.rules.lanes.map(l => {
						const list = start.filter(n => n.lane === l.id).sort((a, b) => a.slack - b.slack);
						return list.length ? (
							<div key={l.id}>
								<h3>
									{l.name} · {list.length}
								</h3>
								{list.map(n => (
									<a className="sms-ticket" key={n.key} href={n.url} target="_blank" rel="noopener noreferrer">
										<b>
											{n.key}
											{n.critical ? " · critical path" : ""}
										</b>
										<span>{n.title}</span>
										<small>
											{n.status} · {n.points ?? "—"} pts · slack {n.slack}
											{n.high_risk ? " · high risk" : ""}
										</small>
									</a>
								))}
							</div>
						) : null;
					})}
				</div>
				{!start.length && <p>Nothing is unblocked right now.</p>}
			</Card>
			<Card title="Work areas">
				<div className="sms-scroll">
					<table>
						<thead>
							<tr>
								{["Lane", "Stories", "Pts", "Done", "Critical", "High risk", "Builder", "Checker", "Note"].map(
									h => (
										<th key={h}>{h}</th>
									),
								)}
							</tr>
						</thead>
						<tbody>
							{data.rules.lanes.map(l => {
								const ns = nodes.filter(n => n.lane === l.id);
								return (
									<tr key={l.id}>
										<td>
											{l.name}
											<div>{l.repos.join(", ")}</div>
										</td>
										<td>{ns.length}</td>
										<td>{sum(ns)}</td>
										<td>{ns.filter(n => n.status === "done").length}</td>
										<td>{ns.filter(n => n.critical).length}</td>
										<td>{ns.filter(n => n.high_risk).length}</td>
										<td>{l.builder}</td>
										<td>{l.checker}</td>
										<td>{l.note}</td>
									</tr>
								);
							})}
							<tr>
								<td>
									{data.rules.integrator.name} · {data.rules.integrator.repos.join(", ")}
								</td>
								<td colSpan={5} />
								<td>{data.rules.integrator.model}</td>
								<td>Founder</td>
								<td>{data.rules.integrator.note}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</Card>
			<div className="sms-grid">
				<Card title="Shared repos (conflict hot spots)">
					<table>
						<tbody>
							{[...hot]
								.sort((a, b) => b[1] - a[1])
								.map(([repo, count]) => (
									<tr key={repo}>
										<td>{repo}</td>
										<td>
											<progress value={count} max={nodes.length || 1} />
										</td>
										<td>{count}</td>
									</tr>
								))}
						</tbody>
					</table>
				</Card>
				<Card title="Stories per wave">
					<Chart
						kind="bars"
						slots={waves}
						tickLabel={i => `W${i + 1}`}
						series={[
							{
								key: "stories",
								label: "Stories",
								color: "var(--chart-primary)",
								values: Array.from({ length: waves }, (_, i) => nodes.filter(n => n.wave === i + 1).length),
							},
						]}
					/>
				</Card>
			</div>
		</>
	);
}
