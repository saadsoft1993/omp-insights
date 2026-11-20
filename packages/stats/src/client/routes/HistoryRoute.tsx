import { useEffect, useMemo, useState } from "react";
import { getSessions } from "../api";
import { ALL_MACHINES, machineHue, shortMachineName, useFleet, useSelectedMachine } from "../app/machine";
import { MissingMachineNumbers, missingMachineNotes, useOwnsMachineReasons } from "../app/MachineBanner";
import { type FleetQueryMachine, fleetQueryState, useFleetQuery } from "../data/fleet-query";
import { formatEstimatedCost, formatInteger } from "../data/formatters";
import { sessionFolder, sessionRowKey } from "../data/session-rows";
import { getHubSessions, type HubSession } from "../data/hub";
import { historyError, resumeHistory } from "../data/history-actions";
import {
	compactAge,
	historyName,
	historyStatus,
	historySubtitle,
	horizonMachines,
	isRunning,
	subagentCount,
	upsertPage,
	visibleHistory,
	type HistoryRow,
	type HistoryState,
} from "../data/history";
import { getHistorySubagents, historyAfter, type HistorySubagent } from "../data/history-subagents";
import { subagentsFailure, subagentsUnavailable } from "../data/session-subagents";
import { rangeMeta } from "../data/range";
import { useQuery } from "../data/query";
import type { SessionSummary, TimeRange } from "../types";
import {
	formatCompactDuration,
	LabelCell,
	MachineCell,
	MeterCell,
	ModelCell,
	PageHeader,
	StatusCell,
	Table,
	type Column,
} from "../ui";

const LIMIT = 50;
type Props = {
	active: boolean;
	range: TimeRange;
	onTranscript: (file: string, machine?: string) => void;
	onLive: (id: string | null) => void;
};
type Filters = { q: string; folder: string };
type StatusFilter = "All" | "Running" | "Ended" | "Missing file" | "Status unavailable";

export function HistoryRoute(props: Props) {
	const [filters, setFilters] = useState<Filters>({ q: "", folder: "" });
	const [status, setStatus] = useState<StatusFilter>("All");
	const selected = useSelectedMachine();
	const clearFilters = () => {
		setFilters({ q: "", folder: "" });
		setStatus("All");
	};
	return (
		<div className="page stack">
			<style>{`
				.history-compact-meta { display: none; color: var(--ink-3); font-size: 12px; white-space: normal; overflow-wrap: anywhere; }
				.history-first-message { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				/* The all-failed line: headline and reasons in one column, Try again beside it (below it on phones). */
				.history-failed { display: flex; flex-direction: column; flex: 1; min-width: 0; overflow-wrap: anywhere; }
				@container (max-width: 600px) {
					.table--std .std-state:has(> .history-failed) { flex-direction: column; align-items: flex-start; }
				}
				@container (max-width: 1080px) {
					.history-compact-meta { display: block; }
					.cell-secondary:has(.history-compact-meta) { white-space: normal; }
				}
			`}</style>
			<PageHeader
				title="Old sessions"
				description="Session history, including subagents."
				actions={
					<a className="btn" href="#/sessions">
						Live sessions
					</a>
				}
			/>
			<p className="dim">
				Showing sessions active in {rangeMeta(props.range).windowLabel}; change the range in the header.
			</p>
			<div className="history-filters">
				<label>
					Search{" "}
					<input
						className="input"
						placeholder="Search title, first message, folder"
						value={filters.q}
						onChange={e => setFilters({ ...filters, q: e.target.value })}
					/>
				</label>
				<label>
					Folder{" "}
					<input
						className="input"
						placeholder="All folders"
						value={filters.folder}
						onChange={e => setFilters({ ...filters, folder: e.target.value })}
					/>
				</label>
				<label>
					Status{" "}
					<select className="input" value={status} onChange={e => setStatus(e.target.value as StatusFilter)}>
						{["All", "Running", "Ended", "Missing file", "Status unavailable"].map(s => (
							<option key={s}>{s}</option>
						))}
					</select>
				</label>
				<button type="button" className="btn" onClick={clearFilters}>
					Clear
				</button>
			</div>
			<HistoryList
				key={JSON.stringify([selected, filters, props.range])}
				{...props}
				selected={selected}
				filters={filters}
				status={status}
				onClear={clearFilters}
			/>
		</div>
	);
}

function HistoryList({
	active,
	onTranscript,
	onLive,
	selected,
	filters,
	range,
	status,
	onClear,
}: Props & { selected?: string; filters: Filters; status: StatusFilter; onClear: () => void }) {
	const all = selected === ALL_MACHINES;
	const fleetInfo = useFleet();
	const local = selected ?? "";
	const options = { after: historyAfter(range), folder: filters.folder || undefined };
	const key = ["history", filters.q, filters.folder, range];
	const single = useQuery(key, ({ signal }) => getSessions(LIMIT, filters.q, signal, selected, options), {
		enabled: active && !all,
		retain: false,
		pollMs: 30000,
	});
	const fleet = useFleetQuery(
		key,
		async (machine, signal) => ({ machine, rows: await getSessions(LIMIT, filters.q, signal, machine, options) }),
		answers => answers,
		{ enabled: active && all, pollMs: 30000 },
	);
	const live = useQuery(["hub-sessions"], ({ signal }) => getHubSessions(signal), {
		enabled: active,
		pollMs: 5000,
		scope: "local",
	});
	const [state, setState] = useState<HistoryState>({ rows: new Map(), pages: {} });
	const [expanded, setExpanded] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const answers = all ? fleet.data : single.data ? [{ machine: local, rows: single.data }] : null;
	const answerJson = JSON.stringify(answers);
	useEffect(() => {
		const pages = JSON.parse(answerJson) as { machine: string; rows: SessionSummary[] }[] | null;
		if (pages)
			setState(previous => pages.reduce((s, page) => upsertPage(s, page.machine, page.rows, LIMIT, true), previous));
	}, [answerJson]);
	/** Under All machines: a held machine is reconnecting, not failed, so the page waits for it. */
	const fleetState = fleetQueryState(fleet);
	// The failed line below lists each machine's reason: the page's amber banner hides while it shows.
	useOwnsMachineReasons(active && all && !answers && fleetState === "failed");
	const pending = all ? fleet.machines.filter(m => m.ok && !state.pages[m.id]) : [];
	const reachable = new Set(all ? fleet.machines.filter(m => m.ok && state.pages[m.id]).map(m => m.id) : [local]);
	const machineName = (machine: string) => fleetInfo?.find(m => m.id === machine)?.name ?? (machine || "this machine");
	/** The hub's live list answered within the last 15 s: its per-machine health is the freshest there is. */
	const hubFresh =
		!!live.data && !live.error && !live.stale && live.updatedAt !== null && Date.now() - live.updatedAt < 15000;
	const machineHealth = (machine: string) => (hubFresh ? live.data?.machines?.find(m => m.id === machine) : undefined);
	const staleRows = (machine: string) =>
		hubFresh && !!live.data?.sessions.some(s => (s.machine ?? local) === machine && s.stale);
	/**
	 * Reachability is the machine's own `ok`, from the hub's fresh live list when it reports the machine, else the
	 * fleet list. Stale rows only mean down when the hub sends no machine report (an older hub).
	 */
	const machineDown = (machine: string) => {
		const health = machineHealth(machine);
		if (health) return !health.ok;
		if (staleRows(machine)) return true;
		return fleetInfo?.find(m => m.id === machine)?.ok === false;
	};
	/** Held through the hub's grace period: reachable, controls on, but its live rows are the last known state. */
	const machineHeld = (machine: string) => {
		const health = machineHealth(machine);
		if (health) return health.ok && (health.stale === true || staleRows(machine));
		const known = fleetInfo?.find(m => m.id === machine);
		return known?.ok !== false && known?.stale === true;
	};
	const liveKnown = (machine: string) => hubFresh && !machineDown(machine) && !machineHeld(machine);
	const running = new Set(
		(live.data?.sessions ?? [])
			.filter(s => s.sessionId && !s.stale && liveKnown(s.machine ?? local))
			.map(s => `${s.machine ?? local}:${s.sessionId}`),
	);
	const rows = visibleHistory(state, reachable).filter(
		row =>
			(options.after === undefined || row.endedAt >= options.after) &&
			(status === "All" ||
				historyStatus(row, running, liveKnown(row.machine), machineName(row.machine)).label === status),
	);
	const unknownLive = [
		...new Set(rows.filter(row => !row.missing && !liveKnown(row.machine)).map(row => row.machine)),
	].map(machineName);
	/** The machine answered just now: its rows are fresh, not kept from an earlier answer. */
	const fresh = (machine: string) => {
		if (!all) return !single.error;
		const m = fleet.machines.find(item => item.id === machine);
		return m !== undefined && m.error === null && !m.lastKnown && !!state.pages[machine];
	};
	const lastKnownRows = (shown: readonly HistoryRow[]) => {
		const cached = shown.filter(row => !fresh(row.machine));
		return { rows: cached.length, machines: [...new Set(cached.map(row => row.machine))].map(machineName) };
	};
	const maxCost = rows.reduce((max, row) => Math.max(max, row.costTotal), 0);
	const target = horizonMachines(state.pages, reachable);
	const load = async () => {
		setBusy(true);
		try {
			const results = await Promise.allSettled(
				target.map(async machine => {
					const cursor = state.pages[machine].cursor!;
					return {
						machine,
						rows: await getSessions(LIMIT, filters.q, undefined, machine || undefined, {
							...options,
							before: cursor.endedAt,
							beforeFile: cursor.file,
						}),
					};
				}),
			);
			setState(previous =>
				results.reduce(
					(s, result) =>
						result.status === "fulfilled" ? upsertPage(s, result.value.machine, result.value.rows, LIMIT) : s,
					previous,
				),
			);
			for (const result of results)
				if (result.status === "rejected")
					setErrors(previous => ({ ...previous, paging: historyError(result.reason) }));
		} finally {
			setBusy(false);
		}
	};
	const fail = (row: HistoryRow, error: unknown) =>
		setErrors(previous => ({ ...previous, [sessionRowKey(row)]: historyError(error) }));
	const columns: Column<HistoryRow>[] = [
		{
			key: "name",
			header: "Session",
			kind: "text",
			render: r => (
				<LabelCell
					primary={historyName(r)}
					secondary={
						<>
							<span className="history-first-message">{r.firstMessage || r.file.split("/").pop()}</span>
							<span className="history-compact-meta">
								{fleetInfo?.find(m => m.id === r.machine)?.name ?? (r.machine || "Local")} ·{" "}
								{sessionFolder(r.folder, "short")} · {compactAge(r.startedAt)} ·{" "}
								{formatCompactDuration(r.endedAt - r.startedAt)} ·{" "}
								{formatEstimatedCost(r.costTotal, r.unpricedRequests)}
							</span>
						</>
					}
				/>
			),
			sort: historyName,
		},
		{
			key: "machine",
			header: "Machine",
			kind: "machine",
			width: 120,
			priority: 2,
			render: r => {
				const m = fleetInfo?.find(item => item.id === r.machine);
				const name = m?.name ?? (r.machine || "Local");
				return (
					<MachineCell
						name={shortMachineName(name)}
						color={`hsl(${machineHue(name)} 60% 50%)`}
						reachable={!machineDown(r.machine)}
						lastKnown={!machineDown(r.machine) && machineHeld(r.machine)}
						since={
							!machineDown(r.machine) && machineHeld(r.machine)
								? (machineHealth(r.machine)?.staleSince ?? m?.staleSince ?? m?.lastOkAt)
								: m?.lastOkAt
						}
					/>
				);
			},
			sort: r => r.machine,
		},
		{
			key: "folder",
			header: "Folder",
			width: 150,
			priority: 2,
			render: r => (
				<span title={r.folder} style={{ whiteSpace: "nowrap" }}>
					{sessionFolder(r.folder, "short")}
				</span>
			),
			sort: r => r.folder,
		},
		{
			key: "started",
			header: "Started",
			kind: "date",
			width: 100,
			priority: 2,
			render: r => <CompactAge value={r.startedAt} />,
			sort: r => r.startedAt,
		},
		{
			key: "duration",
			header: "Duration",
			kind: "duration",
			align: "right",
			width: 90,
			priority: 3,
			render: r => formatCompactDuration(r.endedAt - r.startedAt),
			sort: r => r.endedAt - r.startedAt,
		},
		{
			key: "models",
			header: "Models",
			kind: "model",
			width: 135,
			priority: 3,
			render: r =>
				r.models.length ? (
					<span title={r.models.join(", ")} style={{ whiteSpace: "nowrap" }}>
						<ModelCell
							name={(r.models[0].split("/").pop() ?? r.models[0]).replace(/^claude-/, "")}
							color="var(--chart-primary)"
						/>
						{r.models.length > 1 && ` +${r.models.length - 1}`}
					</span>
				) : (
					"—"
				),
			sort: r => r.models[0],
		},
		{
			key: "requests",
			header: "Requests",
			kind: "number",
			align: "right",
			width: 85,
			priority: 3,
			render: r => formatInteger(r.requests),
			sort: r => r.requests,
		},
		{
			key: "cost",
			header: "Cost",
			kind: "bar",
			align: "right",
			width: 125,
			priority: 2,
			render: r => (
				<MeterCell
					value={r.costTotal}
					max={maxCost}
					display={formatEstimatedCost(r.costTotal, r.unpricedRequests)}
				/>
			),
			sort: r => r.costTotal,
		},
		{
			key: "status",
			header: "Status",
			kind: "status",
			width: 110,
			render: r => {
				const shown = historyStatus(r, running, liveKnown(r.machine), machineName(r.machine));
				return shown.label === "Status unavailable" ? (
					<span className="dim" title={shown.title} aria-label={shown.title}>
						{shown.text}
					</span>
				) : (
					<StatusCell tone={shown.tone} live={shown.live}>
						{shown.text}
					</StatusCell>
				);
			},
			sort: r => historyStatus(r, running, liveKnown(r.machine), machineName(r.machine)).label,
		},
	];
	return (
		<>
			{all && <MissingMachineNumbers machines={fleet.machines} />}
			{pending.length > 0 && <p role="status">Loading {pending.map(m => m.name).join(", ")}…</p>}
			{unknownLive.length > 0 && (
				<p className="dim" role="status">
					Live status unavailable for {unknownLive.join(", ")}; {unknownLive.length === 1 ? "its" : "their"}{" "}
					sessions show “—” until the hub answers.
				</p>
			)}
			<Table
				variant="std"
				title="Sessions"
				subtitle={historySubtitle({
					loading: pending.length > 0 || (rows.length === 0 && (all ? fleetState === "loading" : single.loading)),
					rows: rows.length,
					lastKnown: lastKnownRows(rows),
					fleet: all
						? {
								answered: fleet.machines.filter(m => fresh(m.id)).length,
								held: fleet.machines.filter(m => m.lastKnown).length,
								failed: fleet.machines.filter(m => m.error !== null && !m.lastKnown).length,
								total: fleet.machines.length,
							}
						: null,
					failedMachine:
						!all && single.error ? (fleetInfo?.find(m => m.id === local)?.name ?? "This machine") : null,
				})}
				columns={columns}
				rows={rows}
				rowKey={sessionRowKey}
				initialSort={{ key: "started", dir: "desc" }}
				loading={
					rows.length === 0 &&
					(pending.length > 0 || (all ? fleetState === "loading" : !answers && single.loading))
				}
				error={
					!answers ? (
						all ? (
							fleetState === "failed" ? (
								<span className="history-failed">
									<span>Could not load sessions from any machine.</span>
									<AllMachineReasons machines={fleet.machines} />
								</span>
							) : null
						) : (
							single.error?.message
						)
					) : null
				}
				onRetry={all ? fleet.refetch : single.refetch}
				retryBusy={all && fleet.checking}
				empty={
					filters.q || filters.folder || status !== "All"
						? "No sessions match these filters."
						: "No sessions in this range."
				}
				emptyAction={
					filters.q || filters.folder || status !== "All" ? (
						<button className="btn" onClick={onClear}>
							Clear filters
						</button>
					) : undefined
				}
				onRowClick={row => setExpanded(previous => (previous === sessionRowKey(row) ? null : sessionRowKey(row)))}
				selectedKey={expanded}
				stale={row => all && fleet.machines.some(m => m.id === row.machine && (!m.ok || m.stale))}
				expanded={row =>
					expanded === sessionRowKey(row) ? (
						<HistoryDetails
							row={row}
							live={isRunning(row, running)}
							liveKnown={liveKnown(row.machine)}
							machineName={machineName(row.machine)}
							activeSession={
								liveKnown(row.machine)
									? live.data?.sessions.find(
											s =>
												s.sessionId &&
												s.sessionId === row.sessionId &&
												(s.machine ?? local) === row.machine &&
												!s.stale,
										)
									: undefined
							}
							reachable={!machineDown(row.machine)}
							error={errors[sessionRowKey(row)]}
							fail={e => fail(row, e)}
							onTranscript={onTranscript}
							onLive={onLive}
						/>
					) : null
				}
			/>
			{errors.paging && <p role="alert">{errors.paging}</p>}
			{target.length > 0 && (
				<button className="btn" disabled={busy} onClick={() => void load()}>
					{busy ? "Loading…" : "Load older"}
				</button>
			)}
		</>
	);
}

/** Each machine's reason under the all-failed line, in the same look as the stats pages (raw cause in its tooltip). */
function AllMachineReasons({ machines }: { machines: FleetQueryMachine[] }) {
	const notes = missingMachineNotes(machines);
	if (!notes.length) return null;
	return (
		<span className="error-state-reasons">
			{notes.map(note => (
				<span key={note.text} title={note.detail ? `Details: ${note.detail}` : undefined}>
					{note.text}
				</span>
			))}
		</span>
	);
}

/** A narrow-column date: "59m ago", full date and time on hover. */
function CompactAge({ value }: { value: number }) {
	const date = new Date(value);
	return (
		<time
			dateTime={date.toISOString()}
			style={{ whiteSpace: "nowrap" }}
			title={`${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(date)} PKT`}
		>
			{compactAge(value)}
		</time>
	);
}

function HistoryDetails({
	row,
	live,
	liveKnown,
	activeSession,
	reachable,
	error,
	fail,
	onTranscript,
	onLive,
	machineName,
}: {
	row: HistoryRow;
	live: boolean;
	liveKnown: boolean;
	machineName: string;
	activeSession?: HubSession;
	reachable: boolean;
	error?: string;
	fail: (e: unknown) => void;
	onTranscript: Props["onTranscript"];
	onLive: Props["onLive"];
}) {
	const children = useQuery(
		["history-subagents", row.machine, row.file, live],
		({ signal }) => getHistorySubagents(row.file, row.machine || undefined, live, signal),
		// When `live` flips the list on screen stays until the new answer lands, instead of dropping to a skeleton.
		{
			enabled: !row.missing && reachable,
			pollMs: live ? 5000 : undefined,
			scope: "local",
			// One expanded row's detail: it says nothing about how often the list itself refreshes.
			countsAsPagePolling: false,
		},
	);
	const childColumns = useMemo<Column<HistorySubagent>[]>(
		() => [
			{
				key: "name",
				header: "Subagent",
				render: child => (
					<LabelCell
						primary={child.title || child.agent || child.id}
						secondary={
							<>
								{child.agent || child.id}
								<span className="history-compact-meta">
									{child.models.join(", ") || "Unknown model"} ·{" "}
									{child.startedAt ? compactAge(child.startedAt) : "Unknown start"} ·{" "}
									{child.durationMs == null ? "Unknown duration" : formatCompactDuration(child.durationMs)} ·{" "}
									{formatEstimatedCost(child.costTotal, 0)}
								</span>
							</>
						}
					/>
				),
				sort: child => child.title || child.agent || child.id,
			},
			{
				key: "model",
				header: "Model",
				kind: "model",
				priority: 2,
				width: 150,
				render: child =>
					child.models.length ? (
						<span title={child.models.join(", ")} style={{ whiteSpace: "nowrap" }}>
							<ModelCell
								name={(child.models[0].split("/").pop() ?? child.models[0]).replace(/^claude-/, "")}
								color="var(--chart-primary)"
							/>
						</span>
					) : (
						"—"
					),
				sort: child => child.models[0],
			},
			{
				key: "start",
				header: "Started",
				kind: "date",
				priority: 2,
				width: 110,
				render: child => (child.startedAt ? <CompactAge value={child.startedAt} /> : "—"),
				sort: child => child.startedAt,
			},
			{
				key: "duration",
				header: "Duration",
				kind: "duration",
				align: "right",
				priority: 3,
				width: 90,
				render: child => (child.durationMs == null ? "—" : formatCompactDuration(child.durationMs)),
				sort: child => child.durationMs,
			},
			{
				key: "cost",
				header: "Cost",
				kind: "money",
				align: "right",
				priority: 3,
				width: 90,
				render: child => formatEstimatedCost(child.costTotal, 0),
				sort: child => child.costTotal,
			},
			{
				key: "status",
				header: "Status",
				kind: "status",
				width: 145,
				render: child => (
					<>
						<StatusCell
							tone={child.status === "running" ? "ok" : child.status === "cut_off" ? "warn" : "neutral"}
							live={child.status === "running"}
						>
							{child.status === "cut_off"
								? "Cut off"
								: child.status === "done"
									? "Done"
									: child.status === "running"
										? "Running"
										: "Unknown"}
						</StatusCell>
						{child.toolErrors > 0 && <span> Errors {child.toolErrors}</span>}
					</>
				),
				sort: child => child.status,
			},
		],
		[],
	);
	return (
		<div className="stack">
			<div>
				<strong>{historyName(row)}</strong>
				{row.firstMessage && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.firstMessage}</p>}
				<p>
					Started: {new Date(row.startedAt).toLocaleString()} · Last write:{" "}
					{new Date(row.endedAt).toLocaleString()}
				</p>
				<p>
					Tool calls: {formatInteger(row.toolCalls)} · Tokens: {formatInteger(row.totalTokens)} · Cost:{" "}
					{formatEstimatedCost(row.costTotal, row.unpricedRequests)} · Unpriced requests:{" "}
					{formatInteger(row.unpricedRequests)}
				</p>
				<p>Models: {row.models.length ? row.models.join(", ") : "None recorded"}</p>
				<p>
					{row.folder} · {formatInteger(row.requests)} requests · {subagentCount(row.subagents)}
				</p>
				<p className="mono">{row.file}</p>
			</div>
			<div className="hub-inline-row">
				{!row.missing && (
					<button className="btn" onClick={() => onTranscript(row.file, row.machine || undefined)}>
						Open transcript
					</button>
				)}
				{activeSession && (
					<button className="btn" onClick={() => onLive(row.sessionId ?? null)}>
						Go to live session
					</button>
				)}
				{!activeSession && !row.missing && row.sessionId && row.cwd && (
					<button
						className="btn"
						disabled={!reachable || !liveKnown}
						title={
							!liveKnown
								? `Live status unavailable for ${machineName}`
								: "Continues the latest copy of this session"
						}
						onClick={() =>
							void resumeHistory(row.sessionId!, row.machine || undefined)
								.then(result => onLive(result.sessionId))
								.catch(fail)
						}
					>
						Resume
					</button>
				)}
				{!activeSession && row.sessionId && (
					<button
						className="btn"
						onClick={() => void navigator.clipboard.writeText(`omp --resume ${row.sessionId}`).catch(fail)}
					>
						Copy resume command
					</button>
				)}
			</div>
			{error && <p role="alert">{error}</p>}
			{!liveKnown && <p role="status">Live status unavailable for {machineName}.</p>}
			{row.missing ? (
				<p>Transcript archived or deleted.</p>
			) : !reachable ? (
				<p className="dim">{subagentsUnavailable(machineName)}</p>
			) : (
				<Table
					variant="std"
					dense
					title="Subagents"
					subtitle="Agents started by this session"
					columns={childColumns}
					rows={children.data ?? []}
					rowKey={child => child.id}
					loading={children.loading}
					error={
						children.error ? (
							<span title={children.error.message}>
								{subagentsFailure(machineName, children.error.message, children.polling)}
							</span>
						) : undefined
					}
					onRetry={children.refetch}
					empty="No subagents recorded."
				/>
			)}
		</div>
	);
}
