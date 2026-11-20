import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../api";
import {
	disconnectHubViewer,
	getHubRelay,
	rebuildHubRelay,
	type HubRelayHealth,
	type HubRelayViewer,
} from "../data/hub";
import { type Column, EmptyState, formatCompactDuration, Modal, PageHeader, Table } from "../ui";
import {
	machineOffline,
	browserName,
	MachineGroupLabel,
	MachineProblems,
	plainHubReason,
	plainRelayProblem,
	type OpsMachine,
	OpsMachineCell,
	UpdateHubHint,
	useCapabilities,
	useOpsMachines,
	usePerMachine,
	When,
} from "./ops-common";

export interface RelayRouteProps {
	active: boolean;
}

export const SOFT_KICK_COPY =
	"Disconnect is a soft kick; reloading rejoins. Only Disconnect and unpair revokes access.";

export function relayBuildLabel(build: unknown): string {
	if (typeof build === "string") return build ? build.split(" ")[0] : "–";
	if (!build || typeof build !== "object") return "–";
	try {
		const { ompTag, bun } = build as { ompTag?: unknown; bun?: unknown };
		return typeof ompTag === "string" && ompTag
			? typeof bun === "string" && bun
				? `${ompTag} · bun ${bun}`
				: ompTag
			: "–";
	} catch {
		return "–";
	}
}

/** What a refused disconnect means. A 409 never unpaired anything. */
export function relayActionError(error: unknown, machine: string, unpair: boolean): string {
	if (error instanceof ApiError && error.status === 409) {
		if (/pairing store|omp-private-relay revoke/.test(error.message))
			return `Not unpaired: the relay on ${machine} keeps its own pairings. Run omp-private-relay revoke on ${machine} to revoke this browser.`;
		if (error.message.startsWith("viewer disconnected"))
			return `Disconnected, but not unpaired: ${error.message.replace(/^viewer disconnected;\s*/, "")}.`;
		return `The viewer already left or changed${unpair ? ", so nothing was unpaired" : ""}. The list was refreshed.`;
	}
	return error instanceof Error ? error.message : String(error);
}

/** Why the viewer list of a machine is unavailable, or null when it is listed. */
function viewerProblem(relay: HubRelayHealth, canRebuild: boolean): string | null {
	if (!relay.needsUpdate) return relay.viewers == null ? "viewer list unavailable" : null;
	return /rebuild/.test(relay.error ?? "")
		? canRebuild
			? "its relay web client predates Disconnect"
			: "its relay web client predates Disconnect: rebuild it with omp-private-relay rebuild-web, then restart the relay"
		: "its relay needs an update to list and disconnect viewers";
}

interface RelayRow {
	machine: OpsMachine;
	relay: HubRelayHealth | null;
	error: string | null;
	stale: boolean;
}

interface ViewerRow extends HubRelayViewer {
	machine: OpsMachine;
	canUnpair: boolean;
	key: string;
	stale: boolean;
}

export function RelayRoute({ active }: RelayRouteProps) {
	const { machines, all } = useOpsMachines();
	const [fastPoll, setFastPoll] = useState(false);
	const relays = usePerMachine("relay", machines, (id, signal) => getHubRelay(id, signal), {
		active,
		pollMs: fastPoll ? 2_000 : 15_000,
	});
	const capabilities = useCapabilities(machines, active);
	const [pending, setPending] = useState<{ viewer: ViewerRow; unpair: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [done, setDone] = useState("");
	const [rebuildMachine, setRebuildMachine] = useState<OpsMachine | null>(null);
	const [rebuildBusy, setRebuildBusy] = useState(false);
	const [rebuildError, setRebuildError] = useState("");
	const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(() => new Set());
	const inFlight = (state: string | undefined) =>
		state === "preparing" || state === "building" || state === "restarting";
	const rebuilding = relays.answers.some(answer => inFlight(answer.data?.rebuild?.state));
	useEffect(() => setFastPoll(rebuilding), [rebuilding]);

	const requestRebuild = async () => {
		if (!rebuildMachine || rebuildBusy) return;
		setRebuildBusy(true);
		setRebuildError("");
		try {
			await rebuildHubRelay(rebuildMachine.id);
			setRebuildMachine(null);
			setFastPoll(true);
			relays.refetch();
		} catch (e) {
			const message =
				e instanceof ApiError && e.status === 409
					? "A rebuild is already in progress."
					: e instanceof ApiError && e.status === 429
						? "Please wait 30 seconds after the last rebuild before trying again."
						: e instanceof ApiError && e.status === 503
							? "This machine's relay isn't the omp-private-relay plugin."
							: e instanceof Error
								? e.message
								: String(e);
			setRebuildError(message);
			if (e instanceof ApiError && e.status === 409) relays.refetch();
		} finally {
			setRebuildBusy(false);
		}
	};

	const openRebuild = (machine: OpsMachine) => {
		setRebuildError("");
		setRebuildMachine(machine);
	};

	/**
	 * The hub's `relayViewers` mirrors the relay's own `viewers2`. An outdated relay therefore reports
	 * `relayViewers: false` together with `needsUpdate: true`: then the relay needs the update, not the hub.
	 * Only a hub that answers without `needsUpdate` at all predates the viewer list.
	 */
	const hubLacksViewers = (answer: { machine: OpsMachine; data: HubRelayHealth | null }) => {
		const caps = capabilities(answer.machine.id);
		return caps !== null && caps.relayViewers !== true && answer.data?.needsUpdate === undefined;
	};
	const rows: RelayRow[] = relays.answers.map(answer => ({
		machine: answer.machine,
		relay: answer.data,
		error: answer.error,
		stale: answer.stale,
	}));
	const viewers: ViewerRow[] = relays.answers.flatMap(answer =>
		answer.data && !answer.data.needsUpdate && !hubLacksViewers(answer)
			? (answer.data.viewers ?? []).map(viewer => ({
					...viewer,
					machine: answer.machine,
					canUnpair: answer.data?.canUnpair === true,
					key: `${answer.machine.id}:${viewer.room}:${viewer.peer}:${viewer.device8}`,
					stale: answer.stale,
				}))
			: [],
	);
	/** Per machine: why its viewers are not listed, or why unpairing is not offered. */
	const notes = relays.answers.flatMap(answer => {
		const out: { machine: OpsMachine; text: ReactNode; key: string }[] = [];
		if (answer.data) {
			const matching = /rebuild|web UI not built|not reachable/i.test(answer.data.error ?? "");
			const caps = capabilities(answer.machine.id);
			const canRebuild = matching && caps?.relayRebuild === true;
			const problem = answer.data.needsUpdate === undefined ? null : viewerProblem(answer.data, canRebuild);
			if (problem || matching)
				out.push({
					machine: answer.machine,
					key: "relay",
					text: (
						<>
							{answer.machine.name}: {problem ?? plainRelayProblem(answer.data.error)}.{" "}
							{canRebuild ? (
								<button
									type="button"
									className="btn"
									data-size="sm"
									disabled={machineOffline(answer.machine) !== null || inFlight(answer.data.rebuild?.state)}
									onClick={() => openRebuild(answer.machine)}
								>
									Rebuild web client and restart relay
								</button>
							) : (
								matching &&
								caps !== null && (
									<UpdateHubHint machine={answer.machine}>
										to rebuild the relay web client from here.
									</UpdateHubHint>
								)
							)}
						</>
					),
				});
			else if (hubLacksViewers(answer))
				out.push({
					machine: answer.machine,
					key: "hub",
					text: <UpdateHubHint machine={answer.machine}>to list and disconnect viewers.</UpdateHubHint>,
				});
			else if (answer.data.needsUpdate === false && !answer.data.canUnpair)
				out.push({
					machine: answer.machine,
					key: "unpair",
					text: (
						<>
							{answer.machine.name}: the relay keeps its own pairings, so Disconnect and unpair is off. Run{" "}
							<code>omp-private-relay revoke</code> there to revoke a browser.
						</>
					),
				});
		}
		return out;
	});

	const disconnect = async () => {
		if (!pending) return;
		setBusy(true);
		setError("");
		try {
			await disconnectHubViewer(pending.viewer.machine.id, pending.viewer, pending.unpair);
			setDone(
				pending.unpair
					? `Disconnected and unpaired ${pending.viewer.device8} on ${pending.viewer.machine.name}.`
					: `Disconnected ${pending.viewer.device8} on ${pending.viewer.machine.name}. Reloading its tab rejoins.`,
			);
			setPending(null);
			relays.refetch();
		} catch (e) {
			setError(relayActionError(e, pending.viewer.machine.name, pending.unpair));
			if (e instanceof ApiError && e.status === 409) relays.refetch();
		} finally {
			setBusy(false);
		}
	};

	const running = rows.filter(r => r.relay?.ok && !r.error).length;
	const rooms = rows.reduce((sum, r) => sum + (r.relay?.rooms ?? 0), 0);
	const relayColumns: Column<RelayRow>[] = [
		{
			key: "machine",
			header: "Machine",
			kind: "machine",
			width: 150,
			sort: r => machines.indexOf(r.machine),
			render: r => <OpsMachineCell machine={r.machine} />,
		},
		{
			key: "status",
			header: "Status",
			kind: "status",
			sort: r => Number(!!r.relay?.ok && !r.error),
			// A failed refresh wins over the last answer: never "Running" from a cached reading.
			render: r =>
				r.error ? (
					<span className="ops-pc-text">
						<span className="badge" data-tone="warn">
							Didn't answer
						</span>
						<span className="ops-pc-sub" title={r.error}>
							{plainHubReason(r.error, { reachable: r.machine.reachable, refreshing: relays.polling })}
						</span>
					</span>
				) : r.relay?.ok ? (
					<span className="badge" data-tone="ok">
						Running
					</span>
				) : (
					<span className="ops-pc-text">
						<span className="badge" data-tone="bad">
							Problem
						</span>
						<span className="ops-pc-sub" title={r.relay?.error ?? undefined}>
							{plainRelayProblem(r.relay?.error)}
						</span>
					</span>
				),
		},
		{
			key: "rooms",
			header: "Rooms",
			kind: "number",
			width: 80,
			sort: r => r.relay?.rooms,
			render: r => (
				<span title="Sessions sharing now">
					{r.relay?.rooms ?? "–"}
					<span className="ops-phone-label"> rooms</span>
				</span>
			),
		},
		{
			key: "viewers",
			header: "Viewers",
			kind: "number",
			width: 80,
			sort: r => r.relay?.guests,
			render: r => (
				<span title="Open browser tabs">
					{r.relay?.guests ?? "–"}
					<span className="ops-phone-label"> viewers</span>
				</span>
			),
		},
		{
			key: "up",
			header: "Up",
			kind: "duration",
			width: 90,
			sort: r => r.relay?.uptime_s,
			render: r => (
				<span title="Uptime">
					<span className="ops-phone-label">up </span>
					{r.relay?.uptime_s == null ? "–" : formatCompactDuration(r.relay.uptime_s * 1000)}
				</span>
			),
		},
		{
			key: "build",
			header: "Web build",
			width: 200,
			priority: 3,
			render: r => (
				<span className="ops-mono ops-dim" title={typeof r.relay?.build === "string" ? r.relay.build : undefined}>
					{relayBuildLabel(r.relay?.build)}
				</span>
			),
		},
	];

	const viewerColumns: Column<ViewerRow>[] = [
		{
			key: "browser",
			header: "Browser",
			sort: v => browserName(v.ua),
			render: v => (
				<span className="ops-pc-text" title={v.ua}>
					<span className="ops-pc-title">{browserName(v.ua)}</span>
					<span className="ops-pc-sub ops-mono">{v.device8}</span>
				</span>
			),
		},
		{
			key: "session",
			header: "Session",
			width: 200,
			priority: 2,
			sort: v => v.room,
			render: v => (
				<span className="ops-mono ops-dim" title={`Room ${v.room} · peer ${v.peer}`}>
					{v.room.length > 18 ? `${v.room.slice(0, 18)}…` : v.room}
				</span>
			),
		},
		{
			key: "since",
			header: "Connected",
			kind: "date",
			width: 110,
			sort: v => v.connectedAt,
			render: v => <When at={v.connectedAt} />,
		},
		{
			key: "machine",
			header: "Machine",
			kind: "machine",
			width: 110,
			priority: 3,
			sort: v => v.machine.short,
			render: v => <OpsMachineCell machine={v.machine} />,
		},
		{
			key: "actions",
			header: "",
			kind: "actions",
			width: 280,
			render: v => (
				<span className="ops-actions">
					<button
						type="button"
						className="btn"
						data-size="sm"
						disabled={machineOffline(v.machine) !== null}
						title={machineOffline(v.machine) ?? undefined}
						aria-label={`Disconnect ${v.device8} on ${v.machine.name}`}
						onClick={() => {
							setError("");
							setDone("");
							setPending({ viewer: v, unpair: false });
						}}
					>
						Disconnect
					</button>
					{v.canUnpair && (
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="danger"
							disabled={machineOffline(v.machine) !== null}
							title={machineOffline(v.machine) ?? undefined}
							aria-label={`Disconnect and unpair ${v.device8} on ${v.machine.name}`}
							onClick={() => {
								setError("");
								setDone("");
								setPending({ viewer: v, unpair: true });
							}}
						>
							Disconnect and unpair
						</button>
					)}
				</span>
			),
		},
	];

	const single = machines.length === 1 ? machines[0] : null;
	const openTabs = viewers.length;
	return (
		<div className="page ops-page">
			<PageHeader
				title="Relay"
				description={`The small server on ${all || !single ? "each machine" : single.name} that connects your browser to omp sessions. Refreshes every ${fastPoll ? 2 : 15} seconds.`}
			/>
			<MachineProblems
				answers={relays.answers}
				what="the relay status"
				onRetry={relays.refetch}
				polling={relays.polling}
			/>
			<Table
				variant="std"
				dense
				title="Relays"
				subtitle={`${running} of ${rows.length} running · ${rooms} ${rooms === 1 ? "session" : "sessions"} sharing`}
				columns={relayColumns}
				rows={rows}
				rowKey={r => r.machine.id || "local"}
				loading={relays.loading}
				stale={r => r.stale || !r.machine.reachable}
				expanded={r => {
					const rebuild = r.relay?.rebuild;
					if (!rebuild || rebuild.state === "idle") return null;
					const status =
						rebuild.state === "preparing"
							? "Preparing…"
							: rebuild.state === "building"
								? "Rebuilding…"
								: rebuild.state === "restarting"
									? "Restarting…"
									: rebuild.state === "done"
										? "Done at"
										: rebuild.state === "restart-needed"
											? "Web client installed; relay restart needed"
											: `Failed: ${rebuild.message || rebuild.tail.at(-1) || "Unknown error"}`;
					return (
						<div className="ops-confirm">
							<span role="status">
								{status}{" "}
								{rebuild.state === "done" && (
									<When at={rebuild.finishedAt == null ? null : rebuild.finishedAt * 1000} />
								)}
							</span>{" "}
							{rebuild.state === "restart-needed" && capabilities(r.machine.id)?.relayRebuild === true && (
								<button
									type="button"
									className="btn"
									data-size="sm"
									disabled={machineOffline(r.machine) !== null}
									onClick={() => openRebuild(r.machine)}
								>
									Retry
								</button>
							)}{" "}
							<button
								type="button"
								className="btn"
								data-size="sm"
								aria-expanded={openLogs.has(r.machine.id)}
								onClick={() =>
									setOpenLogs(previous => {
										const next = new Set(previous);
										if (next.has(r.machine.id)) next.delete(r.machine.id);
										else next.add(r.machine.id);
										return next;
									})
								}
							>
								{openLogs.has(r.machine.id) ? "Hide log" : "Show log"}
							</button>
							{openLogs.has(r.machine.id) && <pre>{rebuild.tail.join("\n")}</pre>}
						</div>
					);
				}}
				empty={<EmptyState title="No relay" />}
			/>
			{notes.length > 0 && (
				<ul className="ops-notes">
					{notes.map(note => (
						<li key={`${note.machine.id}:${note.key}`}>{note.text}</li>
					))}
				</ul>
			)}
			{done && (
				<p className="hub-notice" role="status">
					{done}
				</p>
			)}
			<Table
				variant="std"
				dense
				title="Connected viewers"
				subtitle={`${openTabs} open ${openTabs === 1 ? "tab" : "tabs"} · ${SOFT_KICK_COPY}`}
				columns={viewerColumns}
				rows={viewers}
				rowKey={v => v.key}
				loading={relays.loading}
				initialSort={{ key: "since", dir: "desc" }}
				stale={v => v.stale}
				group={
					all
						? v => ({
								key: v.machine.id,
								label: (
									<MachineGroupLabel
										machine={v.machine}
										count={`${viewers.filter(r => r.machine.id === v.machine.id).length} open`}
									/>
								),
							})
						: undefined
				}
				empty={
					<EmptyState
						title="No one is watching"
						hint="Browser tabs that open a session (Open & control or Watch) show here, with a Disconnect button."
					/>
				}
			/>
			<Modal
				open={!!pending}
				title={
					pending
						? `${pending.unpair ? "Disconnect and unpair" : "Disconnect"} ${browserName(pending.viewer.ua)} on ${pending.viewer.machine.name}?`
						: ""
				}
				onClose={() => {
					if (!busy) setPending(null);
				}}
				primaryAction={{
					label: busy ? "Disconnecting…" : pending?.unpair ? "Disconnect and unpair" : "Disconnect",
					onClick: disconnect,
					disabled: busy,
				}}
			>
				{pending && (
					<div className="ops-confirm">
						<p>
							{pending.unpair
								? `The tab closes and browser ${pending.viewer.device8} loses its pairing with ${pending.viewer.machine.name}: it must pair again to open any session there.`
								: "The tab stops following the session, but reloading it rejoins."}
						</p>
						<p className="ops-hint">{SOFT_KICK_COPY}</p>
						{error && (
							<p className="hub-notice" data-tone="bad" role="alert">
								{error}
							</p>
						)}
					</div>
				)}
			</Modal>
			<Modal
				open={!!rebuildMachine}
				title="Rebuild web client and restart relay?"
				onClose={() => {
					if (!rebuildBusy) setRebuildMachine(null);
				}}
				primaryAction={{
					label: rebuildBusy ? "Starting…" : "Rebuild web client and restart relay",
					onClick: requestRebuild,
					disabled: rebuildBusy,
				}}
			>
				{rebuildMachine && (
					<div className="ops-confirm">
						<p>
							Rebuilds the relay&apos;s web client on {rebuildMachine.name} (needs internet, usually under a
							minute; longer the first time after an omp upgrade), then restarts the relay. Open viewers on that
							machine drop for a few seconds and reconnect.
						</p>
						{rebuildError && (
							<p className="hub-notice" data-tone="bad" role="alert">
								{rebuildError}
							</p>
						)}
					</div>
				)}
			</Modal>
		</div>
	);
}
