import { RotateCw } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../api";
import { getHubJobLogs, getHubJobs, type HubGap, type HubJob, runHubJob } from "../data/hub";
import { useQuery } from "../data/query";
import {
	type Column,
	Drawer,
	EmptyState,
	formatCompactDuration,
	Modal,
	PageHeader,
	SearchInput,
	Segmented,
	Table,
	TableSkeleton,
} from "../ui";
import {
	MachineGroupLabel,
	MachineProblems,
	type OpsMachine,
	OpsMachineCell,
	UpdateHubHint,
	useCapabilities,
	useOpsMachines,
	usePerMachine,
	machineOffline,
	plural,
	unavailableGroups,
	When,
} from "./ops-common";

export interface JobsRouteProps {
	active: boolean;
}

type JobAction = "run" | "restart";
type StateFilter = "all" | "failed" | "overdue" | "running" | "ok" | "not loaded";

interface JobRow extends HubJob {
	machine: OpsMachine;
	stale: boolean;
	key: string;
}

interface GapRow extends HubGap {
	machine: OpsMachine;
}

/**
 * Jobs the hub refuses to run or restart (it would cut off the dashboard or the sessions). Mirrors the hub's
 * own list so their button is off with the reason, instead of failing with 403 after a typed confirmation.
 */
const PROTECTED: Record<string, true> = {
	"herdr-server": true,
	"omp-hub-server": true,
	"omp-relay": true,
	"com.example.herdr-server": true,
	"com.example.omp-hub-server": true,
	"com.example.omp-relay": true,
	"omp-tether.omp-private-relay.relay": true,
};

const STATE: Record<string, { label: string; tone: "accent" | "ok" | "bad" | "neutral" | "warn" }> = {
	running: { label: "Running", tone: "accent" },
	ok: { label: "Last run ok", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	overdue: { label: "Overdue", tone: "warn" },
	"not loaded": { label: "Not loaded", tone: "neutral" },
	unknown: { label: "Unknown", tone: "warn" },
};
const STATE_ORDER: Record<string, number> = { failed: 0, overdue: 1, running: 2, ok: 3, "not loaded": 4, unknown: 5 };

/** No run time to show: launchd reports none (only log file times, when there are logs). */
const NO_RUN_TIME = "this machine doesn't record run times for this job";

/** Loaded and enabled on its machine: the hub refuses to run anything else, and its schedule is not active. */
export function jobLoaded(job: HubJob): boolean {
	return job.loaded !== false && job.status !== "not loaded";
}

/** The state the hub reports, or "unknown" for a value this page does not know. */
export function jobState(job: HubJob): string {
	return job.status === "failed" ? "failed" : job.overdue ? "overdue" : job.status in STATE ? job.status : "unknown";
}

/** Why Run now / Restart is off for this job, or null when the hub would accept it. */
export function jobActionBlocked(job: HubJob): string | null {
	if (PROTECTED[job.label]) return "Protected: the dashboard never restarts herdr, the hub or the relay";
	if (!jobLoaded(job)) return job.note ? `Not loaded: ${job.note}` : "Not loaded: load it first";
	return null;
}

/** The job kind: the hub reports it; an older hub's schedule text is the fallback. */
export function jobKind(job: HubJob): "keepalive" | "scheduled" | "ondemand" {
	if (job.kind) return job.kind;
	if (job.schedule === "keep alive") return "keepalive";
	if (job.schedule === "on demand" || !job.schedule) return "ondemand";
	return "scheduled";
}

/** Short display name; the full label stays in the tooltip and is what the confirmation asks for. */
export function shortJobLabel(label: string): string {
	return label.replace(/^[a-z0-9-]+\.[a-z0-9-]+\./, "");
}

function exitText(job: HubJob): string | null {
	if (!job.exit) return null;
	if (job.exit === "last exit ok") return "ok (exit 0)";
	if (job.exit === "last exit exit-code") return "error exit code";
	return job.exit.replace(/^last exit /, "exit ");
}

/** What a refused or failed action means, in plain words, for the machine it ran on. */
export function jobActionError(error: unknown, machine = "this machine"): string {
	if (error instanceof ApiError) {
		if (error.status === 403)
			return `Protected on ${machine}: ${error.message}. The dashboard never runs or restarts herdr, the hub or the relay, because that could cut off the dashboard or your sessions.`;
		if (error.status === 404) return `Not found on ${machine}: ${error.message}. The list was refreshed.`;
		if (error.status === 409)
			return `Not loaded or disabled on ${machine}: ${error.message}. Load or enable it there first.`;
		if (error.status === 429) {
			const seconds = /(\d+)\s*second/.exec(error.message)?.[1];
			return seconds
				? `Cooling down on ${machine}: try again in ${seconds} seconds.`
				: `Busy on ${machine}: ${error.message}.`;
		}
		if (error.status === 502) return `The command failed on ${machine}: ${error.message}.`;
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export function JobsRoute({ active }: JobsRouteProps) {
	const { machines, all } = useOpsMachines();
	const jobs = usePerMachine("jobs", machines, (id, signal) => getHubJobs(id, signal), { active, pollMs: 30_000 });
	const capabilities = useCapabilities(machines, active);
	const [query, setQuery] = useState("");
	const [state, setState] = useState<StateFilter>("all");
	const [confirm, setConfirm] = useState<{ job: JobRow; action: JobAction } | null>(null);
	const [typed, setTyped] = useState("");
	const [impact, setImpact] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [done, setDone] = useState("");
	const [logJob, setLogJob] = useState<JobRow | null>(null);

	const canAct = (machine: OpsMachine) => capabilities(machine.id)?.jobsActions === true;
	const lacksActions = (machine: OpsMachine) => {
		const caps = capabilities(machine.id);
		return caps !== null && caps.jobsActions !== true;
	};

	const rows: JobRow[] = jobs.answers.flatMap(answer =>
		(answer.data?.jobs ?? []).map(job => ({
			...job,
			machine: answer.machine,
			stale: answer.stale || !answer.machine.reachable,
			key: `${answer.machine.id}:${job.label}`,
		})),
	);
	const counts: Record<StateFilter, number> = {
		all: rows.length,
		failed: 0,
		overdue: 0,
		running: 0,
		ok: 0,
		"not loaded": 0,
	};
	for (const row of rows) {
		const s = jobState(row);
		if (s in counts) counts[s as StateFilter]++;
	}
	const needle = query.trim().toLowerCase();
	const matching = rows.filter(
		row =>
			(state === "all" || jobState(row) === state) &&
			(!needle || row.label.toLowerCase().includes(needle) || row.file.toLowerCase().includes(needle)),
	);
	// Failed jobs come first fleet-wide (their own "Needs attention" group under All machines), so paging
	// never pushes a failure past the first page behind another machine's rows.
	const failed = matching.filter(r => r.status === "failed");
	const shown = [...failed, ...matching.filter(r => r.status !== "failed")];
	const gaps: GapRow[] = jobs.answers.flatMap(answer =>
		(answer.data?.gaps ?? []).map(gap => ({ ...gap, machine: answer.machine })),
	);

	const open = (job: JobRow, action: JobAction) => {
		setTyped("");
		setImpact(false);
		setError("");
		setDone("");
		setConfirm({ job, action });
	};
	const perform = async () => {
		if (!confirm) return;
		setBusy(true);
		setError("");
		try {
			// The person types the name the row shows; the hub checks the full label, which this dialog knows.
			await runHubJob(confirm.job.machine.id, confirm.action, confirm.job.label, confirm.job.label, impact);
			setDone(
				`${confirm.action === "restart" ? "Restart" : "Run"} of ${confirm.job.label} accepted on ${confirm.job.machine.name}.`,
			);
			setConfirm(null);
			jobs.refetch();
		} catch (e) {
			setError(jobActionError(e, confirm.job.machine.name));
			if (e instanceof ApiError && e.status === 404) jobs.refetch();
		} finally {
			setBusy(false);
		}
	};

	const single = machines.length === 1 ? machines[0] : null;
	const columns: Column<JobRow>[] = [
		{
			key: "job",
			header: "Job",
			sort: j => shortJobLabel(j.label),
			render: j => (
				<span className="ops-pc" title={j.label}>
					<span className="ops-state-dot" data-tone={STATE[jobState(j)].tone} aria-hidden="true" />
					<span className="ops-pc-text">
						<span className="ops-pc-title">{shortJobLabel(j.label)}</span>
						<span className="ops-pc-sub">
							{all && j.status === "failed" ? `${j.machine.short} · ` : ""}
							{j.note
								? `${j.file} · ${j.note}`
								: jobLoaded(j)
									? j.file
									: `${j.file} · not loaded: load it first`}
						</span>
					</span>
				</span>
			),
		},
		{
			key: "machine",
			header: "Machine",
			kind: "machine",
			width: 110,
			priority: 2,
			sort: j => j.machine.short,
			render: j => <OpsMachineCell machine={j.machine} />,
		},
		{
			key: "kind",
			header: "Kind",
			width: 150,
			priority: 2,
			sort: j => jobKind(j),
			render: j => {
				const kind = jobKind(j);
				return (
					<span className="ops-pc-text">
						<span className="ops-pc-title">
							{kind === "keepalive" ? "Keeps running" : kind === "scheduled" ? "Scheduled" : "On demand"}
						</span>
						<span className="ops-pc-sub">
							{kind === "keepalive" ? (j.pid ? `pid ${j.pid}` : "no process") : (j.schedule ?? "–")}
						</span>
					</span>
				);
			},
		},
		{
			key: "state",
			header: "State",
			kind: "status",
			width: 116,
			sort: j => STATE_ORDER[jobState(j)] ?? 9,
			render: j => {
				const s = STATE[jobState(j)];
				return (
					<span className="badge" data-tone={s.tone}>
						{s.label}
					</span>
				);
			},
		},
		{
			key: "last",
			header: "Last run",
			kind: "date",
			width: 100,
			sort: j => j.lastRun?.at ?? j.lastLogWrite ?? 0,
			render: j =>
				j.lastRun ? (
					<span className="ops-pc-text">
						{j.lastRun.result && (
							<span
								className="badge"
								data-tone={j.lastRun.result === "success" || j.lastRun.result === "ok" ? "ok" : "bad"}
							>
								{j.lastRun.result}
							</span>
						)}
						<span className="ops-pc-sub">
							{j.lastRun.at != null && <When at={j.lastRun.at} />}
							{j.lastRun.durationS != null && ` · ${formatCompactDuration(j.lastRun.durationS * 1000)}`}
						</span>
					</span>
				) : j.lastLogWrite == null ? (
					<span className="ops-dim" title={NO_RUN_TIME}>
						unknown
					</span>
				) : (
					<span title="When its log was last written: a log write, not necessarily a run">
						<When at={j.lastLogWrite} />
					</span>
				),
		},
		{
			key: "next",
			header: "Next run",
			kind: "date",
			width: 110,
			priority: 3,
			sort: j => (jobLoaded(j) ? (j.nextRun ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER),
			render: j =>
				!jobLoaded(j) ? (
					<span className="ops-dim" title="Not loaded: it will not run until it is loaded">
						—
					</span>
				) : j.nextRun ? (
					<When at={j.nextRun} />
				) : (
					<span className="ops-dim">
						{jobKind(j) === "keepalive"
							? "always on"
							: jobKind(j) === "ondemand"
								? "on demand"
								: (j.schedule ?? "–")}
					</span>
				),
		},
		{
			key: "result",
			header: "Last result",
			width: 130,
			priority: 2,
			sort: j => j.exit ?? "",
			render: j => {
				const text = exitText(j);
				return text ? (
					<span className={j.status === "failed" ? "ops-bad" : "ops-dim"}>{text}</span>
				) : (
					<span className="ops-dim">–</span>
				);
			},
		},
		{
			key: "actions",
			header: "",
			kind: "actions",
			width: 170,
			render: j => {
				if (!canAct(j.machine)) return null;
				const kind = jobKind(j);
				const action: JobAction = kind === "keepalive" ? "restart" : "run";
				const off = machineOffline(j.machine) ?? jobActionBlocked(j);
				return (
					<span className="ops-actions">
						<button
							type="button"
							className="btn"
							data-size="sm"
							disabled={off !== null}
							title={off ?? undefined}
							aria-label={`${action === "restart" ? "Restart" : "Run now"} ${j.label} on ${j.machine.name}`}
							onClick={() => open(j, action)}
						>
							{action === "restart" ? "Restart" : "Run now"}
						</button>
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							aria-label={`Logs of ${j.label} on ${j.machine.name}`}
							onClick={() => setLogJob(j)}
						>
							Logs
						</button>
					</span>
				);
			},
		},
	];

	const filtered = needle !== "" || state !== "all";
	const groupHint = (machine: OpsMachine) =>
		lacksActions(machine) ? <UpdateHubHint machine={machine}>to run jobs and read their logs.</UpdateHubHint> : null;

	return (
		<div className="page ops-page">
			<PageHeader
				title="Jobs"
				description={`Scheduled jobs and services on ${all || !single ? "every machine" : single.name}: launchd on the Macs, systemd on Linux. Refreshes every 30 seconds.`}
			/>
			<div className="ops-toolbar">
				<SearchInput value={query} onChange={setQuery} placeholder="Search jobs" label="Search jobs" />
				<Segmented<StateFilter>
					size="sm"
					aria-label="State"
					value={state}
					onChange={setState}
					options={(["all", "failed", "overdue", "running", "ok", "not loaded"] as const).map(value => ({
						value,
						label: (
							<>
								{value === "all"
									? "All"
									: value === "failed"
										? "Failed"
										: value === "overdue"
											? "Overdue"
											: value === "running"
												? "Running"
												: value === "ok"
													? "Ok"
													: "Not loaded"}
								{!jobs.loading && <span className="ops-count">{counts[value]}</span>}
							</>
						),
					}))}
				/>
			</div>
			<MachineProblems answers={jobs.answers} what="the jobs list" onRetry={jobs.refetch} polling={jobs.polling} />
			{!all && single && lacksActions(single) && <p className="ops-hint">{groupHint(single)}</p>}
			{done && (
				<p className="hub-notice" role="status">
					{done}
				</p>
			)}
			<Table
				variant="std"
				dense
				title="Jobs"
				subtitle={`${shown.length} jobs · failed ones stay on top · Run now and Restart ask you to type the job's label`}
				columns={columns}
				rows={shown}
				rowKey={j => j.key}
				loading={jobs.loading}
				limit={200}
				initialSort={{ key: "state", dir: "asc" }}
				pinned={j => j.status === "failed"}
				emptyGroups={
					all ? unavailableGroups(jobs.answers, id => rows.some(r => r.machine.id === id), "jobs") : undefined
				}
				stale={j => j.stale}
				group={
					all
						? j =>
								j.status === "failed"
									? {
											key: "needs-attention",
											label: (
												<span className="ops-group">
													<span className="ops-state-dot" data-tone="bad" aria-hidden="true" />
													<b>Needs attention</b>
													<span className="ops-dim">
														{failed.length} failed on {new Set(failed.map(r => r.machine.id)).size} of{" "}
														{machines.length} machines
													</span>
												</span>
											),
										}
									: {
											key: j.machine.id,
											label: (
												<MachineGroupLabel
													machine={j.machine}
													count={plural(
														shown.filter(r => r.machine.id === j.machine.id && r.status !== "failed")
															.length,
														"job",
													)}
													hint={groupHint(j.machine)}
												/>
											),
										}
						: undefined
				}
				empty={
					filtered ? (
						<EmptyState title="No job matches" hint="Clear the search or pick another state." />
					) : (
						<EmptyState title="No jobs found" hint="No launchd agents or systemd user units were listed." />
					)
				}
				emptyAction={
					filtered ? (
						<button
							type="button"
							className="btn"
							data-size="sm"
							onClick={() => {
								setQuery("");
								setState("all");
							}}
						>
							Clear
						</button>
					) : undefined
				}
			/>
			{gaps.length > 0 && (
				<Table
					variant="std"
					dense
					title="Monitoring gaps"
					subtitle="Times the hub could not check its jobs (machine asleep or hub stopped), newest first"
					columns={[
						{
							key: "machine",
							header: "Machine",
							kind: "machine",
							width: 120,
							sort: g => g.machine.short,
							render: g => <OpsMachineCell machine={g.machine} />,
						},
						{
							key: "from",
							header: "From",
							kind: "date",
							sort: g => g.start,
							render: g => (
								<span title={`${new Date(g.start).toLocaleString()} – ${new Date(g.end).toLocaleString()}`}>
									{new Intl.DateTimeFormat("en-GB", {
										day: "numeric",
										month: "short",
										hour: "2-digit",
										minute: "2-digit",
										timeZone: "Asia/Karachi",
									}).format(new Date(g.start))}{" "}
									PKT
								</span>
							),
						},
						{
							key: "length",
							header: "Length",
							kind: "duration",
							width: 100,
							sort: g => g.end - g.start,
							render: g => <span className="num">{formatCompactDuration(g.end - g.start)}</span>,
						},
						{
							key: "alerted",
							header: "Alert",
							width: 120,
							sort: g => Number(g.alerted),
							render: g =>
								g.alerted ? (
									<span className="badge" data-tone="ok">
										Alert sent
									</span>
								) : (
									<span className="badge">Alert pending</span>
								),
						},
					]}
					rows={gaps}
					rowKey={g => `${g.machine.id}:${g.start}-${g.end}`}
					limit={5}
					initialSort={{ key: "from", dir: "desc" }}
					group={
						all
							? g => ({
									key: g.machine.id,
									label: (
										<MachineGroupLabel
											machine={g.machine}
											count={plural(gaps.filter(r => r.machine.id === g.machine.id).length, "gap")}
										/>
									),
								})
							: undefined
					}
				/>
			)}
			<Modal
				open={!!confirm}
				title={
					confirm
						? `${confirm.action === "restart" ? "Restart" : "Run"} ${shortJobLabel(confirm.job.label)}${confirm.action === "run" ? " now" : ""} on ${confirm.job.machine.name}?`
						: ""
				}
				onClose={() => {
					if (!busy) setConfirm(null);
				}}
				primaryAction={{
					label: busy ? "Working…" : confirm?.action === "restart" ? "Restart" : "Run now",
					onClick: perform,
					disabled:
						busy || !confirm || typed !== shortJobLabel(confirm.job.label) || (!!confirm.job.impact && !impact),
				}}
			>
				{confirm && (
					<div className="ops-confirm">
						<p>
							{confirm.action === "restart"
								? "The service stops and starts again; anything it is doing right now is cut off."
								: "The job starts now, outside its schedule."}
						</p>
						<label className="ops-field">
							<span>
								Type <code>{shortJobLabel(confirm.job.label)}</code> to confirm
								{shortJobLabel(confirm.job.label) !== confirm.job.label && (
									<span className="ops-dim"> · full label {confirm.job.label}</span>
								)}
							</span>
							<input
								className="input"
								type="text"
								value={typed}
								autoComplete="off"
								spellCheck={false}
								onChange={e => setTyped(e.target.value)}
								aria-label="Job name"
							/>
							{typed !== "" && !shortJobLabel(confirm.job.label).startsWith(typed) && (
								<span className="ops-field-hint" role="status">
									Doesn't match yet: type <code>{shortJobLabel(confirm.job.label)}</code> exactly.
								</span>
							)}
						</label>
						{confirm.job.impact && (
							<label className="ops-check">
								<input
									type="checkbox"
									checked={impact}
									onChange={() => setImpact(value => !value)}
									aria-label="I understand the impact"
								/>
								<span>I understand: {confirm.job.impact}</span>
							</label>
						)}
						{error && (
							<p className="hub-notice" data-tone="bad" role="alert">
								{error}
							</p>
						)}
					</div>
				)}
			</Modal>
			<JobLogs job={logJob} active={active} onClose={() => setLogJob(null)} />
		</div>
	);
}

/** The Logs drawer: the job's stdout and stderr (launchd) or journal (systemd), already redacted by the hub. */
function JobLogs({ job, active, onClose }: { job: JobRow | null; active: boolean; onClose: () => void }) {
	const logs = useQuery(
		["hub-job-logs", job?.machine.id, job?.label],
		({ signal }) => getHubJobLogs(job!.machine.id, job!.label, signal),
		{ enabled: active && !!job, scope: "local", retain: false },
	);
	return (
		<Drawer
			open={!!job}
			title={job ? `Logs · ${shortJobLabel(job.label)}` : "Logs"}
			subtitle={job ? `${job.label} on ${job.machine.name}` : undefined}
			onClose={onClose}
			width={720}
			actions={
				<button
					type="button"
					className="btn"
					data-size="sm"
					data-variant="ghost"
					onClick={logs.refetch}
					disabled={logs.refreshing}
				>
					<RotateCw size={13} /> Refresh
				</button>
			}
		>
			{logs.data === null ? (
				logs.error ? (
					<p className="hub-notice" data-tone="bad" role="alert">
						Could not read the logs: {jobActionError(logs.error, job?.machine.name)}
					</p>
				) : (
					<TableSkeleton rows={4} />
				)
			) : (
				<div className="ops-logs">
					{logs.error && (
						<p className="hub-notice" data-tone="bad" role="alert">
							Could not refresh: {logs.error.message}
						</p>
					)}
					{logs.data.truncated && (
						<p className="ops-hint" role="note">
							Truncated: only the newest part of the log is shown.
						</p>
					)}
					{logs.data.journal !== undefined ? (
						<section data-empty={!logs.data.journal}>
							<h3>Journal</h3>
							<pre>{logs.data.journal || "No output"}</pre>
						</section>
					) : (
						<>
							<section data-empty={!logs.data.stdout}>
								<h3>stdout</h3>
								<pre>{logs.data.stdout || "No output"}</pre>
							</section>
							<section data-empty={!logs.data.stderr}>
								<h3>stderr</h3>
								<pre>{logs.data.stderr || "No output"}</pre>
							</section>
						</>
					)}
				</div>
			)}
		</Drawer>
	);
}
