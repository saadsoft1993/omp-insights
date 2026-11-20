import { useEffect, useMemo, useState } from "react";
import { Card } from "../../ui";
import {
	LEVELS,
	SELECTS,
	defaultFilters,
	filterOptions,
	matches,
	type Filters,
	type Issue,
	type MergeRequest,
	type MilestoneInfo,
} from "./smsModel";
const label = (s: string) =>
	s
		.replaceAll("-", " ")
		.replaceAll("_", " ")
		.replace(/\b\w/g, c => c.toUpperCase());
export function FiltersBar({
	all,
	mrs,
	milestones,
	filters,
	onChange,
	mr,
}: {
	all: Issue[];
	mrs: MergeRequest[];
	milestones: MilestoneInfo[];
	filters: Filters;
	onChange: (f: Filters) => void;
	mr: boolean;
}) {
	const [search, setSearch] = useState(filters.q);
	useEffect(() => {
		setSearch(filters.q);
	}, [filters.q]);
	useEffect(() => {
		if (search.trim() === filters.q) return;
		const timer = setTimeout(() => onChange({ ...filters, q: search.trim() }), 200);
		return () => clearTimeout(timer);
	}, [search, filters, onChange]);
	const levels = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const issue of all)
			if (matches(issue, filters, "levels")) counts[issue.type] = (counts[issue.type] || 0) + 1;
		return counts;
	}, [all, filters]);
	const options = useMemo(
		() =>
			Object.fromEntries(
				(mr ? ["project" as const] : SELECTS).map(field => [
					field,
					filterOptions(all, mrs, filters, field, milestones, mr),
				]),
			),
		[all, mrs, filters, milestones, mr],
	);
	const change = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
	return (
		<Card title="Filters">
			<div className="sms-filter">
				{mr ? (
					<span>Merge requests: only the repo and search filters apply here.</span>
				) : (
					<div>
						{LEVELS.map(level => (
							<button
								type="button"
								className="btn"
								key={level}
								aria-pressed={filters.levels.has(level)}
								onClick={e => {
									const selected = e.altKey || e.metaKey ? new Set([level]) : new Set(filters.levels);
									if (!e.altKey && !e.metaKey) {
										if (selected.has(level)) selected.delete(level);
										else selected.add(level);
									}
									change({ levels: selected });
								}}
							>
								{label(level)} ({levels[level] || 0})
							</button>
						))}
					</div>
				)}
				<label>
					Search <input className="input" value={search} onChange={e => setSearch(e.target.value)} />
				</label>
				{(mr ? ["project" as const] : SELECTS).map(field => (
					<label key={field}>
						{label(field)}{" "}
						<select value={filters[field]} onChange={e => change({ [field]: e.target.value })}>
							<option value="">All</option>
							{options[field].map(o => (
								<option key={o.value} value={o.value}>
									{label(o.value)} ({o.count})
								</option>
							))}
						</select>
					</label>
				))}
				{!mr && (
					<>
						<label>
							<input
								type="checkbox"
								checked={filters.blocked}
								onChange={e => change({ blocked: e.target.checked })}
							/>{" "}
							Blocked
						</label>
						<label>
							<input
								type="checkbox"
								checked={filters.founder}
								onChange={e => change({ founder: e.target.checked })}
							/>{" "}
							Founder approval
						</label>
					</>
				)}
				<button
					className="btn"
					onClick={() => {
						setSearch("");
						onChange(defaultFilters());
					}}
				>
					Reset
				</button>
			</div>
		</Card>
	);
}
