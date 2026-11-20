import { useEffect, useMemo, useRef, useState } from "react";
import {
	ALL_MACHINES,
	concreteMachine,
	getFleet,
	shortMachineName,
	useFleet,
	useSelectedMachine,
} from "../app/machine";
import { plainStatsReason } from "../app/stats-reasons";
import { getAccountDashboardStats, getAccountFlowStats, getProviderWindowStats } from "../api";
import { fleetQueryView, useFleetQuery } from "../data/fleet-query";
import { mergeAccounts, mergeAccountFlow } from "../data/fleet-merge";
import {
	fetchConnections,
	removeCredential,
	type ConnectionAccount,
	type ConnectionsResponse,
} from "../data/connections";
import { formatEstimatedCost, formatInteger, formatRelativeTime } from "../data/formatters";
import { providerName } from "../data/hub-view";
import { useHubPresent } from "../data/hub-presence";
import { useQuery } from "../data/query";
import { rangeMeta } from "../data/range";
import type { AccountStats, TimeRange, UsageWindowSeries } from "../types";
import { LabelCell, loadingText, Modal, PageHeader, StatusCell, Table } from "../ui";
import {
	MachineAvailability,
	MachineGroupLabel,
	machineColor,
	machineStatus,
	type OpsMachine,
	plainHubReason,
	plural,
	RetryNote,
} from "./ops-common";
import { AccountFlowChart, useAccountPalette } from "./AccountRouting";
import { AccountFlow, type FlowMode } from "./accounts/AccountFlow";
import { useHiddenSeries } from "../charts";
import "./accounts.css";

/** How long one machine's login list may take before it counts as not answering. */
const CONNECTIONS_TIMEOUT_MS = 20_000;

export interface AccountsRouteProps {
	active: boolean;
	range: TimeRange;
}
type Machine = {
	id: string;
	name: string;
	ok: boolean;
	lastOkAt: number | null;
	stale?: boolean;
	staleSince?: number | null;
};
type Row = {
	account: AccountStats | null;
	provider: string;
	identity: string;
	email: string | null;
	accountId: string | null;
	orgId: string | null;
	label: string | null;
	providerLabel: string;
	connectionsByMachine: Map<string, ConnectionAccount[]>;
	statsByMachine: Map<string, AccountStats>;
	key: string;
};
type ConnectionRows = Record<string, ConnectionsResponse | null>;

function family(provider: string): string {
	return provider.replace(/-\d+$/, "");
}
function accountEmail(account: ConnectionAccount): string | null {
	return (
		account.email ??
		/^([^\s@]+\x40[^\s@]+)/.exec(account.identity)?.[1] ??
		/\((\S+@\S+)'s Organization\)/.exec(account.identity)?.[1] ??
		null
	);
}
function accountId(account: ConnectionAccount): string | null {
	return (
		account.accountId ??
		/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(account.identity)?.[1] ??
		null
	);
}
function matches(row: Row, provider: string, account: ConnectionAccount): boolean {
	if (family(row.provider) !== family(provider)) return false;
	const email = accountEmail(account);
	if (row.accountId && accountId(account) && row.accountId.toLowerCase() === accountId(account)?.toLowerCase())
		return !row.orgId || !account.orgId || row.orgId === account.orgId;
	if (row.email && email)
		return (
			row.email.toLowerCase() === email.toLowerCase() &&
			(!row.orgId || !account.orgId || row.orgId === account.orgId)
		);
	return [...row.connectionsByMachine.values()].some(accounts => accounts.includes(account));
}
function oldHub(account: ConnectionAccount): boolean {
	return typeof account.credentialId !== "number";
}
function title(row: Row): string {
	const name = row.providerLabel;
	if (row.label) return `${name} · ${row.label.replace(/ Account$/, "")}`;
	if (row.email) return `${name} · ${row.email}`;
	if (row.account?.credentialType === "api_key" || row.identity.endsWith(" API key")) return `${name} · API key`;
	if (row.accountId) return `${name} · account ${row.accountId.slice(-6)}`;
	return row.identity;
}
function connectionFor(
	row: Row,
	data: ConnectionsResponse | null | undefined,
): { account: ConnectionAccount; provider: string } | undefined {
	let result: { account: ConnectionAccount; provider: string } | undefined;
	for (const provider of data?.providers ?? [])
		for (const account of provider.accounts) {
			if (matches(row, provider.provider, account) && (!result || (result.account.managed && !account.managed)))
				result = { account, provider: provider.provider };
		}
	return result;
}
export interface AccountState {
	/** Machine dot state in the row detail. */
	state: "unreachable" | "checking" | "problem" | "removed" | "idle" | "used" | "standby" | "limited";
	/** The Status pill. */
	label: string;
	tone: "neutral" | "ok" | "warn" | "error";
	/** One short line beside the pill; never the raw provider error. */
	reason: string;
	/** The provider's own error text, shown only in the row detail. */
	detail: string | null;
}

/** A provider's raw login error, as a few plain words for the table. The full text stays in the row detail. */
export function shortLoginCause(cause: string | null | undefined): string {
	if (!cause) return "not logged in";
	if (/invalid_grant|refresh[^:]*fail|expired|revoked/i.test(cause)) return "sign-in expired";
	if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(cause)) return "access refused";
	if (/deleted by user/i.test(cause)) return "removed here";
	return "login needs attention";
}

export function accountState(
	row: Row,
	machine: Machine,
	data: ConnectionsResponse | null | undefined,
	stats: AccountStats | undefined,
	now = Date.now(),
): AccountState {
	if (!machine.ok)
		return {
			state: "unreachable",
			label: "Unreachable",
			tone: "neutral",
			reason: machine.lastOkAt ? `last answered ${formatRelativeTime(machine.lastOkAt)}` : "no answer",
			detail: null,
		};
	// Its login list hasn't answered yet: nothing is known about the account here, so nothing is said either way.
	if (data === undefined)
		return {
			state: "checking",
			label: "Checking…",
			tone: "neutral",
			reason: "login list still loading",
			detail: null,
		};
	// Reachable, but its login list failed to load: a separate state, never "unreachable".
	if (data === null)
		return { state: "unreachable", label: "Not loaded", tone: "warn", reason: "accounts didn't load", detail: null };
	const item = connectionFor(row, data);
	if (!item) {
		if (stats?.status === "needs_login")
			return {
				state: "problem",
				label: "Needs login",
				tone: "error",
				reason: `${shortLoginCause(stats.disabledCause)} · Reconnect`,
				detail: stats.disabledCause,
			};
		if (stats?.status === "removed")
			return {
				state: "removed",
				label: "Removed",
				tone: "neutral",
				reason: "usage from before it was removed",
				detail: null,
			};
		return { state: "removed", label: "Not added", tone: "neutral", reason: "not added here", detail: null };
	}
	if (item.account.managed)
		return {
			state: "idle",
			label: "OK",
			tone: "ok",
			reason: "kept by the multi-auth plugin",
			detail: null,
		};
	if (oldHub(item.account))
		return {
			state: stats?.status === "active" ? "used" : "idle",
			label: "OK",
			tone: "ok",
			reason: "update this machine's hub to manage it",
			detail: null,
		};
	if (!item.account.ok)
		return {
			state: "problem",
			label: "Needs login",
			tone: "error",
			reason: `${shortLoginCause(stats?.disabledCause)} · Reconnect`,
			detail: stats?.disabledCause ?? null,
		};
	if (stats?.status === "blocked") {
		const until = stats.blocks.reduce((latest, b) => Math.max(latest, b.until), 0);
		return {
			state: "limited",
			label: "Rate limited",
			tone: "warn",
			reason: until > now ? `lifts ${formatRelativeTime(until)}` : "by the provider",
			detail: null,
		};
	}
	const peers =
		data?.providers
			.filter(p => family(p.provider) === family(item.provider))
			.flatMap(p => p.accounts)
			.filter(account => !account.managed && !oldHub(account)) ?? [];
	const first = peers.reduce<ConnectionAccount | undefined>(
		(best, next) => (!best || next.priority > best.priority ? next : best),
		undefined,
	);
	if (first && item.account.priority < first.priority && stats?.status !== "active")
		return {
			state: "standby",
			label: "Backup",
			tone: "neutral",
			reason: `used when ${first.email ?? first.identity} runs out`,
			detail: null,
		};
	return {
		state: stats?.status === "active" ? "used" : "idle",
		label: "OK",
		tone: "ok",
		reason: stats?.status === "active" ? "in use" : "logged in",
		detail: null,
	};
}

export function mergeWindowHistory(answers: { machine: string; series: UsageWindowSeries[] }[]) {
	const grouped = new Map<string, UsageWindowSeries & { machine: string }>();
	for (const answer of answers)
		for (const series of answer.series) {
			const key = JSON.stringify([answer.machine, series.provider, series.accountKey, series.windowKey]);
			const previous = grouped.get(key);
			if (!previous) grouped.set(key, { ...series, machine: answer.machine, points: [...series.points] });
			else {
				const points = new Map(previous.points.map(point => [point.timestamp, point]));
				for (const point of series.points) points.set(point.timestamp, point);
				previous.points = [...points.values()].sort((a, b) => a.timestamp - b.timestamp);
			}
		}
	return [...grouped.values()];
}

function WindowHistory({ row, all }: { row: Row; all: boolean }) {
	const provider = family(row.provider);
	const one = useQuery(
		["provider-windows", provider, "24h"],
		({ signal }) => getProviderWindowStats("24h", provider, signal, concreteMachine()),
		{ enabled: !all },
	);
	const many = useFleetQuery(
		["provider-windows", provider, "24h"],
		async (machine, signal) => ({
			machine,
			series: (await getProviderWindowStats("24h", provider, signal, machine)).usageSeries,
		}),
		mergeWindowHistory,
		{ enabled: all },
	);
	const series = all
		? (many.data ?? [])
		: mergeWindowHistory([{ machine: concreteMachine() ?? "", series: one.data?.usageSeries ?? [] }]);
	const windows = series.filter(item => item.accountLabel === row.identity || item.accountKey === row.account?.key);
	if (!windows.length) return null;
	const rows = windows.map((item, index) => {
		let peak = 0,
			resets = 0,
			used = 0,
			exhausted = 0;
		let previous: number | null = null,
			wasExhausted = false;
		for (const point of item.points) {
			if (point.usedFraction !== null) {
				peak = Math.max(peak, point.usedFraction);
				if (previous !== null) {
					if (point.usedFraction < previous) {
						resets++;
						used += point.usedFraction;
					} else used += point.usedFraction - previous;
				}
				previous = point.usedFraction;
			}
			if (point.exhausted && !wasExhausted) exhausted++;
			wasExhausted = point.exhausted;
		}
		return { key: `${item.machine}/${item.windowKey}-${index}`, item, peak, resets, used, exhausted };
	});
	return (
		<Table
			variant="std"
			dense
			title={title(row)}
			rows={rows}
			rowKey={r => r.key}
			columns={[
				{
					key: "window",
					header: "Window",
					sort: r => r.item.windowLabel,
					render: r => (all ? `${r.item.windowLabel} · ${r.item.machine}` : r.item.windowLabel),
				},
				{
					key: "peak",
					header: "Peak",
					kind: "percent",
					width: 80,
					sort: r => r.peak,
					render: r => `${Math.round(r.peak * 100)}%`,
				},
				{ key: "resets", header: "Resets", kind: "number", width: 80, sort: r => r.resets, render: r => r.resets },
				{
					key: "used",
					header: "Used",
					kind: "percent",
					width: 80,
					sort: r => r.used,
					render: r => `${Math.round(r.used * 100)}%`,
				},
				{
					key: "out",
					header: "Ran out",
					kind: "number",
					width: 80,
					sort: r => r.exhausted,
					render: r => r.exhausted,
				},
			]}
		/>
	);
}

export function AccountsRoute({ active, range }: AccountsRouteProps) {
	const hubPresent = useHubPresent();
	const fleet = useFleet();
	const selected = useSelectedMachine();
	const all = selected === ALL_MACHINES;
	const machines: Machine[] = fleet?.length ? fleet : [{ id: "", name: "This machine", ok: true, lastOkAt: null }];
	const machineKey = machines.map(m => `${m.id}:${m.ok}`).join(",");
	const [connections, setConnections] = useState<ConnectionRows>({});
	/** Why a reachable machine's login list failed to load, by machine id. */
	const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});
	const [revision, setRevision] = useState(0);
	const [flow, setFlow] = useState<FlowMode | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [menu, setMenu] = useState<string | null>(null);
	const [removal, setRemoval] = useState<{ row: Row; machine: Machine; account: ConnectionAccount } | null>(null);
	const [removeError, setRemoveError] = useState("");
	const [removing, setRemoving] = useState(false);
	const changed = () => setRevision(n => n + 1);
	/**
	 * One machine's login list into state. Answers that arrive after `signal` aborted are dropped; a list that never
	 * answers fails as a timeout, so neither the note nor "Checking…" can hang.
	 */
	const loadConnections = (machine: string, signal: AbortSignal) =>
		fetchConnections(machine || undefined, AbortSignal.any([signal, AbortSignal.timeout(CONNECTIONS_TIMEOUT_MS)]))
			.then(data => {
				if (signal.aborted) return;
				setConnections(previous => ({ ...previous, [machine]: data }));
				setConnectionErrors(({ [machine]: _, ...rest }) => rest);
			})
			.catch((error: unknown) => {
				if (signal.aborted) return;
				setConnections(previous => ({ ...previous, [machine]: null }));
				setConnectionErrors(previous => ({
					...previous,
					[machine]: error instanceof Error ? error.message : String(error),
				}));
			});
	useEffect(() => {
		if (!active || !hubPresent) return;
		const controller = new AbortController();
		for (const machine of machines) {
			if (!machine.ok) {
				setConnections(previous => ({ ...previous, [machine.id]: null }));
				setConnectionErrors(({ [machine.id]: _, ...rest }) => rest);
				continue;
			}
			void loadConnections(machine.id, controller.signal);
		}
		return () => controller.abort();
	}, [active, machineKey, revision, hubPresent]);
	/**
	 * The current Try again: its own requests, and the shown machines it still waits on. A new Try again, another
	 * machine picked in the header, leaving the page or unmounting cancels it, so "Checking…" only ever reflects
	 * this view's own pending requests.
	 */
	const retryRun = useRef<AbortController | null>(null);
	const [checkingMachines, setCheckingMachines] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		retryRun.current?.abort();
		retryRun.current = null;
		setCheckingMachines(new Set());
	}, [selected, active]);
	useEffect(() => () => retryRun.current?.abort(), []);
	const single = useQuery(
		["accounts", range, revision],
		({ signal }) => getAccountDashboardStats(range, signal, concreteMachine()),
		{ enabled: active && !all },
	);
	const multi = useFleetQuery(
		["accounts", range, revision],
		async (machine, signal) => ({ machine, data: await getAccountDashboardStats(range, signal, machine) }),
		// Which machines' numbers are in: an empty answer still counts, a pending or failed one never does.
		answers => ({ ...mergeAccounts(answers), answeredMachines: answers.map(answer => answer.machine) }),
		{ enabled: active && all },
	);
	const singleFlow = useQuery(
		["account-flow", "24h"],
		({ signal }) => getAccountFlowStats("24h", signal, concreteMachine()),
		{ enabled: active && !all },
	);
	const multiFlow = useFleetQuery(
		["account-flow", "24h"],
		(machine, signal) => getAccountFlowStats("24h", signal, machine),
		mergeAccountFlow,
		{ enabled: active && all },
	);
	const stats = all ? multi.data : single.data;
	const traffic = all ? multiFlow.data : singleFlow.data;
	const [hiddenSeries, toggleSeries] = useHiddenSeries();
	const palette = useAccountPalette(stats, traffic);
	const visibleMachines = all || !fleet ? machines : machines.filter(m => m.id === selected);
	const rows = useMemo(() => {
		const result: Row[] = [];
		for (const [machine, answer] of Object.entries(connections)) {
			if (!visibleMachines.some(m => m.id === machine)) continue;
			for (const provider of answer?.providers ?? [])
				for (const account of provider.accounts) {
					const found = result.find(row => matches(row, provider.provider, account));
					if (found) {
						found.label ??= account.label;
						found.accountId ??= accountId(account);
						found.orgId ??= account.orgId;
						found.connectionsByMachine.set(machine, [
							...(found.connectionsByMachine.get(machine) ?? []),
							account,
						]);
						if (account.email) found.identity = account.identity;
					} else
						result.push({
							account: null,
							provider: provider.provider,
							providerLabel:
								providerName(family(provider.provider)) === family(provider.provider)
									? provider.label
									: providerName(family(provider.provider)),
							connectionsByMachine: new Map([[machine, [account]]]),
							statsByMachine: new Map(),
							identity: account.identity,
							email: accountEmail(account),
							accountId: accountId(account),
							orgId: account.orgId,
							label: account.label,
							key: `${machine}/${provider.provider}/${account.credentialId ?? account.identity}/${account.orgId ?? ""}`,
						});
				}
		}
		const perMachine = all
			? (multi.data?.machineAccounts ?? [])
			: (stats?.accounts ?? []).map(account => ({
					machine: selected && selected !== ALL_MACHINES ? selected : "",
					account,
				}));
		for (const { machine, account } of perMachine) {
			const accountId = /(?:^|[|/])account:([^|]+)/.exec(account.key)?.[1] ?? null;
			const found = result.find(
				row =>
					family(row.provider) === family(account.provider) &&
					((row.accountId &&
						accountId &&
						row.accountId === accountId &&
						(!row.orgId || !account.orgId || row.orgId === account.orgId)) ||
						(row.email &&
							account.email &&
							row.email.toLowerCase() === account.email.toLowerCase() &&
							(!row.orgId || !account.orgId || row.orgId === account.orgId)) ||
						(!row.email &&
							!account.email &&
							!row.accountId &&
							!accountId &&
							(row.connectionsByMachine.get(machine) ?? []).some(
								connection =>
									typeof connection.credentialId === "number" &&
									account.credentialIds.includes(connection.credentialId),
							))),
			);
			if (!found)
				result.push({
					account,
					provider: account.provider,
					providerLabel: providerName(family(account.provider)),
					connectionsByMachine: new Map(),
					statsByMachine: new Map([[machine, account]]),
					identity: account.email ?? account.label,
					email: account.email,
					accountId,
					orgId: account.orgId,
					label: null,
					key: account.email || accountId ? account.key : `${machine}/${account.key}`,
				});
			else {
				found.statsByMachine.set(machine, account);
				if (!found.account) {
					found.account = account;
					continue;
				}
				const current = found.account;
				const quotas = new Map(current.quotas.map(q => [q.limitId, q]));
				for (const quota of account.quotas)
					if (!quotas.has(quota.limitId) || quotas.get(quota.limitId)!.recordedAt < quota.recordedAt)
						quotas.set(quota.limitId, quota);
				found.account = {
					...current,
					requests: current.requests + account.requests,
					totalCost: current.totalCost + account.totalCost,
					unpricedRequests: current.unpricedRequests + account.unpricedRequests,
					totalTokens: current.totalTokens + account.totalTokens,
					quotas: [...quotas.values()],
					servingNow: current.servingNow || account.servingNow,
					servedLatestNewSession: current.servedLatestNewSession || account.servedLatestNewSession,
				};
			}
		}
		return result;
	}, [stats, connections, machineKey, selected]);
	const machineStats = (row: Row, machine: Machine) => row.statsByMachine.get(machine.id);
	const existing = Object.fromEntries(
		machines.map(m => [
			m.id,
			(connections[m.id]?.providers ?? []).flatMap(p =>
				p.accounts.map(a => ({
					provider: p.provider,
					identity: a.identity,
					credentialId: a.credentialId,
					managed: a.managed,
				})),
			),
		]),
	);
	const statusMachines = visibleMachines;
	const stateOf = (row: Row, m: Machine): AccountState => {
		const account = machineStats(row, m);
		if (hubPresent || !m.ok) return accountState(row, m, connections[m.id], account);
		const needsLogin = account?.status === "needs_login";
		const limited = account?.status === "blocked";
		return {
			state: needsLogin ? "problem" : limited ? "limited" : account?.status === "active" ? "used" : "idle",
			label: needsLogin ? "Needs login" : limited ? "Rate limited" : "Unknown",
			tone: needsLogin ? "error" : limited ? "warn" : "neutral",
			reason: "Login status needs the omp hub",
			detail: needsLogin ? (account?.disabledCause ?? null) : null,
		};
	};
	const attention = rows.filter(row => visibleMachines.some(m => stateOf(row, m).state === "problem")).length;
	/** A machine whose login list has not answered yet: counts would read as final zeros. */
	const connectionsLoading = hubPresent && visibleMachines.some(m => !(m.id in connections));
	const grouped = visibleMachines.length > 1;
	/** The machine as the ops pages draw it: reachability is the fleet's, whatever its login list did. */
	const opsMachine = (m: Machine): OpsMachine => ({
		id: m.id,
		name: m.name,
		short: shortMachineName(m.name),
		color: machineColor(m.name),
		self: false,
		reachable: m.ok,
		lastOkAt: m.lastOkAt,
		lastKnown: m.ok && m.stale === true,
		staleSince: m.staleSince ?? null,
		dashboardUrl: null,
	});
	const tableRows = visibleMachines.flatMap(machine =>
		rows
			.filter(row => row.connectionsByMachine.has(machine.id) || row.statsByMachine.has(machine.id))
			.map(row => ({
				machine,
				row: {
					...row,
					key: `${machine.id}/${row.key}`,
					account: row.statsByMachine.get(machine.id) ?? null,
				},
			})),
	);
	const unavailable = (m: Machine) => `${m.name} unreachable; accounts unavailable`;
	/** A reachable machine whose login list failed: its reason and a retry, shown in its group. */
	const noAnswer = (m: Machine) =>
		m.ok && connectionErrors[m.id] !== undefined ? (
			<RetryNote
				// Nothing polls the login lists: only Try again asks again, so the wording never says "retrying".
				text={`${m.name}'s accounts didn't load: ${plainHubReason(connectionErrors[m.id], { refreshing: false })}`}
				detail={connectionErrors[m.id]}
				onRetry={retry}
				busy={checkingMachines.has(m.id) || query.checking}
			/>
		) : null;
	const unreachableCount = visibleMachines.filter(m => !m.ok).length;
	/** Why a machine's usage numbers failed, or null while they are on their way or in. */
	const statsFailure = (m: Machine): string | null =>
		all ? (multi.machines.find(x => x.id === m.id)?.error ?? null) : (single.error?.message ?? null);
	/** Positive evidence only: the numbers arrived (an empty answer counts) and no later request failed. */
	const statsAnswered = (m: Machine) =>
		statsFailure(m) === null && (all ? (multi.data?.answeredMachines.includes(m.id) ?? false) : single.data !== null);
	/**
	 * Two separate questions per reachable machine. Which subscriptions it has comes from its login list; how much
	 * they were used comes from its stats server. A machine whose stats answered with a problem (a different
	 * version, say) still answered: its subscriptions count, and only its usage numbers are said to be missing.
	 */
	const reachable = visibleMachines.filter(m => m.ok);
	const loginsLoaded = reachable.filter(m => !!connections[m.id]);
	const loginsPending = hubPresent ? reachable.filter(m => !(m.id in connections)) : [];
	const loginsFailed = reachable.filter(m => connections[m.id] === null);
	const usageMissing = loginsLoaded.filter(m => statsFailure(m) !== null);
	const usagePending = loginsLoaded.filter(m => statsFailure(m) === null && !statsAnswered(m));
	// Subscriptions are what the loaded login lists hold; an account seen only in past usage is not one, even though
	// its row stays in the table (marked removed or not added) so its history is still visible.
	const subscriptionCount = rows.filter(row => loginsLoaded.some(m => row.connectionsByMachine.has(m.id))).length;
	const names = (list: Machine[]) => list.map(m => m.name).join(" and ");
	const singleMachine = !grouped && fleet ? (visibleMachines[0] ?? null) : null;
	const pickReconnect = (row: Row, ids: string[]) => {
		setFlow({
			kind: "reconnect",
			provider: family(row.provider),
			providerLabel: providerName(family(row.provider)),
			identity: row.email ?? row.identity,
			machines: ids,
		});
	};
	const pickRemove = (row: Row, machine: Machine) => {
		const item = connectionFor(row, connections[machine.id]);
		if (item && !item.account.managed && !oldHub(item.account)) {
			setRemoveError("");
			setRemoval({ row, machine, account: item.account });
		}
	};
	// Under All machines: loading while any machine may still answer (a held machine counts as reconnecting, not
	// failed), and the shared "no machine's stats answered" error only once every machine has definitively failed.
	const query = all ? fleetQueryView(single, multi) : { ...single, checking: false };
	/**
	 * Try again: under All machines the fleet refreshes its machine list first (5 s at most) and asks again; only
	 * then are the shown machines' login lists asked again, so a machine that came back is asked too.
	 */
	const retry = () => {
		retryRun.current?.abort();
		const controller = new AbortController();
		retryRun.current = controller;
		const shownIds = hubPresent ? visibleMachines.map(m => m.id) : [];
		setCheckingMachines(new Set(shownIds));
		const listRefreshed = all ? multi.refetch() : (single.refetch(), Promise.resolve());
		void listRefreshed.then(() => {
			if (controller.signal.aborted) return;
			// Only machines still in the refreshed fleet and reachable are asked; one dropped from the fleet is neither
			// asked nor waited on. Without a fleet (local access) the one shown machine is this hub itself.
			const fresh = getFleet();
			const ids = fresh ? shownIds.filter(id => fresh.some(m => m.id === id && m.ok)) : shownIds;
			setCheckingMachines(new Set(ids));
			for (const id of ids)
				void loadConnections(id, controller.signal).finally(() => {
					if (controller.signal.aborted) return;
					setCheckingMachines(previous => {
						const next = new Set(previous);
						next.delete(id);
						return next;
					});
				});
		});
	};
	const hours = Array.from({ length: 24 }, () => 0);
	for (const point of traffic?.points ?? []) hours[new Date(point.timestamp).getHours()] += point.requests;
	const peak = Math.max(...hours);
	const peakHour = hours.indexOf(peak);
	return (
		<div className="page accounts-simple">
			<div className="accounts-title">
				<div>
					<PageHeader title="Accounts & quota" />
					<p className="muted">
						{loadingText(loginsLoaded.length === 0 && loginsPending.length > 0, () => (
							<>
								{loginsLoaded.length === 0
									? "— subscriptions"
									: `${subscriptionCount} ${subscriptionCount === 1 ? "subscription" : "subscriptions"}`}
								{loginsLoaded.length > 0 && loginsLoaded.length < visibleMachines.length
									? ` from ${loginsLoaded.length} of ${visibleMachines.length} machines`
									: ` · ${visibleMachines.length} ${visibleMachines.length === 1 ? "machine" : "machines"}`}
								{loginsPending.length > 0 && (
									<span className="muted"> · {loginsPending.length} still loading</span>
								)}
								{loginsFailed.length > 0 && (
									<span
										className="accounts-unreachable"
										title={loginsFailed.map(m => `${m.name}: ${connectionErrors[m.id] ?? ""}`).join("\n")}
									>
										{" "}
										· accounts didn&apos;t load on {names(loginsFailed)}
									</span>
								)}
								{unreachableCount > 0 && (
									<span className="accounts-unreachable"> · {unreachableCount} unreachable</span>
								)}
								{usageMissing.length > 0 && (
									<span
										className="accounts-unreachable"
										title={usageMissing.map(m => `${m.name}: ${statsFailure(m)}`).join("\n")}
									>
										{" "}
										· usage numbers missing from {names(usageMissing)}
										{usageMissing.length === 1 &&
											` (${plainStatsReason(statsFailure(usageMissing[0]), { refreshing: false })})`}
									</span>
								)}
								{usagePending.length > 0 && (
									<span className="muted"> · usage numbers still loading from {names(usagePending)}</span>
								)}
								{attention > 0 && <span className="accounts-attention"> · {attention} need attention</span>}
							</>
						))}
					</p>
				</div>
				{hubPresent && (
					<button className="btn" data-variant="primary" onClick={() => setFlow({ kind: "add" })}>
						Add account
					</button>
				)}
			</div>
			<Table
				variant="std"
				title="Accounts"
				subtitle="Accounts by machine · select a row for quota and actions"
				rows={tableRows}
				rowKey={item => item.row.key}
				loading={tableRows.length === 0 && (connectionsLoading || query.loading)}
				// A full-table error only when the login lists themselves failed: usage numbers that didn't load leave
				// the accounts listed (their usage shown as "—") and are explained in the subtitle and the summary.
				error={
					hubPresent && reachable.length > 0 && loginsLoaded.length === 0 && loginsPending.length === 0 ? (
						reachable.length === 1 ? (
							<span title={connectionErrors[reachable[0].id]}>
								Could not load the accounts. {reachable[0].name}&apos;s accounts didn&apos;t load:{" "}
								{plainHubReason(connectionErrors[reachable[0].id], { refreshing: false })}.
							</span>
						) : (
							<span className="accounts-all-failed">
								<span>No machine&apos;s accounts loaded.</span>
								<span className="error-state-reasons">
									{reachable.map(m => (
										<span key={m.id} title={connectionErrors[m.id]}>
											{m.name}: {plainHubReason(connectionErrors[m.id], { refreshing: false })}.
										</span>
									))}
								</span>
							</span>
						)
					) : undefined
				}
				onRetry={retry}
				retryBusy={query.checking || checkingMachines.size > 0}
				group={
					grouped
						? item => ({
								key: item.machine.id,
								label: (
									<MachineGroupLabel
										machine={opsMachine(item.machine)}
										count={plural(tableRows.filter(i => i.machine.id === item.machine.id).length, "account")}
										hint={noAnswer(item.machine)}
									/>
								),
							})
						: undefined
				}
				stale={item =>
					!item.machine.ok || item.machine.stale === true || connectionErrors[item.machine.id] !== undefined
				}
				summary={
					(singleMachine && machineStatus(opsMachine(singleMachine))) || usageMissing.length > 0 ? (
						<>
							{singleMachine && <MachineAvailability machine={opsMachine(singleMachine)} />}
							{usageMissing.length > 0 && (
								<RetryNote
									text={`Usage numbers missing from ${names(usageMissing)}; their usage shows as —`}
									detail={usageMissing.map(m => `${m.name}: ${statsFailure(m)}`).join("\n")}
									onRetry={retry}
									busy={query.checking || checkingMachines.size > 0}
								/>
							)}
						</>
					) : undefined
				}
				emptyGroups={
					grouped
						? visibleMachines
								.filter(m => !tableRows.some(i => i.machine.id === m.id))
								.map(m => ({
									key: m.id,
									label: <MachineGroupLabel machine={opsMachine(m)} />,
									note: !m.ok ? unavailable(m) : (noAnswer(m) ?? "No accounts on this machine."),
								}))
						: undefined
				}
				onRowClick={item =>
					setExpanded(previous => {
						const next = new Set(previous);
						if (next.has(item.row.key)) next.delete(item.row.key);
						else next.add(item.row.key);
						return next;
					})
				}
				columns={[
					{
						key: "account",
						header: "Account",
						render: ({ row }) => <LabelCell primary={title(row)} secondary={row.identity} />,
						sort: ({ row, machine }) => `${machine.id}/${title(row)}`,
					},
					{
						key: "status",
						header: "Status",
						width: 290,
						sort: ({ row, machine }) => `${machine.id}/${stateOf(row, machine).label}`,
						render: ({ row, machine }) => {
							const s = stateOf(row, machine);
							return (
								<span className="accounts-status">
									<StatusCell tone={s.tone}>{s.label}</StatusCell>
									<span className="accounts-status-reason" title={s.reason}>
										{s.reason}
									</span>
								</span>
							);
						},
					},
					{
						key: "requests",
						header: "Requests",
						width: 110,
						align: "right",
						kind: "number",
						sort: ({ row, machine }) => `${machine.id}/${String(row.account?.requests ?? 0).padStart(16, "0")}`,
						// No numbers from this machine's stats server: shown as missing, never as a real 0.
						render: ({ row, machine }) =>
							statsAnswered(machine) ? (
								formatInteger(row.account?.requests ?? 0)
							) : (
								<span
									className="ops-dim"
									title={
										statsFailure(machine)
											? `Usage numbers missing: ${statsFailure(machine)}`
											: "Usage numbers still loading"
									}
								>
									—
								</span>
							),
					},
				]}
				empty={
					singleMachine && !singleMachine.ok ? unavailable(singleMachine) : "No accounts on the selected machines."
				}
				expanded={({ row, machine }) => {
					if (!expanded.has(row.key)) return null;
					const problems = [machine].filter(m => stateOf(row, m).state === "problem");
					const current = connectionFor(row, connections[machine.id]);
					return (
						<article className="subscription" data-attention={problems.length > 0}>
							<header>
								<div>
									<strong>{title(row)}</strong>
									<div className="muted">{row.identity}</div>
								</div>
								{row.account?.servedLatestNewSession && (
									<span className="subscription-badge">Serving new sessions</span>
								)}
							</header>
							<div className="subscription-dots">
								{statusMachines.map(m => {
									const state = stateOf(row, m);
									const text = `${state.label}: ${state.reason}`;
									return (
										<span
											className="subscription-machine"
											title={state.detail ? `${text}\n${state.detail}` : text}
											key={m.id}
										>
											<i data-state={state.state} aria-hidden="true" />
											{m.name}
											<span className="sr-only">: {text}</span>
										</span>
									);
								})}
							</div>
							{problems.map(m => {
								const state = stateOf(row, m);
								return (
									<div className="accounts-problem" key={m.id}>
										<p className="accounts-attention">
											{hubPresent
												? `Needs login on ${m.name}: ${state.reason.replace(/ · Reconnect$/, "")}. Use Reconnect to sign in again.`
												: `Needs login on ${m.name}. ${state.reason}.`}
										</p>
										{state.detail && (
											<details className="accounts-error">
												<summary>Error from the provider</summary>
												<pre>{state.detail}</pre>
											</details>
										)}
									</div>
								);
							})}
							{row.account?.quotas.length ? (
								<div className="subscription-quotas">
									{row.account.quotas.map(q => {
										const pct = q.usedFraction === null ? null : Math.round(q.usedFraction * 100);
										return (
											<div key={q.limitId} title={`Updated ${formatRelativeTime(q.recordedAt)}`}>
												<div className="subscription-quota-label">
													<span>{q.label}</span>
													<strong
														data-level={
															pct !== null && pct >= 90
																? "bad"
																: pct !== null && pct >= 70
																	? "warn"
																	: "normal"
														}
													>
														{pct === null
															? "Unknown"
															: `${pct}%${pct >= 90 ? " · nearly full" : pct >= 70 ? " · high" : ""}`}
													</strong>
												</div>
												<div className="subscription-track">
													<div
														data-level={
															pct !== null && pct >= 90
																? "bad"
																: pct !== null && pct >= 70
																	? "warn"
																	: "normal"
														}
														style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
													/>
												</div>
												<small>
													{q.resetsAt ? `Resets ${formatRelativeTime(q.resetsAt)}` : "Reset unknown"}
												</small>
											</div>
										);
									})}
								</div>
							) : (
								<div className="subscription-noquota">No quota data from this provider</div>
							)}
							<div>
								<strong>
									{range === "24h" ? "Today" : rangeMeta(range).windowLabel}:{" "}
									{!statsAnswered(machine)
										? statsFailure(machine)
											? "usage numbers missing"
											: "usage numbers still loading"
										: row.account?.requests
											? `${formatInteger(row.account.requests)} requests`
											: "no requests"}
								</strong>
								{!!row.account?.requests && (
									<div className="muted">
										about {formatEstimatedCost(row.account.totalCost, row.account.unpricedRequests)} at API
										prices
									</div>
								)}
							</div>
							{hubPresent && (
								<footer>
									<button
										className="btn"
										disabled={!machine.ok || (!!current && oldHub(current.account))}
										title={current && oldHub(current.account) ? "update this machine's hub" : undefined}
										onClick={() => pickReconnect(row, [machine.id])}
									>
										Reconnect
									</button>
									<button
										className="btn"
										aria-label={`More options for ${title(row)}`}
										aria-expanded={menu === row.key}
										onClick={() => setMenu(menu === row.key ? null : row.key)}
									>
										⋯
									</button>
									{menu === row.key && (
										<button
											className="btn"
											disabled={
												!machine.ok || !current || current.account.managed || oldHub(current.account)
											}
											title={
												current
													? oldHub(current.account)
														? "update this machine's hub"
														: current.account.managed
															? "Remove from a terminal"
															: undefined
													: undefined
											}
											onClick={() => {
												setMenu(null);
												pickRemove(row, machine);
											}}
										>
											Remove from a machine…
										</button>
									)}
									{current?.account.managed && (
										<small>Kept by the multi-auth plugin; add a regular login from Reconnect.</small>
									)}
									{current && oldHub(current.account) && <small>update this machine's hub</small>}
								</footer>
							)}
						</article>
					);
				}}
			/>
			<details className="accounts-details">
				<summary>Details</summary>
				<section>
					<h3>Traffic, last 24 hours</h3>
					{traffic && (
						<AccountFlowChart
							flow={traffic}
							range="24h"
							metric="requests"
							palette={palette}
							height={180}
							hidden={hiddenSeries}
							onToggle={toggleSeries}
						/>
					)}
					<h3>Peak hours</h3>
					<div className="accounts-hours">
						{hours.map((count, hour) => (
							<div
								key={hour}
								title={`${String(hour).padStart(2, "0")}:00 · ${formatInteger(count)} requests`}
								style={{
									height: `${peak ? Math.max(4, (count / peak) * 100) : 4}%`,
									opacity: peak && count >= peak * 0.7 ? 1 : 0.45,
								}}
							/>
						))}
					</div>
					<p>
						{peak ? `Busiest hour: ${String(peakHour).padStart(2, "0")}:00` : "No requests in the last 24 hours."}
					</p>
					<h3>Requests not tied to an account</h3>
					<p>
						{stats?.unattributed
							.map(u => `${providerName(u.provider)} ${formatInteger(u.requests)}`)
							.join(" · ") || "None"}
						. These include background calls such as session titles and memory.
					</p>
					<h3>When logins expire</h3>
					{rows.flatMap(row =>
						visibleMachines.map(machine => {
							const item = connectionFor(row, connections[machine.id]);
							return (
								<p key={`${row.key}-${machine.id}`}>
									{title(row)} on {machine.name}:{" "}
									{item?.account.managed
										? "Kept by the multi-auth plugin; add a regular login from Reconnect."
										: item?.account.type === "api_key"
											? "API key, doesn't expire"
											: item?.account.expiresAt
												? `expires ${formatRelativeTime(item.account.expiresAt)}`
												: item
													? "stays signed in"
													: "not added here"}
								</p>
							);
						}),
					)}
					<h3>Usage windows, last 24 hours</h3>
					<p>Peak is the highest observed usage; resets, used and ran out are counted from recorded readings.</p>
					{rows
						.filter(row => row.account?.quotas.length)
						.map(row => (
							<WindowHistory key={row.key} row={row} all={all} />
						))}
				</section>
			</details>
			{flow && (
				<AccountFlow
					mode={flow}
					machines={machines}
					defaultMachine={all ? undefined : selected}
					fleet={!!fleet}
					existing={existing}
					onClose={() => setFlow(null)}
					onChanged={changed}
				/>
			)}
			{removal && (
				<Modal
					open
					title={`Remove ${title(removal.row)} from ${removal.machine.name}?`}
					onClose={() => !removing && setRemoval(null)}
					primaryAction={{
						label: removing ? "Removing…" : "Remove",
						disabled: removing || typeof removal.account.credentialId !== "number",
						onClick: () => {
							setRemoving(true);
							setRemoveError("");
							removeCredential(
								removal.machine.id || undefined,
								removal.account.credentialId as number,
								removal.account.identity,
							)
								.then(() => {
									setRemoval(null);
									changed();
								})
								.catch(error => setRemoveError(error instanceof Error ? error.message : String(error)))
								.finally(() => setRemoving(false));
						},
					}}
				>
					<p>Sessions on {removal.machine.name} will stop using it.</p>
					{removeError && <p role="alert">{removeError}</p>}
				</Modal>
			)}
		</div>
	);
}
