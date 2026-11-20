import { Play, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ALL_MACHINES,
	type FleetMachine,
	machineView,
	shortMachineName,
	useFleet,
	useSelectedMachine,
} from "../app/machine";
import { formatCost } from "../data/formatters";
import {
	createProject,
	getHubLink,
	getHubProjects,
	getHubSessions,
	getProjectParents,
	type HubProject,
	type HubSession,
	type HubSessionsMachine,
	type HubStarted,
	startHubSession,
} from "../data/hub";
import { needsYou } from "../data/plan-review";
import { useQuery } from "../data/query";
import { sessionDisplayName } from "../data/session-controls";
import {
	getSessionSubagents,
	type SessionSubagent,
	SUBAGENT_STATUS,
	subagentsFailure,
	subagentsUnavailable,
} from "../data/session-subagents";
import {
	type NotesChoice,
	outcomeText,
	PENDING_TEXT,
	type PlanNotesAccepted,
	pollPlanNotes,
	postPlanNotes,
} from "../data/session-plan-notes";
import { ApiError } from "../api";
import { newMessageId } from "../data/session-ask";
import { createAndStartProject, sessionOpenUrl, validProjectName } from "../data/session-start";
import {
	sessionsSubtitle,
	machineDown,
	machineHeld,
	matchesFilter,
	projectFolder,
	providerColor,
	rowKey,
	sessionKey,
	sessionStatus,
	shortModelName,
} from "../data/session-view";
import {
	EmptyState,
	formatCompactDuration,
	LabelCell,
	MachineCell,
	Modal,
	ModelCell,
	PageHeader,
	RelativeDateCell,
	SearchInput,
	StatusCell,
	Table,
	TableSkeleton,
} from "../ui";
import { ago, type Notice, NoticeLine } from "./hub-common";
import { type NotesJob, SessionDrawer } from "./SessionDrawer";

export interface SessionsRouteProps {
	active: boolean;
	/** Session named by the URL (`#/sessions/<sessionId>`), or null for the list. */
	selected: string | null;
	onSelect: (key: string | null) => void;
}

const REFRESH_MS = 5000;
const MAX_PROJECTS = 60;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * collab-web is its own origin (:8796): open it in a new tab, never inside the dashboard. The tab is
 * opened during the click itself (Safari blocks tabs opened after an await) and cut off from this page
 * before the link is fetched, so the link is current and the opened page can't reach back in here.
 */
export async function openSession(instanceId: string, view: boolean, machine?: string): Promise<void> {
	const tab = window.open("about:blank", "_blank");
	if (tab) tab.opener = null;
	try {
		const link = await getHubLink(instanceId, view, machine);
		const url = sessionOpenUrl(link);
		if (tab) tab.location.replace(url);
		else window.open(url, "_blank", "noopener,noreferrer");
	} catch (error) {
		tab?.close();
		throw error;
	}
}

function machineColor(name: string): string {
	return machineView(name)?.accent ?? "#6c6c74";
}

export function SessionsRoute({ active, selected, onSelect }: SessionsRouteProps) {
	// The hub's own aggregated list (every machine in fleet mode); the header machine filters it here.
	const sessions = useQuery(["hub-sessions"], ({ signal }) => getHubSessions(signal), {
		enabled: active,
		pollMs: REFRESH_MS,
		scope: "local",
	});
	const fleet = useFleet();
	const picked = useSelectedMachine();
	const all = !fleet || picked === undefined || picked === ALL_MACHINES;
	const [notice, setNotice] = useState<Notice | null>(null);
	const [filter, setFilter] = useState("");
	const [expanded, setExpanded] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const [notesJobs, setNotesJobs] = useState<Record<string, NotesJob>>({});
	const data = sessions.data;
	const pollers = useRef(new Map<string, AbortController>());
	useEffect(() => {
		const running = pollers.current;
		return () => {
			for (const controller of running.values()) controller.abort();
		};
	}, []);

	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of fleet ?? []) map.set(m.id, m.name);
		for (const m of data?.machines ?? []) map.set(m.id, m.name);
		return map;
	}, [fleet, data?.machines]);
	const nameOf = useCallback((s: HubSession) => names.get(s.machine ?? "") ?? s.machine ?? "This machine", [names]);

	const rows = useMemo(() => {
		const list = data?.sessions ?? [];
		return list.filter(s => (all || s.machine === picked) && matchesFilter(s, filter, nameOf(s)));
	}, [data?.sessions, all, picked, filter, nameOf]);
	const scoped = useMemo(() => (data?.sessions ?? []).filter(s => all || s.machine === picked), [data, all, picked]);

	// The URL names a session id; an execute moves the instance to a new id, so follow the instance.
	const followed = useRef<{ machine?: string; instanceId: string } | null>(null);
	const current = useMemo(() => {
		if (!selected || !data) return undefined;
		const direct = data.sessions.find(s => sessionKey(s) === selected || s.instanceId === selected);
		if (direct) return direct;
		const f = followed.current;
		return f ? data.sessions.find(s => s.instanceId === f.instanceId && s.machine === f.machine) : undefined;
	}, [selected, data]);
	useEffect(() => {
		if (current) followed.current = { machine: current.machine, instanceId: current.instanceId };
		if (current && selected && sessionKey(current) !== selected && current.instanceId !== selected)
			onSelect(sessionKey(current));
	}, [current, selected, onSelect]);

	const open = (s: HubSession, view: boolean) => {
		setNotice(null);
		openSession(s.instanceId, view, s.machine).catch((error: unknown) => {
			setNotice({ tone: "bad", text: `Could not open: ${errorText(error)}` });
			sessions.refetch();
		});
	};

	const jobKey = (s: HubSession) => `${s.machine ?? ""}:${s.instanceId}`;
	const setJob = (key: string, job: NotesJob) => setNotesJobs(jobs => ({ ...jobs, [key]: job }));

	/** Read-only polling of one request; also what "Check again" runs. Never sends the approval again. */
	const follow = (
		key: string,
		instanceId: string,
		requestId: string,
		machine: string | undefined,
		controller: AbortController,
	) => {
		setJob(key, { state: "pending", tone: "warn", text: PENDING_TEXT });
		pollPlanNotes({ instanceId, requestId, machine, signal: controller.signal })
			.then(outcome => {
				if (controller.signal.aborted) return;
				setJob(key, {
					state: "done",
					tone:
						outcome.state === "sent"
							? "ok"
							: outcome.state === "unknown" || outcome.state === "unconfirmed"
								? "warn"
								: "bad",
					text: outcomeText(outcome),
					...(outcome.state === "unknown" || outcome.state === "unconfirmed"
						? { recheck: { instanceId, requestId, machine } }
						: {}),
				});
				sessions.refetch();
			})
			.catch(() => undefined)
			.finally(() => {
				if (pollers.current.get(key) === controller) pollers.current.delete(key);
			});
	};

	/** The controller is registered before the POST, so leaving the page aborts a late reply's follow-up too. */
	const claim = (key: string) => {
		pollers.current.get(key)?.abort();
		const controller = new AbortController();
		pollers.current.set(key, controller);
		return controller;
	};

	const startNotes = async (
		s: HubSession,
		request: { reviewId: string; choice: NotesChoice; notes: string; role?: string },
	) => {
		const key = jobKey(s);
		const requestId = newMessageId("plan");
		const controller = claim(key);
		let accepted: PlanNotesAccepted | "in-use";
		try {
			accepted = await postPlanNotes(
				s.instanceId,
				{ sessionId: s.sessionId ?? "", requestId, ...request },
				s.machine,
			);
		} catch (error) {
			// Already submitted under this id (a network retry): follow it instead of failing.
			if (!(error instanceof ApiError && error.code === "request_in_use")) {
				if (pollers.current.get(key) === controller) pollers.current.delete(key);
				throw error;
			}
			accepted = "in-use";
		}
		if (controller.signal.aborted) return;
		if (accepted !== "in-use" && accepted.notes === "sent") {
			pollers.current.delete(key);
			setJob(key, { state: "done", tone: "ok", text: outcomeText({ state: "sent" }) });
			return;
		}
		if (accepted !== "in-use" && accepted.notes === "failed") {
			pollers.current.delete(key);
			setJob(key, {
				state: "done",
				tone: "bad",
				text: outcomeText({ state: "failed", reason: accepted.reason ?? "no reason given" }),
			});
			return;
		}
		follow(key, s.instanceId, requestId, s.machine, controller);
	};

	const recheckNotes = (s: HubSession) => {
		const key = jobKey(s);
		const job = notesJobs[key];
		if (!job?.recheck) return;
		const { instanceId, requestId, machine } = job.recheck;
		follow(key, instanceId, requestId, machine, claim(key));
	};

	const unreachable = (data?.machines ?? []).filter(m => !m.ok && (all || m.id === picked));
	const held = (data?.machines ?? []).filter(m => m.ok && m.stale === true && (all || m.id === picked));
	// Under All machines every machine gets a group: one without sessions says so instead of vanishing. With no
	// sessions anywhere the table's own empty state shows instead, with its Start action.
	const emptyGroups =
		fleet && all && data && !filter && scoped.length > 0
			? (data.machines ?? fleet.map((m): HubSessionsMachine => ({ id: m.id, name: m.name, ok: m.ok })))
					.filter(m => !scoped.some(s => s.machine === m.id))
					.map(m => ({
						key: m.id,
						label: (
							<MachineCell
								name={m.name}
								color={machineColor(m.name)}
								reachable={m.ok !== false}
								lastKnown={m.ok !== false && m.stale === true}
								since={m.staleSince}
							/>
						),
						note:
							m.ok === false
								? `${m.name} is unreachable; its sessions are unknown`
								: `${m.name}: no live sessions`,
					}))
			: undefined;
	const down = current ? machineDown(current, data?.machines) : null;
	const live = !sessions.error && !sessions.stale;

	return (
		<div className="page">
			<PageHeader
				title="Sessions"
				description={
					data
						? `Live omp sessions ${fleet ? (all ? "on every machine" : `on ${names.get(picked ?? "") ?? picked}`) : "on this machine"}. Updated ${new Date(data.now).toLocaleTimeString()} · refreshes every 5 seconds.`
						: `Live omp sessions ${fleet ? "on every machine" : "on this machine"}.`
				}
				actions={
					<>
						<a className="btn" data-variant="ghost" href="#/history">
							Old sessions
						</a>
						<button type="button" className="btn" data-variant="primary" onClick={() => setStarting(true)}>
							<Plus size={14} /> Start a session
						</button>
					</>
				}
			/>
			{unreachable.length > 0 && (
				<p className="sd-unreachable" role="status">
					{unreachable
						.map(
							m =>
								`${m.name} is unreachable${m.staleSince ? ` since ${new Date(m.staleSince).toLocaleTimeString()}` : ""}`,
						)
						.join("; ")}
					. {unreachable.length === 1 ? "Its" : "Their"} rows are the last known state, greyed, with every control
					off.
				</p>
			)}
			{held.length > 0 && (
				<p className="dim" role="status">
					{held
						.map(
							m =>
								`${m.name} missed its last check${m.staleSince ? ` (last answer ${new Date(m.staleSince).toLocaleTimeString()})` : ""}`,
						)
						.join("; ")}
					. {held.length === 1 ? "Its" : "Their"} rows are the last known state; controls stay on while the hub
					reconnects.
				</p>
			)}
			<NoticeLine notice={notice} />
			<Table<HubSession>
				variant="std"
				title="Live sessions"
				subtitle={
					data
						? sessionsSubtitle(
								scoped,
								(data.machines ?? []).filter(m => all || m.id === picked),
								rows.length,
							)
						: undefined
				}
				tools={
					<SearchInput value={filter} onChange={setFilter} placeholder="Filter sessions" label="Filter sessions" />
				}
				rows={rows}
				rowKey={rowKey}
				loading={!data && !sessions.error}
				error={!data && sessions.error ? `Could not load the sessions: ${sessions.error.message}` : undefined}
				onRetry={sessions.refetch}
				empty={
					filter ? (
						<EmptyState title="No session matches" hint={`Nothing matches “${filter}”.`} />
					) : (
						<EmptyState title="No live omp sessions" hint="Start one, or run omp on a machine." />
					)
				}
				emptyAction={
					filter ? (
						<button type="button" className="btn" data-size="sm" onClick={() => setFilter("")}>
							Clear the filter
						</button>
					) : (
						<button type="button" className="btn" data-size="sm" onClick={() => setStarting(true)}>
							Start a session
						</button>
					)
				}
				initialSort={{ key: "started", dir: "desc" }}
				emptyGroups={emptyGroups}
				pinned={s => !s.stale && needsYou(s)}
				stale={s => Boolean(s.stale)}
				selectedKey={current ? rowKey(current) : null}
				onRowClick={s => onSelect(sessionKey(s))}
				onToggle={s => setExpanded(on => (on === rowKey(s) ? null : rowKey(s)))}
				group={
					fleet && all
						? s => {
								const m = data?.machines?.find(item => item.id === s.machine);
								const name = nameOf(s);
								return {
									key: s.machine ?? "",
									label: (
										<>
											<MachineCell
												name={name}
												color={machineColor(name)}
												reachable={m?.ok !== false}
												lastKnown={machineHeld(s, data?.machines)}
												since={m?.staleSince}
											/>
										</>
									),
								};
							}
						: undefined
				}
				expanded={s =>
					expanded === rowKey(s) ? (
						<SessionSubagents
							session={s}
							machineName={nameOf(s)}
							down={machineDown(s, data?.machines) !== null}
							parentLive={live && !s.stale}
						/>
					) : null
				}
				columns={[
					{
						key: "session",
						header: "Session",
						sort: s => sessionDisplayName(s).toLowerCase(),
						render: s => {
							const status = sessionStatus(s);
							const sub = [
								s.herdr?.workspace ? "herdr" : null,
								s.herdr?.tab ?? null,
								s.agentsRunning
									? `${s.agentsRunning} subagent${s.agentsRunning === 1 ? "" : "s"} running`
									: null,
								s.planReview ? "plan to approve" : null,
							].filter(Boolean);
							return (
								<LabelCell
									lead={
										<span
											className="sd-dot"
											data-tone={status.tone}
											data-live={status.live}
											aria-hidden="true"
										/>
									}
									primary={sessionDisplayName(s)}
									secondary={sub.length ? sub.join(" · ") : (s.workspace ?? "Other")}
								/>
							);
						},
					},
					...(fleet
						? [
								{
									key: "machine",
									width: 160,
									header: "Machine",
									kind: "machine" as const,
									priority: 2 as const,
									sort: (s: HubSession) => nameOf(s),
									render: (s: HubSession) => (
										<MachineCell
											name={shortMachineName(nameOf(s))}
											color={machineColor(nameOf(s))}
											reachable={machineDown(s, data?.machines) === null}
											lastKnown={machineHeld(s, data?.machines)}
											since={data?.machines?.find(m => m.id === s.machine)?.staleSince}
										/>
									),
								},
							]
						: []),
					{
						key: "project",
						width: 170,
						header: "Project",
						priority: 2,
						sort: s => projectFolder(s),
						render: s => <LabelCell primary={projectFolder(s) || "—"} secondary={s.workspace ?? "Other"} />,
					},
					{
						key: "status",
						width: 120,
						header: "Status",
						kind: "status",
						sort: s => sessionStatus(s).label,
						render: s => {
							const status = sessionStatus(s);
							return (
								<StatusCell tone={status.tone} live={status.live}>
									{status.label}
								</StatusCell>
							);
						},
					},
					{
						key: "model",
						width: 120,
						header: "Model",
						kind: "model",
						priority: 3,
						sort: s => s.model?.id ?? null,
						render: s =>
							s.model?.id ? (
								<span title={`${s.model.provider ?? ""}/${s.model.id}`}>
									<ModelCell name={shortModelName(s.model.id)} color={providerColor(s.model.provider)} />
								</span>
							) : (
								"—"
							),
					},
					{
						key: "started",
						width: 110,
						header: "Started",
						kind: "date",
						priority: 3,
						sort: s => s.startedAt ?? null,
						render: s => (s.startedAt ? <RelativeDateCell value={s.startedAt} now={data?.now} /> : "—"),
					},
					{
						key: "activity",
						width: 120,
						header: "Last activity",
						kind: "date",
						priority: 2,
						sort: s => s.lastActivityAt ?? null,
						render: s =>
							s.lastActivityAt ? (
								<RelativeDateCell value={s.lastActivityAt} now={data?.now} />
							) : (
								<span
									title={
										s.lastActivityAt === undefined
											? "Update this machine's hub to show it"
											: "Not recorded yet"
									}
								>
									—
								</span>
							),
					},
					{
						key: "cost",
						width: 110,
						header: "Cost so far",
						kind: "money",
						sort: s => s.costSoFar ?? null,
						render: s =>
							typeof s.costSoFar === "number" ? (
								formatCost(s.costSoFar)
							) : (
								<span
									title={
										s.costSoFar === undefined ? "Update this machine's hub to show it" : "Not recorded yet"
									}
								>
									—
								</span>
							),
					},
				]}
			/>
			{selected && data && !current && (
				<Modal open title="Session ended" onClose={() => onSelect(null)} cancelLabel="Back to sessions">
					<p>
						It is no longer running, or it stopped sharing. Its transcript stays on the machine: find it in Old
						sessions.
					</p>
				</Modal>
			)}
			{current && (
				<SessionDrawer
					key={`${current.machine ?? ""}:${current.instanceId}`}
					session={current}
					now={data?.now ?? Date.now()}
					machineName={nameOf(current)}
					down={down}
					active={active}
					onClose={() => onSelect(null)}
					onOpen={open}
					onChanged={sessions.refetch}
					onEnded={n => {
						setNotice(n);
						onSelect(null);
					}}
					notesJob={notesJobs[jobKey(current)] ?? null}
					startNotes={startNotes}
					onRecheckNotes={() => recheckNotes(current)}
				/>
			)}
			<StartDialog
				open={starting}
				active={active}
				fleet={fleet}
				header={all ? null : (picked ?? null)}
				onClose={() => setStarting(false)}
				onStarted={sessions.refetch}
			/>
		</div>
	);
}

/**
 * A live row's subagents. An unreachable machine is not asked (a held one is, without `parentLive`); any request gives up after
 * `SUBAGENTS_TIMEOUT_MS` with an error and Try again. When `parentLive` flips, the list on screen stays until the
 * new answer lands, so a flapping machine never drops it back to a skeleton.
 */
function SessionSubagents({
	session,
	machineName,
	down,
	parentLive,
}: {
	session: HubSession;
	machineName: string;
	down: boolean;
	parentLive: boolean;
}) {
	const list = useQuery(
		["live-subagents", session.machine ?? "", session.sessionId ?? "", parentLive],
		async ({ signal }) => ({ items: await getSessionSubagents(session, parentLive, signal) }),
		// One expanded row's detail: the page's own refresh is the sessions list.
		{ scope: "local", enabled: !down, pollMs: 15_000, countsAsPagePolling: false },
	);
	if (down) return <p className="sd-hint">{subagentsUnavailable(machineName)}</p>;
	if (list.error)
		return (
			<div className="sd-row">
				<p className="sd-hint" data-tone="bad" role="alert" title={list.error.message}>
					{subagentsFailure(machineName, list.error.message, list.polling)}
				</p>
				<button type="button" className="btn" data-size="sm" onClick={list.refetch}>
					Try again
				</button>
			</div>
		);
	if (list.data === null) return <TableSkeleton rows={2} />;
	if (list.data.items === null)
		return (
			<p className="sd-hint">The transcript is not indexed yet; the list shows once the machine's stats catch up.</p>
		);
	return (
		<div className="sd-nested">
			<Table<SessionSubagent>
				variant="std"
				dense
				rows={list.data.items}
				rowKey={a => a.id}
				limit={10}
				empty={<EmptyState title="No subagents" hint="This session has not started any." />}
				columns={[
					{
						key: "name",
						header: "Subagent",
						render: a => <LabelCell primary={a.title ?? a.agent ?? a.id} secondary={a.agent ?? undefined} />,
					},
					{
						key: "model",
						header: "Model",
						kind: "model",
						priority: 2,
						render: a =>
							a.models.length ? (
								<ModelCell
									name={shortModelName(a.models[0].split("/").pop())}
									color={providerColor(a.models[0].split("/")[0])}
								/>
							) : (
								"—"
							),
					},
					{
						key: "started",
						header: "Started",
						kind: "date",
						priority: 3,
						render: a => <RelativeDateCell value={a.startedAt} />,
					},
					{
						key: "duration",
						header: "Duration",
						kind: "duration",
						priority: 2,
						render: a => formatCompactDuration(a.durationMs),
					},
					{
						key: "cost",
						header: "Cost",
						kind: "money",
						render: a => formatCost(a.costTotal),
					},
					{
						key: "status",
						header: "Status",
						kind: "status",
						render: a => (
							<span className="sd-row">
								<StatusCell tone={SUBAGENT_STATUS[a.status].tone} live={a.status === "running"}>
									{SUBAGENT_STATUS[a.status].label}
								</StatusCell>
								{a.toolErrors > 0 && (
									<span className="sd-hint" data-tone="bad">
										{a.toolErrors} tool error{a.toolErrors === 1 ? "" : "s"}
									</span>
								)}
							</span>
						),
					},
				]}
			/>
		</div>
	);
}

function startedText(project: HubProject, r: HubStarted): string {
	const where = r.herdrWorkspace ? `herdr: ${r.herdrWorkspace} › ${r.tab ?? "omp"}` : "a new herdr tab";
	return r.instanceId
		? `Started ${project.name} in ${where}. It is listed now: click its row for its controls.`
		: `Started ${project.name} in ${where}; it is not sharing yet and shows up in a few seconds.`;
}

/** The Start dialog: on the header machine, or (under All machines) the machine picked first. */
function StartDialog({
	open,
	active,
	fleet,
	header,
	onClose,
	onStarted,
}: {
	open: boolean;
	active: boolean;
	fleet: FleetMachine[] | null;
	header: string | null;
	onClose: () => void;
	onStarted: () => void;
}) {
	const [picked, setPicked] = useState<string | null>(null);
	const chosen = header ?? picked;
	const startOn = fleet ? (fleet.find(m => m.id === chosen && m.ok)?.id ?? null) : "";
	const machineName = fleet?.find(m => m.id === startOn)?.name ?? "this machine";
	const enabled = open && active && startOn !== null;
	const projects = useQuery(["hub-projects", startOn], ({ signal }) => getHubProjects(startOn ?? "", signal), {
		enabled,
		scope: "local",
		// Never show another machine's projects while this one's list loads: Start would send a foreign path.
		retain: false,
	});
	const parents = useQuery(["project-parents", startOn], ({ signal }) => getProjectParents(startOn ?? "", signal), {
		enabled,
		scope: "local",
		retain: false,
	});
	const [newFolder, setNewFolder] = useState(false);
	const [parent, setParent] = useState("");
	const [folderName, setFolderName] = useState("");
	const [initializeGit, setInitializeGit] = useState(true);
	const projectsReady = projects.data !== null && !projects.error;
	const [query, setQuery] = useState("");
	const [starting, setStarting] = useState<string | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);

	// Everything chosen in the form belongs to one machine: a new target starts it over.
	useEffect(() => {
		setNewFolder(false);
		setParent("");
		setFolderName("");
		setInitializeGit(true);
		setQuery("");
		setNotice(null);
	}, [startOn]);
	const parentChoices = useMemo(
		() => [...new Set([...(parents.data?.roots ?? []), ...(parents.data?.parents ?? [])])],
		[parents.data],
	);
	const parentOk = parent !== "" && parentChoices.includes(parent);

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (projects.data?.projects ?? [])
			.filter(p => !q || p.label.toLowerCase().includes(q))
			.slice(0, MAX_PROJECTS);
	}, [projects.data, query]);

	const start = async (project: HubProject) => {
		if (!projectsReady || startOn === null) return;
		setStarting(project.path);
		setNotice(null);
		try {
			const r = await startHubSession(project.path, startOn);
			onStarted();
			setNotice({ tone: "ok", text: startedText(project, r) });
		} catch (error) {
			setNotice({ tone: "bad", text: `Could not start: ${errorText(error)}` });
		} finally {
			setStarting(null);
		}
	};

	const createAndStart = async () => {
		if (startOn === null || !parentOk || !validProjectName(folderName)) return;
		setStarting("new-folder");
		setNotice(null);
		try {
			const path = await createAndStartProject(
				() => createProject(startOn, parent, folderName, initializeGit),
				path => startHubSession(path, startOn),
			);
			onStarted();
			setNotice({ tone: "ok", text: `Started a session in ${path}.` });
		} catch (error) {
			setNotice({ tone: "bad", text: `Could not create and start: ${errorText(error)}` });
		} finally {
			setStarting(null);
		}
	};

	return (
		<Modal
			open={open}
			title={fleet && startOn !== null ? `Start a session on ${machineName}` : "Start a session"}
			onClose={onClose}
			cancelLabel="Close"
		>
			<div className="sd-stack sd-start">
				{fleet && header === null && (
					<div className="sd-field">
						<span>Machine</span>
						<div className="sd-row" role="group" aria-label="Start on machine">
							{fleet.map(m => (
								<button
									key={m.id}
									type="button"
									className="btn"
									data-size="sm"
									data-variant={m.id === startOn ? "primary" : undefined}
									aria-pressed={m.id === startOn}
									disabled={!m.ok}
									title={m.ok ? undefined : `${m.name} is unreachable`}
									onClick={() => {
										setPicked(m.id);
										setParent("");
									}}
								>
									{m.name}
								</button>
							))}
						</div>
					</div>
				)}
				{startOn === null && <p className="sd-hint">Pick a machine first; its projects show next.</p>}
				<p className="sd-hint">
					Opens a new herdr tab called omp in the project's workspace, with your default model.
				</p>
				<NoticeLine notice={notice} />
				{startOn !== null && (
					<>
						<SearchInput
							value={query}
							onChange={setQuery}
							placeholder="Search projects"
							label="Search projects"
						/>
						{projects.error ? (
							<div className="sd-row">
								<p className="sd-hint" data-tone="bad" role="alert">
									Could not list the projects: {projects.error.message}
								</p>
								<button type="button" className="btn" data-size="sm" onClick={projects.refetch}>
									Try again
								</button>
							</div>
						) : projects.data === null ? (
							<TableSkeleton rows={4} />
						) : matches.length === 0 ? (
							<EmptyState title="No matching project" />
						) : (
							<ul className="hub-projects">
								{matches.map(p => (
									<li key={p.path} className="hub-project">
										<div className="stack">
											<span className="hub-project-name truncate">{p.name}</span>
											<span className="micro truncate">
												{p.label}
												{p.last_used ? ` · used ${ago(p.last_used)}` : ""}
											</span>
										</div>
										<button
											type="button"
											className="btn"
											data-size="sm"
											disabled={starting !== null || !projectsReady}
											onClick={() => void start(p)}
										>
											<Play size={13} /> {starting === p.path ? "Starting…" : "Start"}
										</button>
									</li>
								))}
							</ul>
						)}
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							aria-expanded={newFolder}
							onClick={() => setNewFolder(value => !value)}
						>
							New folder
						</button>
						{newFolder && (
							<div className="sd-stack">
								<label className="sd-field">
									<span>Parent</span>
									<select className="input" value={parent} onChange={event => setParent(event.target.value)}>
										<option value="">Choose a parent</option>
										{parentChoices.map(path => (
											<option key={path} value={path}>
												{path}
											</option>
										))}
									</select>
								</label>
								{parents.error && (
									<p className="sd-hint" data-tone="bad" role="alert">
										{errorText(parents.error)}
									</p>
								)}
								<label className="sd-field">
									<span>Name</span>
									<input
										type="text"
										className="input"
										value={folderName}
										onChange={event => setFolderName(event.target.value)}
									/>
								</label>
								{folderName && !validProjectName(folderName) && (
									<p className="sd-hint" data-tone="bad" role="alert">
										Use 1–64 letters, digits, dots, underscores or hyphens; start with a letter or digit.
									</p>
								)}
								<label className="sd-check">
									<input
										type="checkbox"
										checked={initializeGit}
										onChange={event => setInitializeGit(event.target.checked)}
									/>{" "}
									Initialize git
								</label>
								<button
									type="button"
									className="btn"
									data-variant="primary"
									disabled={starting !== null || !parentOk || !validProjectName(folderName)}
									onClick={() => void createAndStart()}
								>
									{starting === "new-folder" ? "Starting…" : "Create and start"}
								</button>
							</div>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
