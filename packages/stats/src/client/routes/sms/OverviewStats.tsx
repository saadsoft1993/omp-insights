import { Card, Stat, StatGrid } from "../../ui";
import { STAGES, STATUS_COLORS, statusCounts, type Issue } from "./smsModel";
const label = (s: string) => s.replaceAll("-", " ").replace(/\b\w/g, c => c.toUpperCase());
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
export function OverviewStats({ issues }: { issues: Issue[] }) {
	const c = statusCounts(issues);
	const total = issues.length;
	const closed = issues.filter(i => i.state === "closed").length;
	const cutoff = Date.now() - 7 * 86400000;
	const closed7 = issues.filter(i => i.closed_at && Date.parse(i.closed_at) >= cutoff).length;
	const created7 = issues.filter(i => Date.parse(i.created_at) >= cutoff).length;
	const points = issues.filter(i => i.points != null && i.eff_status !== "canceled" && i.eff_status !== "duplicate");
	const totalPoints = points.reduce((n, i) => n + (i.points || 0), 0);
	const donePoints = points.filter(i => i.eff_status === "done").reduce((n, i) => n + (i.points || 0), 0);
	return (
		<>
			<StatGrid>
				<Stat label="Total tickets" value={total} hint={`${total - closed} open in GitLab`} />
				<Stat label="Closed" value={closed} hint={`${pct(closed, total)}% of total`} />
				<Stat label="Done" value={c.done} hint={`${pct(c.done, total - c.canceled - c.duplicate)}% complete`} />
				<Stat label="In development" value={c["in-development"]} hint={`${c.ready} ready to start`} />
				<Stat label="In review / QA" value={c["in-review"] + c["in-qa"]} hint={`${c["in-qa"]} in QA`} />
				<Stat
					label="Waiting external"
					value={c["waiting-external-review-merge"]}
					hint="Review or merge by someone outside the team"
				/>
				<Stat label="Need decision" value={c["need-decision-bd"]} hint="Before development can start" />
				<Stat label="Closed last 7 days" value={closed7} hint={`${created7} created in 7 days`} />
				<Stat label="Blocked" value={c.blocked} hint="Status blocked" />
				{points.length > 0 && (
					<Stat
						label="Story points done"
						value={donePoints}
						hint={`of ${totalPoints} (${pct(donePoints, totalPoints)}%)`}
					/>
				)}
			</StatGrid>
			<Card
				title="Where every ticket stands"
				description="Status of open tickets; closed tickets count as done unless canceled or duplicate."
			>
				{total > 0 ? (
					<>
						<div className="sms-status-bar" role="img" aria-label="Tickets by status">
							{STAGES.filter(s => c[s]).map(s => (
								<span
									key={s}
									title={`${label(s)}: ${c[s]} of ${total} (${pct(c[s], total)}%)`}
									style={{ flex: c[s], backgroundColor: STATUS_COLORS[s] }}
								/>
							))}
						</div>
						<div className="sms-status">
							{STAGES.filter(s => c[s]).map(s => (
								<span key={s}>
									<i style={{ backgroundColor: STATUS_COLORS[s] }} />
									{label(s)} <b>{c[s]}</b>
								</span>
							))}
						</div>
					</>
				) : (
					<p>No tickets match the filters.</p>
				)}
			</Card>
		</>
	);
}
