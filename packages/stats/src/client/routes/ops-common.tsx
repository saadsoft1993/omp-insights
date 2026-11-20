import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "../api";
import { ALL_MACHINES, machineHue, shortMachineName, useFleet, useSelectedMachine } from "../app/machine";
import { classifyStatsFailure } from "../app/stats-reasons";
import { getHubVersion, type HubCapabilities } from "../data/hub";
import { useQuery } from "../data/query";
import { lastKnownTitle, MachineCell, unreachableTitle } from "../ui";
import "./ops.css";

/**
 * Shared pieces of the operations pages (Jobs, Devices, Alerts, Relay): which machines a page covers, one
 * query that asks every one of them, and the machine cells, group headings and hints those pages share.
 */

/** A machine an operations page reads from. `id` is "" without a fleet (the local hub). */
export interface OpsMachine {
	id: string;
	name: string;
	/** Name without the owner's prefix ("Ada MacBook" → "MacBook"), for cells and group headings. */
	short: string;
	color: string;
	self: boolean;
	/** The fleet list's reachability; a failed request is reported separately. */
	reachable: boolean;
	/** When the fleet list last heard from it (ms), for the "unreachable since" tooltip. */
	lastOkAt: number | null;
	/** Reachable, but the hub is serving its last good answer while it reconnects (grace period). */
	lastKnown: boolean;
	/** When the hub started holding its last good answer (ms), for the "last known as of" tooltip. */
	staleSince: number | null;
	dashboardUrl: string | null;
}

/** "1 job" / "3 jobs". */
export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function machineColor(name: string): string {
	return `hsl(${machineHue(name)} 60% 50%)`;
}

/** The machines the header selection covers, and whether that is "All machines" (grouped tables). */
export function useOpsMachines(): {
	machines: OpsMachine[];
	/** Every configured machine, whatever the selection (fleet-wide actions such as fleet-link cleanup). */
	everyMachine: OpsMachine[];
	all: boolean;
	fleet: boolean;
} {
	const fleet = useFleet();
	const selected = useSelectedMachine();
	if (!fleet) {
		const local: OpsMachine = {
			id: "",
			name: "this machine",
			short: "This machine",
			color: machineColor("This machine"),
			self: true,
			reachable: true,
			lastOkAt: null,
			lastKnown: false,
			staleSince: null,
			dashboardUrl: null,
		};
		return { machines: [local], everyMachine: [local], all: false, fleet: false };
	}
	const all = selected === ALL_MACHINES;
	const everyMachine = fleet.map(m => ({
		id: m.id,
		name: m.name,
		short: shortMachineName(m.name),
		color: machineColor(m.name),
		self: m.self,
		reachable: m.ok,
		lastOkAt: m.lastOkAt,
		lastKnown: m.ok && m.stale === true,
		staleSince: m.staleSince ?? null,
		dashboardUrl: m.dashboardUrl,
	}));
	return {
		machines: everyMachine.filter(m => all || m.id === selected),
		everyMachine,
		all: all && fleet.length > 1,
		fleet: true,
	};
}

/** One machine's answer. A failed request keeps the last good data, marked stale. */
export interface MachineAnswer<T> {
	machine: OpsMachine;
	data: T | null;
	error: string | null;
	status: number | null;
	stale: boolean;
}

interface StoredAnswer<T> {
	id: string;
	data: T | null;
	error: string | null;
	status: number | null;
	stale: boolean;
}

/**
 * Ask every machine in parallel through one query. A machine that fails does not fail the page: its answer
 * carries the error, and the rows it gave before stay on screen, greyed.
 */
export function usePerMachine<T>(
	name: string,
	machines: readonly OpsMachine[],
	fetch: (machine: string, signal: AbortSignal) => Promise<T>,
	options: { active: boolean; pollMs?: number },
): {
	answers: MachineAnswer<T>[];
	loading: boolean;
	refreshing: boolean;
	/** The page asks every machine again on its own (a poll is set and the page is open). */
	polling: boolean;
	refetch: () => void;
} {
	const ids = machines.map(m => m.id);
	const query = useQuery<StoredAnswer<T>[]>(
		["ops", name, ids],
		async ({ signal }, previous) => {
			const results = await Promise.allSettled(ids.map(id => fetch(id, signal)));
			return results.map((result, index): StoredAnswer<T> => {
				const id = ids[index];
				if (result.status === "fulfilled")
					return { id, data: result.value, error: null, status: null, stale: false };
				const before = previous?.find(answer => answer.id === id)?.data ?? null;
				const reason: unknown = result.reason;
				return {
					id,
					data: before,
					error: reason instanceof Error ? reason.message : String(reason),
					status: reason instanceof ApiError ? reason.status : null,
					stale: before !== null,
				};
			});
		},
		{ enabled: options.active, pollMs: options.pollMs, scope: "local", retain: false },
	);
	const answers = machines.map(machine => {
		const stored = query.data?.find(answer => answer.id === machine.id);
		return {
			machine,
			data: stored?.data ?? null,
			error: stored?.error ?? (query.error ? query.error.message : null),
			status: stored?.status ?? null,
			stale: stored?.stale ?? false,
		};
	});
	return {
		answers,
		loading: query.loading,
		refreshing: query.refreshing,
		polling: options.active && !!options.pollMs,
		refetch: query.refetch,
	};
}

/**
 * Why a control is off for this machine: only an unreachable machine turns controls off. A held machine (the hub
 * serving its last good answer while it reconnects) still accepts actions.
 */
export function machineOffline(machine: OpsMachine): string | null {
	return machine.reachable ? null : `${machine.name} is unreachable`;
}

/** Each machine's hub capabilities: `null` while unknown or unreachable (never shown as "update the hub"). */
export function useCapabilities(
	machines: readonly OpsMachine[],
	active: boolean,
): (machine: string) => HubCapabilities | null {
	const versions = usePerMachine("version", machines, (id, signal) => getHubVersion(signal, id || undefined), {
		active,
	});
	return machine => {
		const answer = versions.answers.find(a => a.machine.id === machine);
		if (!answer?.data || answer.error) return null;
		return answer.data.capabilities ?? {};
	};
}

/** The machine column cell: identity square, short name, amber "unreachable" when the machine is down. */
export function OpsMachineCell({ machine }: { machine: OpsMachine }) {
	return (
		<span title={machine.name}>
			<MachineCell
				name={machine.short}
				color={machine.color}
				reachable={machine.reachable}
				lastKnown={machine.lastKnown}
				since={machineSince(machine)}
			/>
		</span>
	);
}

/** The time the machine's state tooltip is dated from: when the hub started holding it, or when it last answered. */
export function machineSince(machine: OpsMachine): number | null {
	return machine.lastKnown ? machine.staleSince : machine.lastOkAt;
}

/** "unreachable since …" or "last known as of …; reconnecting"; null while the machine is live. */
export function machineStatus(machine: OpsMachine): string | null {
	if (!machine.reachable) return unreachableTitle(machineSince(machine));
	return machine.lastKnown ? lastKnownTitle(machineSince(machine)) : null;
}

/**
 * Group heading under All machines: the machine with the shared availability mark (hollow amber ring while the hub
 * holds its last known answer, solid amber when unreachable, words in the tooltip), a count, and an optional hint.
 */
export function MachineGroupLabel({ machine, count, hint }: { machine: OpsMachine; count?: string; hint?: ReactNode }) {
	return (
		<span className="ops-group">
			<span className="ops-group-head">
				<b>
					<MachineCell
						name={machine.name}
						color={machine.color}
						reachable={machine.reachable}
						lastKnown={machine.lastKnown}
						since={machineSince(machine)}
					/>
				</b>
				{count && <span className="ops-dim">{count}</span>}
			</span>
			{hint && <span className="ops-group-hint">{hint}</span>}
		</span>
	);
}

/**
 * A short failure note with its retry: the words may shorten with an ellipsis (full text on hover), the button
 * never does, so it stays in view and clickable at any width.
 */
export function RetryNote({
	text,
	detail,
	onRetry,
	busy = false,
}: {
	text: string;
	detail?: string;
	onRetry: () => void;
	/** A Try again is in progress: the button says "Checking…" and waits. */
	busy?: boolean;
}) {
	return (
		<span className="ops-retry ops-warn">
			<span className="ops-retry-text" title={detail ? `${text}\n${detail}` : text}>
				{text}
			</span>
			<span aria-hidden="true">{"\u00a0·\u00a0"}</span>
			<button type="button" className="btn" data-size="sm" data-variant="ghost" disabled={busy} onClick={onRetry}>
				{busy ? "Checking…" : "Try again"}
			</button>
		</span>
	);
}

/** One line for a single-machine view whose machine is held or unreachable; nothing while it is live. */
export function MachineAvailability({ machine }: { machine: OpsMachine }) {
	const status = machineStatus(machine);
	if (!status) return null;
	return (
		<p className="ops-availability" data-state={machine.reachable ? "last-known" : "unreachable"} role="status">
			<MachineCell
				name={machine.name}
				color={machine.color}
				reachable={machine.reachable}
				lastKnown={machine.lastKnown}
				since={machineSince(machine)}
			/>
			<span>{status}</span>
		</p>
	);
}

/**
 * Group headings for machines that gave no answer at all (cold load), so a grouped table keeps every machine:
 * "Ada Mac mini unreachable; jobs unavailable" instead of the machine silently missing.
 */
export function unavailableGroups<T>(
	answers: readonly MachineAnswer<T>[],
	hasRows: (machine: string) => boolean,
	what: string,
): { key: string; label: ReactNode; note: string }[] {
	return answers
		.filter(answer => !answer.data && (answer.error || !answer.machine.reachable) && !hasRows(answer.machine.id))
		.map(answer => ({
			key: answer.machine.id,
			label: <MachineGroupLabel machine={answer.machine} />,
			note: `${answer.machine.name} ${answer.machine.reachable ? "didn't answer" : "unreachable"}; ${what} unavailable`,
		}));
}

/**
 * Why a machine's hub request failed, as a short phrase ("it's unreachable", "it didn't answer in time"). These are
 * hub requests, not stats ones, so the wording names the machine or its hub; callers keep the raw reason for a title.
 */
export function plainHubReason(
	reason: string | null | undefined,
	{ reachable = true, refreshing }: { reachable?: boolean; refreshing: boolean },
): string {
	// "retrying" is only true when the page asks again by itself; otherwise the person has to press Try again.
	const retrying = refreshing ? "; retrying" : "";
	if (!reachable || /^(machine )?unreachable$/i.test(reason?.trim() ?? "")) return "it's unreachable";
	switch (classifyStatsFailure(reason).kind) {
		case "version":
			return "its hub is a different version until it's updated";
		case "unexpected":
			return "it sent an unexpected answer";
		case "clock":
			return `clocks are out of sync or the hub restarted${retrying}`;
		case "timeout":
			return "it didn't answer in time";
		case "down":
			return "its hub isn't answering";
		case "loading":
			return "it's still loading";
		case "busy":
			return `it's busy${retrying}`;
		case "setup":
			return "this hub isn't set up for it yet";
		case "unknown":
			return "it returned an error";
	}
}

/**
 * The hub's report on its machine's relay, as a short phrase per problem ("its web page isn't built yet"). The
 * hub's own text (with the command to fix it) stays in the tooltip.
 */
export function plainRelayProblem(reason: string | null | undefined): string {
	if (!reason?.trim()) return "the relay isn't answering";
	const phrases = reason.split(";").map((part): string | null => {
		const text = part.trim();
		if (text.startsWith("relay not reachable")) return "the relay isn't answering";
		if (text.startsWith("web UI not built")) return "its web page isn't built yet";
		if (text.startsWith("relay does not know the owner yet"))
			return "it doesn't know the owner yet (is Tailscale up?)";
		if (text.startsWith("relay web client predates Disconnect")) return "its web client needs a rebuild";
		if (text === "relay identity check failed") return "the relay is a different version until it's updated";
		if (text === "relay viewer status unavailable") return "its viewer list didn't load";
		// The tail of a multi-problem rebuild hint ("rebuild it") belongs to the phrase before it.
		if (text === "rebuild it") return null;
		return "it reported a problem";
	});
	return [...new Set(phrases.filter((p): p is string => p !== null))].join("; ");
}

/** The hub's last alert error as a short phrase; the exception text stays in the tooltip. */
export function plainAlertProblem(reason: string): string {
	if (reason.startsWith("sending alert:")) return "the last alert didn't send";
	if (reason.startsWith("watching sessions:")) return "it stopped watching sessions";
	return "it reported a problem";
}

/** One amber line per machine whose request failed, above the card it affects. */
export function MachineProblems<T>({
	answers,
	what,
	onRetry,
	polling,
}: {
	answers: readonly MachineAnswer<T>[];
	what: string;
	onRetry: () => void;
	/** The page asks again by itself, so a passing problem may say "retrying". */
	polling: boolean;
}) {
	const failed = answers.filter(answer => answer.error);
	if (!failed.length) return null;
	return (
		<div className="ops-problems">
			{failed.map(answer => (
				<p key={answer.machine.id} className="ops-problem" role="status">
					<TriangleAlert size={14} aria-hidden="true" />
					<span title={answer.error ?? undefined}>
						<b>{answer.machine.id ? answer.machine.name : answer.machine.short}</b> didn&apos;t answer {what}:{" "}
						{plainHubReason(answer.error, { reachable: answer.machine.reachable, refreshing: polling })}.
						{answer.stale ? " Its last known rows are greyed." : ""}
					</span>
					<button type="button" className="btn" data-size="sm" data-variant="ghost" onClick={onRetry}>
						Try again
					</button>
				</p>
			))}
		</div>
	);
}

/** A capability the machine's hub lacks: the action is hidden and this says why. */
export function UpdateHubHint({ machine, children }: { machine: OpsMachine; children: ReactNode }) {
	return (
		<span className="ops-update">
			Update the hub on {machine.name} {children}
		</span>
	);
}

/** "2 min ago" / "in 19 h" / "10 Nov"; the full PKT time on hover. */
export function When({ at, empty = "–" }: { at: number | null | undefined; empty?: string }) {
	if (!at) return <span className="ops-dim">{empty}</span>;
	const delta = at - Date.now(),
		abs = Math.abs(delta);
	const title = `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(new Date(at))} PKT`;
	let text: string;
	if (abs >= 7 * 86_400_000)
		text = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Karachi" }).format(
			new Date(at),
		);
	else {
		const [n, unit] =
			abs < 60_000
				? [0, ""]
				: abs < 3_600_000
					? [Math.round(abs / 60_000), "min"]
					: abs < 86_400_000
						? [Math.round(abs / 3_600_000), "h"]
						: [Math.round(abs / 86_400_000), "d"];
		text = !unit ? (delta > 0 ? "in <1 min" : "just now") : delta > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
	}
	return <time title={title}>{text}</time>;
}

/** "iPad · Safari" from a user-agent; a label that is not a user-agent is shown as it is. */
export function browserName(label: string): string {
	if (!label.startsWith("Mozilla/")) return label;
	const device = /iPhone/.test(label)
		? "iPhone"
		: /iPad/.test(label)
			? "iPad"
			: /Android/.test(label)
				? "Android"
				: /Macintosh/.test(label)
					? "Mac"
					: /Windows/.test(label)
						? "Windows"
						: /Linux/.test(label)
							? "Linux"
							: "Browser";
	const browser = /Firefox\//.test(label)
		? "Firefox"
		: /Edg\//.test(label)
			? "Edge"
			: /Chrome\/|537\.36/.test(label)
				? "Chrome or Edge"
				: /605\.1\.15|Safari\//.test(label)
					? "Safari"
					: "browser";
	return `${device} · ${browser}`;
}
