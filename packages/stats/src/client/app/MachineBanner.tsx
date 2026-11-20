import { useEffect, useSyncExternalStore } from "react";
import { ALL_MACHINES_FAILED, type FleetQueryMachine } from "../data/fleet-query";
import { getHubMachine } from "../data/hub";
import { useHubPresent } from "../data/hub-presence";
import { usePageActive } from "../data/page-active";
import { useQuery } from "../data/query";
import { ALL_MACHINES, machineView, useFleet, useSelectedMachine } from "./machine";
import { statsFailureSentence } from "./stats-reasons";

const REFRESH_MS = 5 * 60_000;

/** Machine-name chip in the topbar: tells two otherwise identical dashboards apart. Renders nothing without a name. */
export function MachineBanner() {
	const fleet = useFleet();
	const hubPresent = useHubPresent();
	const selected = useSelectedMachine();
	// Fleet mode: the chip names the machine the per-machine pages show, from the machine list.
	const machine = useQuery(["hub-machine"], ({ signal }) => getHubMachine(signal), {
		pollMs: REFRESH_MS,
		scope: "local",
		// Header metadata, not the page's numbers: it doesn't make the page "refresh every 5 min".
		countsAsPagePolling: false,
		enabled: fleet === null && hubPresent,
	});
	const view = machineView(
		fleet
			? selected === ALL_MACHINES
				? "All machines"
				: fleet.find(m => m.id === selected)?.name
			: machine.data?.name,
	);
	const name = view?.name;
	useEffect(() => {
		if (!name) return;
		const previous = document.title;
		document.title = `${name} · ${previous.replace(/^.* · /, "")}`;
		return () => {
			document.title = previous;
		};
	}, [name]);
	if (!view) return null;
	return (
		<div
			className="machine-banner"
			role="status"
			aria-label={view.label}
			title={view.label}
			style={{ "--machine-accent": view.accent } as React.CSSProperties}
		>
			<span className="machine-banner-dot" aria-hidden="true" />
			<span className="machine-banner-name">{view.name}</span>
			<span className="machine-banner-scope">
				{fleet && selected === ALL_MACHINES ? `${fleet.filter(m => m.ok).length} reachable` : view.scope}
			</span>
		</div>
	);
}

function names(list: FleetQueryMachine[]): string {
	const all = list.map(machine => machine.name);
	return all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}` : (all[0] ?? "");
}

/** One sentence of the missing-numbers banner, with the raw reason (if any) for its tooltip. */
export interface MissingMachineNote {
	text: string;
	detail: string | null;
}

/**
 * Why aggregate numbers may be incomplete, in plain words. A machine the hub can't reach is "unreachable"; one the
 * hub is holding is "last known"; a real version signal is "out of date"; any other stats failure is worded by
 * {@link statsFailureSentence}, with the technical reason kept for the tooltip.
 * Renders under the page title (see `.missing-machines` in styles.css).
 */
export function missingMachineNotes(machines: FleetQueryMachine[]): MissingMachineNote[] {
	const unreachable = machines.filter(machine => !machine.lastKnown && machine.error === "unreachable");
	const outdated = machines.filter(
		machine => !machine.lastKnown && machine.error !== "unreachable" && machine.outdated,
	);
	// The hub's grace period explains everything else about the machine (a timed-out refresh included).
	const lastKnown = machines.filter(machine => machine.lastKnown);
	const failed = machines.filter(
		machine =>
			!machine.lastKnown && machine.error !== "unreachable" && !machine.outdated && (!machine.ok || machine.stale),
	);
	const notes: MissingMachineNote[] = [];
	if (unreachable.length)
		notes.push({
			text:
				unreachable.length > 1
					? `${names(unreachable)} are unreachable; their numbers are missing.`
					: `${names(unreachable)} is unreachable; its numbers are missing.`,
			detail: null,
		});
	if (outdated.length)
		notes.push({
			text:
				outdated.length > 1
					? `Stats on ${names(outdated)} are out of date (update the hub).`
					: `${names(outdated)}'s stats are out of date (update the hub).`,
			detail: null,
		});
	if (lastKnown.length)
		notes.push({
			text: `${names(lastKnown)} ${lastKnown.length > 1 ? "show" : "shows"} last known numbers while the hub reconnects.`,
			detail: null,
		});
	for (const machine of failed)
		// The fleet query asks a failed machine again on its own (back-off), so "retrying" is true here.
		notes.push({
			text: statsFailureSentence(machine.name, machine.error, { refreshing: true }),
			detail: machine.error || null,
		});
	return notes;
}

export function missingMachinesText(machines: FleetQueryMachine[]): string[] {
	return missingMachineNotes(machines).map(note => note.text);
}

/**
 * Every machine has definitively failed and none has numbers to show (none held, none with cached data): the page's
 * single "No machine's stats answered" line then carries the reasons, so the banner stays out of the way.
 */
export function everyMachineFailed(machines: readonly FleetQueryMachine[]): boolean {
	return (
		machines.length > 0 && machines.every(machine => machine.error !== null && !machine.lastKnown && !machine.stale)
	);
}

/**
 * Views on screen that list every machine's failure reason themselves (an all-failed line). While one is mounted the
 * amber banner would only repeat it, so the banner steps aside; pages without one keep the banner.
 */
let reasonOwners = 0;
const ownerListeners = new Set<() => void>();
function ownersChanged(): void {
	for (const listener of ownerListeners) listener();
}

/** Call from a view that shows each machine's failure reason: the amber banner hides while it is mounted. */
export function useOwnsMachineReasons(active = true): void {
	// A kept-but-hidden page's failed line must not hide the visible page's banner.
	const pageActive = usePageActive();
	const owning = active && pageActive;
	useEffect(() => {
		if (!owning) return;
		reasonOwners++;
		ownersChanged();
		return () => {
			reasonOwners--;
			ownersChanged();
		};
	}, [owning]);
}

function useReasonsOwned(): boolean {
	return useSyncExternalStore(
		listener => {
			ownerListeners.add(listener);
			return () => ownerListeners.delete(listener);
		},
		() => reasonOwners > 0,
	);
}

/** The all-failed line's body: the headline, then each machine's reason (raw cause in its tooltip). */
export function AllMachinesFailed({ machines }: { machines: FleetQueryMachine[] }) {
	useOwnsMachineReasons();
	const notes = missingMachineNotes(machines);
	return (
		<>
			<span>{ALL_MACHINES_FAILED}</span>
			{notes.length > 0 && (
				<span className="error-state-reasons">
					{notes.map(note => (
						<span key={note.text} title={note.detail ? `Details: ${note.detail}` : undefined}>
							{note.text}
						</span>
					))}
				</span>
			)}
		</>
	);
}

export function MissingMachineNumbers({ machines }: { machines: FleetQueryMachine[] }) {
	// A view on the page already lists every machine's reason (an all-failed line): don't say it twice.
	const owned = useReasonsOwned();
	const notes = owned ? [] : missingMachineNotes(machines);
	if (!notes.length) return null;
	return (
		<p className="missing-machines" role="status">
			{notes.map((note, index) => (
				<span key={note.text} title={note.detail ? `Details: ${note.detail}` : undefined}>
					{index > 0 ? " " : ""}
					{note.text}
				</span>
			))}
		</p>
	);
}
