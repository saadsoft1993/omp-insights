import { ALL_MACHINES, concreteMachine, useSelectedMachine } from "../app/machine";
import { MissingMachineNumbers } from "../app/MachineBanner";
import { fleetQueryView, useFleetQuery } from "../data/fleet-query";
import { mergeTraces } from "../data/fleet-merge";
/**
 * Traces section: root-session list (subagents folded in) that opens the
 * flamegraph trace viewer for a selected session.
 */

import { useMemo, useState } from "react";
import { getSessions } from "../api";
import { formatInteger, formatRelativeTime } from "../data/formatters";
import { sessionFolder, sessionRowKey } from "../data/session-rows";
import { sessionColumns } from "./session-columns";
import { useQuery } from "../data/query";
import { TraceView } from "../traces/TraceView";
import type { SessionSummary } from "../types";
import {
	Card,
	type Column,
	EmptyState,
	LabelCell,
	PageHeader,
	QueryView,
	SearchInput,
	Table,
	TableSkeleton,
} from "../ui";
import "../traces/traces.css";

export interface TracesRouteProps {
	active: boolean;
	session: string | null;
	sessionMachine?: string | null;
	onOpenSession: (file: string | null, machine?: string) => void;
}

const SESSION_LIMIT = 200;

export function TracesRoute({ active, session, sessionMachine, onOpenSession }: TracesRouteProps) {
	const [filter, setFilter] = useState("");
	const all = useSelectedMachine() === ALL_MACHINES;
	const single = useQuery(
		["sessions", SESSION_LIMIT],
		({ signal }) => getSessions(SESSION_LIMIT, undefined, signal, concreteMachine()),
		{ enabled: active && session === null && !all, pollMs: 30000 },
	);
	const fleet = useFleetQuery(
		["sessions", SESSION_LIMIT],
		async (machine, signal) => ({ machine, data: await getSessions(SESSION_LIMIT, undefined, signal, machine) }),
		answers => mergeTraces(answers, SESSION_LIMIT),
		{ enabled: active && session === null && all },
	);
	const sessions = all ? fleetQueryView(single, fleet) : single;

	const filtered = useMemo(() => {
		const rows = sessions.data ?? [];
		const needle = filter.trim().toLowerCase();
		if (!needle) return rows;
		return rows.filter(
			row =>
				(row.title ?? "").toLowerCase().includes(needle) ||
				row.folder.toLowerCase().includes(needle) ||
				row.models.some(model => model.toLowerCase().includes(needle)),
		);
	}, [sessions.data, filter]);

	const maxCost = useMemo(() => Math.max(0, ...filtered.map(row => row.costTotal)), [filtered]);

	const columns = useMemo<Column<SessionSummary>[]>(() => {
		const shared = sessionColumns(maxCost);
		return [
			{
				key: "title",
				header: "Session",
				width: "32%",
				render: row => (
					<LabelCell
						primary={row.title ?? row.file.split("/").pop()}
						secondary={
							<span className="mono">
								{[(row as SessionSummary & { machine?: string }).machine, sessionFolder(row.folder, "short")]
									.filter(Boolean)
									.join(" · ")}
							</span>
						}
					/>
				),
				sort: row => (row.title ?? row.file).toLowerCase(),
			},
			shared.models,
			{
				key: "started",
				header: "Started",
				align: "right",
				render: row => (
					<span className="muted" title={new Date(row.startedAt).toLocaleString()}>
						{formatRelativeTime(row.startedAt)}
					</span>
				),
				sort: row => row.startedAt,
			},
			shared.duration,
			shared.requests,
			shared.tools,
			shared.agents,
			shared.tokens,
			shared.cost,
		];
	}, [maxCost]);

	if (session !== null) {
		return (
			<TraceView
				file={session}
				machine={sessionMachine ?? undefined}
				active={active}
				onBack={() => onOpenSession(null)}
			/>
		);
	}

	const total = sessions.data?.length ?? 0;
	return (
		<div className="stack">
			<PageHeader
				title="Traces"
				description="Recent sessions with subagent activity folded in. Open one to inspect its timeline."
			/>
			{all && <MissingMachineNumbers machines={fleet.machines} />}
			<Card
				title="Sessions"
				description={
					sessions.data
						? filter.trim()
							? `${formatInteger(filtered.length)} of ${formatInteger(total)} most recent`
							: `${formatInteger(total)} most recent`
						: undefined
				}
				actions={
					<SearchInput
						value={filter}
						onChange={setFilter}
						placeholder="Filter by title, project, model…"
						width={260}
					/>
				}
				flush
				index={0}
				stale={sessions.stale}
			>
				<QueryView
					query={sessions}
					skeleton={<TableSkeleton rows={10} />}
					isEmpty={rows => rows.length === 0}
					empty={<EmptyState title="No sessions found" hint="Run a sync to index recent activity." />}
				>
					{() => (
						<Table
							columns={columns}
							rows={filtered}
							rowKey={sessionRowKey}
							onRowClick={row => onOpenSession(row.file, (row as SessionSummary & { machine?: string }).machine)}
							initialSort={{ key: "started", dir: "desc" }}
							limit={50}
							empty={<EmptyState title="No matching sessions" hint="Try a different filter." />}
						/>
					)}
				</QueryView>
			</Card>
		</div>
	);
}
