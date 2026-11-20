import { useMemo } from "react";
import { Chart } from "../../charts";
import { Card } from "../../ui";
import { burnUpDaily, throughput, MR_STAGES, type Issue } from "./smsModel";

type Snapshot = { at: string; open: number; closed: number; by_status: Record<string, number> };
const date = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const colors = [
	"var(--chart-primary)",
	"var(--chart-secondary)",
	"#5b8cff",
	"#e99d32",
	"#a26fe0",
	"#df647a",
	"#30a98c",
	"#8d9aa9",
];
export function ReportCharts({
	issues,
	history,
	trends = false,
}: {
	issues: Issue[];
	history: Snapshot[];
	trends?: boolean;
}) {
	const burn = useMemo(() => burnUpDaily(issues), [issues]);
	const weeks = useMemo(() => throughput(issues), [issues]);
	const snapshots = useMemo(() => history.map(h => ({ ...h, time: Date.parse(h.at) })), [history]);
	const stages = MR_STAGES.filter(s => s !== "canceled" && s !== "duplicate");
	return (
		<div className="sms-grid">
			<Card title="Burn-up" description="Tickets created vs closed, cumulative.">
				<Chart
					kind="line"
					stacked={false}
					slots={burn.length}
					tickLabel={i => date(burn[i].time)}
					series={[
						{ key: "created", label: "Created", color: colors[0], values: burn.map(p => p.created) },
						{ key: "closed", label: "Closed", color: colors[1], values: burn.map(p => p.closed) },
					]}
				/>
			</Card>
			<Card title="Closed per week" description="Throughput over the last 12 weeks.">
				<Chart
					kind="bars"
					slots={weeks.length}
					tickLabel={i => date(weeks[i].time)}
					series={[{ key: "closed", label: "Closed", color: colors[0], values: weeks.map(w => w.value) }]}
				/>
			</Card>
			{trends && (
				<>
					<Card title="Status over time" description="All ticket levels; ignores filters.">
						<Chart
							kind="line"
							stacked={false}
							slots={snapshots.length}
							tickLabel={i => date(snapshots[i].time)}
							series={stages.map((stage, i) => ({
								key: stage,
								label: stage,
								color: colors[i % colors.length],
								values: snapshots.map(s => s.by_status[stage] || 0),
							}))}
						/>
					</Card>
					<Card title="Open vs closed over time" description="All ticket levels; ignores filters.">
						<Chart
							kind="line"
							stacked={false}
							slots={snapshots.length}
							tickLabel={i => date(snapshots[i].time)}
							series={[
								{ key: "open", label: "Open", color: colors[0], values: snapshots.map(s => s.open) },
								{ key: "closed", label: "Closed", color: colors[1], values: snapshots.map(s => s.closed) },
							]}
						/>
					</Card>
				</>
			)}
		</div>
	);
}
