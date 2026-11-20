import { Card } from "../../ui";
import { timelinePace, type Issue, type TimelineMilestone } from "./smsModel";
export interface TimelineData {
	as_of: string;
	golive: (TimelineMilestone & { days_left: number | null }) | null;
	milestones: TimelineMilestone[];
	next: Issue[];
	next_milestone: string;
}
const date = (s: string | null) =>
	s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const status = (s: string) => s.replaceAll("_", " ");
export function TimelineView({ data }: { data: TimelineData | null }) {
	if (!data) return <p>No timeline in this data yet. It appears after the next sync.</p>;
	const g = data.golive;
	return (
		<>
			{g && (
				<Card title={g.title}>
					<p>
						<strong>
							{g.days_left == null ? "" : g.days_left < 0 ? `${-g.days_left} days ago` : `${g.days_left} days`}
						</strong>{" "}
						· {date(g.due)} · {g.pct}% done · {status(g.status)}
					</p>
				</Card>
			)}
			<Card
				title="Milestones"
				description={`Pace is done per working day over the last 14 days, against what the due date needs. As of ${date(data.as_of)}.`}
			>
				<div className="sms-scroll">
					<table>
						<thead>
							<tr>
								{[
									"Milestone",
									"Dates",
									"Progress",
									"Issues",
									"Done",
									"Pace / needed",
									"Projected finish",
									"Status",
								].map(x => (
									<th key={x}>{x}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{data.milestones.map(m => {
								const pace = timelinePace(m);
								return (
									<tr key={m.title}>
										<td>{m.title}</td>
										<td>
											{m.start ? `${date(m.start)} → ` : ""}
											{date(m.due)}
										</td>
										<td>
											<progress value={m.pct} max={100} title={`${m.done} of ${m.total} ${pace.unit}`} />
										</td>
										<td>
											{m.issues_done}/{m.issues_total}
											{m.unit === "points" && (
												<div>
													{m.points_done}/{m.points_total} pts
												</div>
											)}
										</td>
										<td>{m.pct}%</td>
										<td>
											{pace.actual} / {pace.required ?? "—"}
											<div>{pace.unit} per day</div>
										</td>
										<td>{date(pace.projectedFinish)}</td>
										<td>{status(m.status)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</Card>
			<Card
				title={`Next up${data.next_milestone ? ` · ${data.next_milestone}` : ""}`}
				description="Open tickets of the earliest unfinished milestone, most ready first."
			>
				{data.next.length ? (
					<ol>
						{data.next.map(i => (
							<li key={i.ref}>
								<a href={i.url} target="_blank" rel="noopener noreferrer">
									{i.key || i.ref}
								</a>{" "}
								{i.title} · {i.eff_status}
								{i.priority ? ` · ${i.priority}` : ""}
								{i.points != null ? ` · ${i.points} pts` : ""}
							</li>
						))}
					</ol>
				) : (
					<p>Nothing open in a dated milestone.</p>
				)}
			</Card>
		</>
	);
}
