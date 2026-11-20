import { useEffect, useMemo, useState } from "react";
import { Card, Table, type Column } from "../../ui";
import { sortTickets, ticketCsv, type Issue } from "./smsModel";
const COLUMNS = [
	["key", "ID"],
	["title", "Title"],
	["type", "Level"],
	["eff_status", "Status"],
	["project", "Repo"],
	["release", "Release"],
	["milestone", "Milestone"],
	["priority", "Priority"],
	["assignees", "Assignee"],
	["updated_at", "Updated"],
];
export function TicketsView({ items }: { items: Issue[] }) {
	const [sort, setSort] = useState<[string, number]>(["updated_at", -1]);
	const [page, setPage] = useState(0);
	useEffect(() => setPage(0), [items]);
	const sorted = useMemo(() => sortTickets(items, sort[0], sort[1]), [items, sort]);
	const pages = Math.max(1, Math.ceil(sorted.length / 100));
	const current = Math.min(page, pages - 1);
	const columns: Column<Issue>[] = COLUMNS.map(([key, name]) => ({
		key,
		header: (
			<button
				className="btn"
				onClick={() => {
					setSort([key, sort[0] === key ? -sort[1] : 1]);
					setPage(0);
				}}
			>
				{name}
				{sort[0] === key ? (sort[1] > 0 ? " ▲" : " ▼") : ""}
			</button>
		),
		render: i =>
			key === "key" ? (
				<a href={i.url} target="_blank" rel="noopener noreferrer">
					{i.key || i.ref}
				</a>
			) : (
				String(Array.isArray(i[key]) ? (i[key] as string[]).join(", ") : (i[key] ?? ""))
			),
	}));
	const download = () => {
		const url = URL.createObjectURL(new Blob([ticketCsv(sorted)], { type: "text/csv" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `sms-tickets-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	};
	return (
		<Card
			title="All tickets"
			description={`${items.length} tickets`}
			actions={
				<button className="btn" onClick={download}>
					Download CSV
				</button>
			}
		>
			<Table
				columns={columns}
				rows={sorted.slice(current * 100, (current + 1) * 100)}
				rowKey={i => i.ref}
				limit={100}
			/>
			<div className="sms-pager">
				<button className="btn" disabled={current === 0} onClick={() => setPage(current - 1)}>
					‹ Prev
				</button>{" "}
				Page {current + 1} of {pages}{" "}
				<button className="btn" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
					Next ›
				</button>
			</div>
		</Card>
	);
}
