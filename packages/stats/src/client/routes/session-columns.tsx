import { formatCompact, formatElapsed, formatEstimatedCost, formatInteger } from "../data/formatters";
import { sessionFolder } from "../data/session-rows";
import type { SessionSummary } from "../types";
import { type Column, MeterCell } from "../ui";

function ModelList({ models }: { models: string[] }) {
	if (models.length === 0) return <span className="dim">-</span>;
	return (
		<span className="traces-models" title={models.join("\n")}>
			<span className="mono truncate">{models[0]}</span>
			{models.length > 1 && <span className="badge">+{models.length - 1}</span>}
		</span>
	);
}

export function sessionColumns(
	maxCost: number,
): Record<
	"folder" | "models" | "duration" | "requests" | "tools" | "agents" | "tokens" | "cost",
	Column<SessionSummary>
> {
	return {
		folder: { key: "folder", header: "Folder", render: row => sessionFolder(row.folder, "home") },
		models: { key: "models", header: "Models", render: row => <ModelList models={row.models} /> },
		duration: {
			key: "duration",
			header: "Duration",
			align: "right",
			render: row => <span className="num">{formatElapsed(row.endedAt - row.startedAt)}</span>,
			sort: row => row.endedAt - row.startedAt,
		},
		requests: {
			key: "requests",
			header: "Requests",
			align: "right",
			render: row => <span className="num">{formatInteger(row.requests)}</span>,
			sort: row => row.requests,
		},
		tools: {
			key: "toolCalls",
			header: "Tools",
			align: "right",
			render: row => <span className="num">{formatInteger(row.toolCalls)}</span>,
			sort: row => row.toolCalls,
		},
		agents: {
			key: "subagents",
			header: "Agents",
			align: "right",
			render: row =>
				row.subagents > 0 ? (
					<span className="num">{formatInteger(row.subagents)}</span>
				) : (
					<span className="num dim">0</span>
				),
			sort: row => row.subagents,
		},
		tokens: {
			key: "tokens",
			header: "Tokens",
			align: "right",
			render: row => <span className="num">{formatCompact(row.totalTokens)}</span>,
			sort: row => row.totalTokens,
		},
		cost: {
			key: "cost",
			header: "Cost",
			align: "right",
			width: 150,
			render: row => (
				<MeterCell
					value={row.costTotal}
					max={maxCost}
					display={formatEstimatedCost(row.costTotal, row.unpricedRequests)}
				/>
			),
			sort: row => row.costTotal,
		},
	};
}
