import { ALL_MACHINES, machineView, selectMachine, useSelectedMachine, type FleetMachine } from "../app/machine";
import { classifyStatsFailure } from "../app/stats-reasons";
import { ApiError } from "../api";
import { getHubMachines, getHubSessions } from "../data/hub";
import { useQuery } from "../data/query";
import {
	EmptyState,
	lastKnownTitle,
	MachineCell,
	PageHeader,
	RelativeDateCell,
	StatusCell,
	Table,
	type Column,
} from "../ui";
import "./machines.css";

export interface MachinesRouteProps {
	active: boolean;
}

/**
 * What to add after "Couldn't check the machines." for a failed machine list, chosen by the shared classifier;
 * only a timeout or a hub that isn't answering may say it "didn't answer". Empty when the cause is unknown.
 */
function machineListFailure(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	if ((error instanceof ApiError && (error.status === 401 || error.status === 403)) || /forbidden/i.test(raw))
		return "This browser isn't allowed to read the machine list; pair it again.";
	switch (classifyStatsFailure(raw).kind) {
		case "version":
			return "The hub's identity check failed; it may be a different version until it's updated.";
		case "unexpected":
			return "The hub sent an unexpected answer.";
		case "clock":
			return "The hub's clock is out of sync or it just restarted.";
		case "timeout":
			return "This hub didn't answer in time; it may be restarting.";
		case "down":
			return "This hub didn't answer; it may be restarting.";
		case "busy":
			return "This hub is busy; try again shortly.";
		case "setup":
			return "This hub isn't set up to list machines yet.";
		case "loading":
			return "The machine list is still loading.";
		case "unknown":
			return "";
	}
}

export function MachinesRoute({ active }: MachinesRouteProps) {
	const selected = useSelectedMachine();
	const machines = useQuery(["hub-machines"], ({ signal }) => getHubMachines(signal), {
		enabled: active,
		pollMs: 15_000,
		scope: "local",
	});
	const sessions = useQuery(["hub-sessions"], ({ signal }) => getHubSessions(signal), {
		enabled: active,
		pollMs: 15_000,
		scope: "local",
	});
	const list = machines.data ?? [];
	const order = (m: FleetMachine) => list.indexOf(m);
	/** Running sessions per machine; null when the count is unknown (the session list failed or the machine did not answer). */
	const running = (m: FleetMachine): number | null =>
		sessions.data && !sessions.error && (sessions.data.machines?.find(item => item.id === m.id)?.ok ?? m.ok)
			? sessions.data.sessions.filter(s => (s.machine ?? (m.self ? m.id : "")) === m.id && !s.stale).length
			: null;
	const countUnknown = (m: FleetMachine) =>
		sessions.error ? `Couldn't refresh the session list: ${String(sessions.error)}` : `${m.name} did not answer`;
	const columns: Column<FleetMachine>[] = [
		{
			key: "name",
			header: "Machine",
			sort: order,
			render: m => (
				<span className="mc-name">
					<span className="mc-text">
						<span className="mc-main">
							{/* A held machine (ok + stale) is "last known as of staleSince", not unreachable. */}
							<MachineCell
								name={m.name}
								color={machineView(m.name)?.accent ?? "var(--ink-3)"}
								reachable={m.ok}
								lastKnown={m.ok && !!m.stale}
								since={m.ok ? m.staleSince : m.lastOkAt}
							/>
						</span>
						<span className="mc-sub">
							{m.id}
							{m.self ? " · this hub" : ""}
						</span>
						<span className="mc-meta">
							{m.self ? "this hub" : m.latencyMs == null ? "no answer" : `${m.latencyMs} ms`}
							{m.version ? (
								<>
									{" · "}
									<span className="mono">{m.version}</span>
								</>
							) : null}
							{" · "}
							{running(m) ?? (sessions.data || sessions.error ? "?" : "…")} running
						</span>
					</span>
				</span>
			),
		},
		{
			key: "status",
			header: "Status",
			kind: "status",
			width: 120,
			sort: m => Number(m.ok) * 2 - Number(m.ok && !!m.stale),
			render: m =>
				m.ok && m.stale ? (
					<StatusCell tone="warn">
						<span title={lastKnownTitle(m.staleSince)}>Last known</span>
					</StatusCell>
				) : (
					<StatusCell tone={m.ok ? "ok" : "warn"}>{m.ok ? "Reachable" : "Unreachable"}</StatusCell>
				),
		},
		{
			key: "latency",
			header: "Latency",
			kind: "duration",
			width: 96,
			sort: m => m.latencyMs,
			render: m =>
				m.self ? <span className="mc-dim">this hub</span> : m.latencyMs == null ? "–" : `${m.latencyMs} ms`,
		},
		{
			key: "version",
			header: "Hub version",
			width: 150,
			priority: 2,
			sort: m => m.version,
			render: m => <span className="mono">{m.version ?? "–"}</span>,
		},
		{
			key: "seen",
			header: "Last seen",
			kind: "date",
			width: 110,
			sort: m => m.lastOkAt,
			render: m =>
				m.lastOkAt == null ? (
					"–"
				) : m.ok && !m.stale ? (
					<span title={new Date(m.lastOkAt).toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) + " PKT"}>
						just now
					</span>
				) : (
					<span className="mc-warn">
						<RelativeDateCell value={m.ok && m.stale ? (m.staleSince ?? m.lastOkAt) : m.lastOkAt} />
					</span>
				),
		},
		{
			key: "sessions",
			header: "Sessions running",
			kind: "number",
			width: 130,
			sort: m => running(m),
			render: m => {
				const count = running(m);
				return count == null && !sessions.data && !sessions.error ? (
					<span className="mc-dim" title="Loading the session list">
						…
					</span>
				) : count == null ? (
					<span className="mc-warn" title={countUnknown(m)}>
						<span aria-hidden="true">⚠ </span>unknown
					</span>
				) : (
					count
				);
			},
		},
		{
			key: "actions",
			header: "",
			kind: "actions",
			width: 170,
			// Node dashboards only show the "Managed machine" stub now, so a machine is opened here: picking it
			// scopes every page to it through the header machine selector.
			render: m =>
				m.id === selected ? (
					<span className="mc-current">Selected</span>
				) : (
					<button
						type="button"
						className="btn mc-select"
						data-size="sm"
						aria-label={`View ${m.name}`}
						title={`Select ${m.name} in the header machine menu`}
						onClick={() => selectMachine(m.id)}
					>
						View
					</button>
				),
		},
	];
	const reachable = list.filter(m => m.ok).length;
	const held = list.filter(m => m.ok && m.stale).length;
	const highlighted = selected === ALL_MACHINES ? undefined : list.find(m => m.id === selected);
	return (
		<div className="page mc-page">
			<PageHeader title="Machines" description="The machines this dashboard controls. Refreshes every 15 seconds." />
			{highlighted && (
				<p className="mc-scope-note">
					<span>
						<b>{highlighted.name}</b> is highlighted. This page always lists every machine.
					</span>
				</p>
			)}
			{sessions.error && machines.data && (
				<p className="mc-stale-note" role="status">
					<span className="dot" data-tone="warn" aria-hidden="true" />
					<span>
						Couldn't refresh the session list, so session counts are unknown.
						{/* Only claim a retry when the list really polls. */}
						{sessions.polling ? " Retrying every 15 seconds." : ""}
					</span>
				</p>
			)}
			<Table
				variant="std"
				dense
				title="Machines"
				subtitle={`${machines.data ? `${reachable} of ${list.length} reachable${held ? ` (${held} last known)` : ""}` : machines.error ? "Status unknown" : "Checking each machine…"} · This dashboard's pairing covers every machine; View picks one in the header`}
				columns={columns}
				rows={list}
				rowKey={m => m.id}
				initialSort={{ key: "name", dir: "asc" }}
				selectedKey={highlighted?.id ?? null}
				loading={machines.loading && !machines.data}
				error={
					machines.error && !machines.data ? (
						// Plain words on the page; the hub's raw reason stays in the tooltip.
						<span title={machines.error instanceof Error ? machines.error.message : String(machines.error)}>
							<b>Couldn't check the machines.</b>
							{machineListFailure(machines.error) ? ` ${machineListFailure(machines.error)}` : ""}
						</span>
					) : undefined
				}
				onRetry={() => machines.refetch()}
				empty={
					<EmptyState
						title="No machines configured"
						hint="This hub runs alone. Add machines in ~/.config/omp-hub/machines.json."
					/>
				}
			/>
		</div>
	);
}
