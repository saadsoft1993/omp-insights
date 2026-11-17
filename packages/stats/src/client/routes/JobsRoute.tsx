import { type HubJob, getHubJobs } from "../data/hub";
import { gapText, jobOrder, logText, statusCounts, statusLabel } from "../data/hub-view";
import { useQuery } from "../data/query";
import { Badge, Card, EmptyState, PageHeader, QueryView, TableSkeleton } from "../ui";
import { Help } from "./hub-common";
import "./hub.css";

export interface JobsRouteProps {
	active: boolean;
}

const REFRESH_MS = 30_000;

function JobRow({ job, now }: { job: HubJob; now: number }) {
	const status = statusLabel(job);
	return (
		<li className="job-row" data-status={job.status} data-readable={job.readable}>
			<div className="job-main">
				<span className="job-label">{job.label}</span>
				<span className="job-schedule">{job.schedule ?? "schedule unknown"}</span>
			</div>
			<div className="job-state">
				<Badge tone={status.tone}>{status.label}</Badge>
				{job.note && <Badge tone="warn">{job.note}</Badge>}
				<span className="job-log">{logText(job, now)}</span>
			</div>
		</li>
	);
}

export function JobsRoute({ active }: JobsRouteProps) {
	const jobs = useQuery(["hub-jobs"], ({ signal }) => getHubJobs(signal), { enabled: active, pollMs: REFRESH_MS });
	return (
		<div className="page">
			<PageHeader
				title="Jobs"
				description="Scheduled jobs on this Mac (launchd). Read only: nothing here starts, stops or edits a job. Refreshes every 30 seconds."
				actions={
					jobs.data && (
						<span className="job-counts">
							{statusCounts(jobs.data.jobs).map(({ status, count }) => (
								<Badge
									key={status}
									tone={status === "failed" ? "bad" : status === "unknown" ? "warn" : "neutral"}
								>
									{count} {status}
								</Badge>
							))}
						</span>
					)
				}
			/>
			<Help summary="What is this?">
				<p>
					<b>Last exit ok</b> means launchd reports the last run ended with status 0; <b>Failed</b> shows a
					non-zero exit; <b>Running</b> has a process now; <b>Not loaded</b> means launchd does not know the job.
					"Last log write" is when the job's log file last changed, which is not always the last run: a job that
					prints nothing never moves it.
				</p>
				<p>
					<b>Monitoring gaps</b> are stretches when the hub itself was not running (Mac asleep or hub stopped), so
					nothing was watching. Each one sends a single alert that opens this page. A job whose plist cannot be
					read is still listed, marked unreadable plist.
				</p>
			</Help>
			<QueryView
				query={jobs}
				skeleton={<TableSkeleton rows={5} />}
				isEmpty={data => data.jobs.length === 0 && data.gaps.length === 0}
				empty={
					<Card>
						<EmptyState title="No jobs found" hint="No matching launchd agents in ~/Library/LaunchAgents." />
					</Card>
				}
			>
				{data => (
					<>
						{data.gaps.length > 0 && (
							<Card title="Monitoring gaps" description="Mac asleep or hub stopped; the most recent first.">
								<ul className="gap-list">
									{data.gaps.map(g => (
										<li key={`${g.start}-${g.end}`} className="gap-row">
											<span className="gap-time">{gapText(g)}</span>
											<Badge tone={g.alerted ? "neutral" : "warn"}>
												{g.alerted ? "alert sent" : "alert pending"}
											</Badge>
										</li>
									))}
								</ul>
							</Card>
						)}
						<Card title="Scheduled jobs" description={`${data.jobs.length} listed`}>
							<ul className="job-list">
								{[...data.jobs].sort(jobOrder).map(job => (
									<JobRow key={job.file} job={job} now={data.now} />
								))}
							</ul>
						</Card>
					</>
				)}
			</QueryView>
		</div>
	);
}
