import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { formatInteger } from "../data/formatters";
import { CLOSED, PROBE_CANCELLED, retryDelay, streamRefusal, TOO_MANY_STREAMS, useLiveStatus } from "../data/live";
import { Dot } from "../ui";
import { namedStatsReason } from "./stats-reasons";
import { usePagePollMs } from "../data/page-polling";
import { ALL_MACHINES, type FleetMachine, machinePath, useFleet, useSelectedMachine } from "./machine";

/** Topbar ingest status; click to sync now. Under All machines it aggregates one stream per machine. */
export function LiveChip() {
	const fleet = useFleet();
	const selected = useSelectedMachine();
	if (fleet && selected === ALL_MACHINES)
		return fleetStreamsAllowed() ? <FleetLiveChip fleet={fleet} /> : <AutoRefreshChip />;
	return <MachineLiveChip />;
}

/**
 * One machine's stream, the same rule as All machines: live while the stream is open, however quiet;
 * "Stale · Nm ago" (since the last open or message) only once it is not open.
 */
export function machineStreamState(
	connected: boolean,
	receivedAt: number | null,
	now: number,
	failures = 0,
): { kind: "live" } | { kind: "stale"; ago: string } | { kind: "reconnecting" } | { kind: "not-live" } {
	if (connected) return { kind: "live" };
	// Refused again and again (e.g. a stats server of another version): say so plainly instead of "Reconnecting".
	if (failures >= NOT_LIVE_AFTER_FAILURES) return { kind: "not-live" };
	if (receivedAt !== null) return { kind: "stale", ago: ago(now - receivedAt) };
	return { kind: "reconnecting" };
}

/** Refusals in a row after which the pill stops saying "Reconnecting" and says "Not live" with the reason. */
export const NOT_LIVE_AFTER_FAILURES = 2;

/**
 * The pill's explanation once it says "Not live": the plain reason, and what happens to this page's numbers, which
 * depends on whether its queries refresh by themselves (`pollMs`, the shortest interval on the page, or null).
 */
export function notLiveTitle(
	reason: string | null,
	problem: string | null,
	pollMs: number | null,
	machine: string | null = null,
): string {
	// A standalone sentence: name the machine ("Ada Server's stats server …"), never a bare "its".
	const why = reason ?? namedStatsReason(machine, problem, { refreshing: false });
	const page =
		pollMs !== null
			? `This page refreshes every ${formatInterval(pollMs)}`
			: "Numbers on this page won't update by themselves; use Try again or reload";
	return `Live updates unavailable: ${why}. ${page}. The live connection is retried in the background.`;
}

/** The name of the machine whose stream the single-machine pill follows, or null without a fleet. */
function useLiveMachineName(): string | null {
	const fleet = useFleet();
	const selected = useSelectedMachine();
	return fleet?.find(machine => machine.id === selected)?.name ?? null;
}

function formatInterval(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function MachineLiveChip() {
	const { sync, indexingHours, connected, receivedAt, reason, failures, problem, requestSync } = useLiveStatus();
	const now = useNow(sync.phase === "idle" ? 15_000 : null);

	let body: ReactNode;
	let title: string;
	const pollMs = usePagePollMs();
	const machineName = useLiveMachineName();
	const [showWhy, setShowWhy] = useState(false);
	const state = machineStreamState(connected, receivedAt, now, failures);
	const notLive = state.kind === "not-live";
	if (notLive) {
		body = (
			<>
				<Dot tone="neutral" />
				<span>Not live</span>
			</>
		);
		title = notLiveTitle(reason, problem, pollMs, machineName);
	} else if (state.kind === "stale") {
		body = (
			<>
				<Dot tone="warn" />
				<span>Stale</span>
				<span className="live-chip-count">{state.ago}</span>
			</>
		);
		title = reason
			? `Not live: ${reason}. Last event ${state.ago}`
			: `Lost the live connection to the stats server; retrying. Last event ${state.ago}`;
	} else if (state.kind === "reconnecting") {
		body = (
			<>
				<Dot tone="warn" />
				<span>Reconnecting</span>
			</>
		);
		title = reason ? `Not live: ${reason}` : "Lost the live connection to the stats server; retrying";
	} else if (sync.phase === "syncing") {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>Syncing</span>
				{sync.total > 0 && (
					<span className="live-chip-count">
						{formatInteger(sync.current)}/{formatInteger(sync.total)}
					</span>
				)}
			</>
		);
		title = "Ingesting session files";
	} else if (sync.phase === "error") {
		body = (
			<>
				<Dot tone="bad" />
				<span>Sync failed</span>
			</>
		);
		title = `${sync.error ?? "Sync failed"} — click to retry`;
	} else if (indexingHours > INDEXING_VISIBLE_HOURS) {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>Indexing</span>
				<span className="live-chip-count">{formatInteger(indexingHours)}h left</span>
			</>
		);
		title = "Building hourly rollups; older ranges fill in as it goes";
	} else {
		body = (
			<>
				<Dot tone="live" pulse />
				<span>Live</span>
			</>
		);
		title = "Click to sync session files now";
	}

	// Not live: a tap explains why (phones have no hover); syncing can't work without the stream anyway.
	return (
		<span className="live-chip-wrap" data-state={notLive ? "not-live" : undefined}>
			<button
				type="button"
				className="live-chip"
				data-state={notLive ? "not-live" : undefined}
				aria-expanded={notLive ? showWhy : undefined}
				onClick={notLive ? () => setShowWhy(open => !open) : requestSync}
				// "Not live" stays tappable even if the last status before the refusals was "syncing".
				disabled={!notLive && sync.phase === "syncing"}
				title={title}
			>
				{body}
			</button>
			{notLive && showWhy && (
				<span className="live-chip-why" role="status">
					{title}
				</span>
			)}
		</span>
	);
}

export interface FleetStream {
	/** The stream is open (EventSource readyState OPEN). */
	connected: boolean;
	/** When this page last saw an open or a message on the stream, ms. */
	receivedAt: number | null;
	/** Why the hub refused the stream, for the tooltip (e.g. too many dashboard tabs). */
	reason?: string | null;
}

export interface FleetLiveView {
	label: string;
	count: string | null;
	tone: "live" | "warn" | "neutral";
	title: string;
}

/**
 * What the All-machines chip says. A stream is live while its EventSource is open, however quiet the machine is;
 * not while it is connecting or after an error. Unreachable machines are left out of the goal: the machine
 * selector reports them.
 */
export function fleetLiveView(fleet: FleetMachine[], streams: Record<string, FleetStream>, now: number): FleetLiveView {
	const reachable = fleet.filter(machine => machine.ok);
	const total = reachable.length;
	if (!total)
		return { label: "No machines reachable", count: null, tone: "neutral", title: "No machine answers right now" };
	const live = reachable.filter(machine => streams[machine.id]?.connected);
	const downMachines = reachable.filter(machine => !streams[machine.id]?.connected);
	const describe = (machine: FleetMachine) => {
		const reason = streams[machine.id]?.reason;
		return reason ? `${machine.name} (${reason})` : machine.name;
	};
	const down = downMachines.map(describe);
	const refused = downMachines.filter(machine => streams[machine.id]?.reason).map(describe);
	if (live.length)
		return {
			label: "Live",
			count: `${live.length}/${total}`,
			tone: live.length === total ? "live" : "warn",
			title: `${down.length ? `Not streaming: ${down.join(", ")}` : "Every reachable machine is streaming"}. Click to sync every machine now.`,
		};
	const heard = reachable.map(machine => streams[machine.id]?.receivedAt ?? 0).filter(at => at > 0);
	if (heard.length) {
		const last = ago(now - Math.max(...heard));
		return {
			label: "Stale",
			count: last,
			tone: "warn",
			title: `No live stream is open; last event ${last}. Not streaming: ${down.join(", ")}`,
		};
	}
	return {
		label: "Connecting",
		count: `0/${total}`,
		tone: "neutral",
		title: refused.length
			? `Opening the live streams. Not streaming: ${refused.join(", ")}`
			: "Opening the live streams",
	};
}

/**
 * Per-machine streams only over https (Tailscale Serve, HTTP/2). Over plain HTTP/1.1 the browser allows 6
 * connections per host across every tab, so one stream per machine per tab starves everything after two tabs.
 */
export function fleetStreamsAllowed(): boolean {
	return typeof location !== "undefined" && location.protocol === "https:";
}

export const AUTO_REFRESH_TITLE = "live updates need the tailnet https address; this page refreshes every few seconds";

function AutoRefreshChip() {
	return (
		<span className="live-chip" title={AUTO_REFRESH_TITLE}>
			<Dot tone="neutral" />
			<span>Auto-refresh</span>
		</span>
	);
}

function FleetLiveChip({ fleet }: { fleet: FleetMachine[] }) {
	const streams = useFleetStreams(fleet);
	const now = useNow(15_000);
	const view = fleetLiveView(fleet, streams, now);
	return (
		<button
			type="button"
			className="live-chip"
			title={view.title}
			onClick={() => {
				for (const machine of fleet)
					if (streams[machine.id]?.connected) api.requestSync(machine.id).catch(() => {});
			}}
		>
			<Dot tone={view.tone} pulse={view.tone === "live"} />
			<span>{view.label}</span>
			{view.count && <span className="live-chip-count">{view.count}</span>}
		</button>
	);
}

/**
 * One `/m/<id>/api/events` stream per reachable machine, reconciled by id: a machine joining or leaving opens or
 * closes only its own stream, so one flapping machine never reconnects the healthy ones.
 */
export function useFleetStreams(fleet: FleetMachine[]): Record<string, FleetStream> {
	const [streams, setStreams] = useState<Record<string, FleetStream>>({});
	const entries = useRef(new Map<string, StreamEntry>());
	const ids = fleet
		.filter(machine => machine.ok)
		.map(machine => machine.id)
		.join(",");
	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		const wanted = new Set(ids ? ids.split(",") : []);
		const update = (id: string, patch: Partial<FleetStream>) =>
			setStreams(prev => {
				if (!entries.current.has(id)) return prev;
				const current = prev[id] ?? { connected: false, receivedAt: null, reason: null };
				const next = { ...current, ...patch };
				return next.connected === current.connected &&
					next.receivedAt === current.receivedAt &&
					next.reason === current.reason
					? prev
					: { ...prev, [id]: next };
			});
		const open = (id: string) => {
			const entry = entries.current.get(id);
			if (!entry) return;
			entry.timer = null;
			const url = machinePath("/api/events", id);
			const source = new EventSource(url);
			entry.source = source;
			source.onopen = () => {
				entry.failures = 0;
				update(id, { connected: true, receivedAt: Date.now(), reason: null });
			};
			source.onmessage = () => update(id, { connected: true, receivedAt: Date.now(), reason: null });
			source.onerror = () => {
				update(id, { connected: false });
				// A dropped connection reconnects by itself; a refused one (HTTP error) is closed for good, so
				// find out why and reopen after a back-off instead of hammering the hub.
				if (source.readyState !== CLOSED) return;
				source.close();
				if (entry.source === source) entry.source = null;
				void streamRefusal(url, entry.owner.signal).then(refusal => {
					if (refusal === PROBE_CANCELLED || entries.current.get(id) !== entry || entry.source || entry.timer)
						return;
					entry.failures++;
					update(id, { connected: false, reason: refusal.code === "too_many_streams" ? TOO_MANY_STREAMS : null });
					entry.timer = setTimeout(() => open(id), retryDelay(refusal.code, entry.failures));
				});
			};
		};
		for (const [id, entry] of entries.current)
			if (!wanted.has(id)) {
				entry.owner.abort();
				entry.source?.close();
				if (entry.timer) clearTimeout(entry.timer);
				entries.current.delete(id);
				setStreams(prev => {
					if (!(id in prev)) return prev;
					const { [id]: _gone, ...rest } = prev;
					return rest;
				});
			}
		for (const id of wanted) {
			if (entries.current.has(id)) continue;
			entries.current.set(id, { source: null, timer: null, failures: 0, owner: new AbortController() });
			open(id);
		}
	}, [ids]);
	useEffect(() => {
		const all = entries.current;
		return () => {
			for (const entry of all.values()) {
				entry.owner.abort();
				entry.source?.close();
				if (entry.timer) clearTimeout(entry.timer);
			}
			all.clear();
		};
	}, []);
	return streams;
}

interface StreamEntry {
	source: EventSource | null;
	timer: ReturnType<typeof setTimeout> | null;
	failures: number;
	/** Aborted when the machine leaves or the chip unmounts: cancels a refusal probe in flight. */
	owner: AbortController;
}

/** A handful of dirty hours is normal live churn; only a real backlog is worth showing. */
const INDEXING_VISIBLE_HOURS = 24;

function useNow(intervalMs: number | null): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (intervalMs === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

export function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
