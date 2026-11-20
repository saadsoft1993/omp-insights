import { ArrowDown, ArrowUp } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatInteger } from "../data/formatters";
import { EmptyState } from "./States";
import "./table-std.css";

export interface Column<T> {
	key: string;
	header: ReactNode;
	render: (row: T) => ReactNode;
	/** Sort key; the column header becomes clickable when present. */
	sort?: (row: T) => number | string | null | undefined;
	align?: "left" | "right" | "center";
	width?: number | string;
	/** Allow the cell to wrap (cells are single-line by default). */
	wrap?: boolean;
	/** Header tooltip. */
	title?: string;
	/** Smaller priorities remain visible at narrow widths. */
	priority?: 1 | 2 | 3;
	kind?:
		| "text"
		| "machine"
		| "number"
		| "money"
		| "percent"
		| "duration"
		| "date"
		| "status"
		| "bar"
		| "sparkline"
		| "tags"
		| "model"
		| "actions";
}

export type SortDir = "asc" | "desc";

export interface TableProps<T> {
	columns: readonly Column<T>[];
	variant?: "std";
	rows: readonly T[];
	rowKey: (row: T) => string | number;
	onRowClick?: (row: T) => void;
	/** Standard table chevron action, independent of clicking the row. */
	onToggle?: (row: T) => void;
	selectedKey?: string | number | null;
	/** Initial sort; numeric columns usually start `desc`. */
	initialSort?: { key: string; dir: SortDir };
	/** Show the first `limit` rows; "Show more" reveals `limit` × 4 more at a time (rendering stays cheap for huge tables). */
	limit?: number;
	dense?: boolean;
	empty?: ReactNode;
	/** Detail row rendered below a row (return `null` for collapsed rows). */
	expanded?: (row: T) => ReactNode | null;
	pinned?: (row: T) => boolean;
	loading?: boolean;
	error?: ReactNode;
	onRetry?: () => void;
	/** A retry is in progress: the Try again button reads "Checking…" and waits. */
	retryBusy?: boolean;
	selectedKeys?: ReadonlySet<string | number>;
	onSelectionChange?: (keys: Set<string | number>) => void;
	bulkActions?: ReactNode;
	title?: ReactNode;
	subtitle?: ReactNode;
	tools?: ReactNode;
	summary?: ReactNode;
	group?: (row: T) => { key: string; label: ReactNode; action?: ReactNode };
	stale?: (row: T) => boolean;
	/** Controlled single choice for duplicate groups. */
	radioKey?: string | number | null | ((row: T) => boolean);
	onRadioChange?: (row: T) => void;
	radioLabel?: (row: T) => string;
	emptyAction?: ReactNode;
	/** Group headings with no rows, drawn after the data rows with a muted note ("no live sessions"). */
	emptyGroups?: readonly { key: string; label: ReactNode; note: ReactNode }[];
}

/** Sortable data table. Clicking a sorted header flips its direction. */
export function Table<T>(props: TableProps<T>) {
	return props.variant === "std" ? <StandardTable {...props} /> : <LegacyTable {...props} />;
}

function LegacyTable<T>({
	columns,
	rows,
	rowKey,
	onRowClick,
	selectedKey,
	initialSort,
	limit,
	dense,
	empty,
	expanded,
}: TableProps<T>) {
	const [sort, setSort] = useState(initialSort ?? null);
	const [shown, setShown] = useState(limit ?? Number.POSITIVE_INFINITY);

	const sorted = useMemo(() => {
		const column = sort ? columns.find(c => c.key === sort.key) : undefined;
		if (!sort || !column?.sort) return rows;
		const valueOf = column.sort;
		const dir = sort.dir === "asc" ? 1 : -1;
		return [...rows].sort((a, b) => {
			const va = valueOf(a);
			const vb = valueOf(b);
			if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
			return String(va).localeCompare(String(vb)) * dir;
		});
	}, [rows, columns, sort]);

	if (rows.length === 0) return <>{empty ?? <EmptyState />}</>;

	const visible = sorted.length > shown ? sorted.slice(0, shown) : sorted;

	const toggleSort = (column: Column<T>) => {
		if (!column.sort) return;
		setSort(prev =>
			prev?.key === column.key
				? { key: column.key, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { key: column.key, dir: column.align === "right" ? "desc" : "asc" },
		);
	};

	return (
		<>
			<div className="table-wrap">
				<table className="table" data-dense={dense ?? false}>
					<thead>
						<tr>
							{columns.map(column => {
								const sorted = sort?.key === column.key ? sort.dir : undefined;
								return (
									<th
										key={column.key}
										data-align={column.align ?? "left"}
										data-sortable={column.sort !== undefined}
										data-sorted={sorted}
										style={column.width !== undefined ? { width: column.width } : undefined}
										title={column.title}
										onClick={() => toggleSort(column)}
										aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
									>
										{column.header}
										{sorted && (
											<span className="sort-arrow">
												{sorted === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
											</span>
										)}
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{visible.map(row => {
							const key = rowKey(row);
							const detail = expanded?.(row) ?? null;
							return (
								<Fragment key={key}>
									<tr
										data-clickable={onRowClick !== undefined}
										data-selected={selectedKey === key}
										onClick={onRowClick ? () => onRowClick(row) : undefined}
										onKeyDown={
											onRowClick
												? e => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															onRowClick(row);
														}
													}
												: undefined
										}
										tabIndex={onRowClick ? 0 : undefined}
									>
										{columns.map(column => (
											<td
												key={column.key}
												data-align={column.align ?? "left"}
												data-wrap={column.wrap ?? false}
											>
												{column.render(row)}
											</td>
										))}
									</tr>
									{detail !== null && (
										<tr>
											<td colSpan={columns.length} data-wrap="true" style={{ padding: 0 }}>
												{detail}
											</td>
										</tr>
									)}
								</Fragment>
							);
						})}
					</tbody>
				</table>
			</div>
			{limit !== undefined && sorted.length > limit && (
				<div className="table-more">
					<span className="micro">
						{formatInteger(visible.length)} of {formatInteger(sorted.length)}
					</span>
					{sorted.length > shown && (
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							onClick={() => setShown(n => n + limit * 4)}
						>
							Show more
						</button>
					)}
					{shown > limit && (
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							onClick={() => setShown(limit)}
						>
							Show fewer
						</button>
					)}
				</div>
			)}
		</>
	);
}

/** Right-aligned value with a proportional bar, for ranked numeric columns. */
export function MeterCell({
	value,
	max,
	display,
	color,
}: {
	value: number;
	max: number;
	display: ReactNode;
	color?: string;
}) {
	const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
	return (
		<div className="meter-cell">
			<span className="num">{display}</span>
			<div className="meter">
				<div className="meter-fill" style={{ width: `${pct}%`, background: color }} />
			</div>
		</div>
	);
}

/** Two-line cell: primary label and a dim secondary line. */
export function LabelCell({
	primary,
	secondary,
	lead,
}: {
	primary: ReactNode;
	secondary?: ReactNode;
	lead?: ReactNode;
}) {
	return (
		<div className="row" style={{ gap: 10 }}>
			{lead}
			<div className="stack" style={{ gap: 0 }}>
				<span className="cell-primary truncate">{primary}</span>
				{secondary !== undefined && <span className="cell-secondary truncate">{secondary}</span>}
			</div>
		</div>
	);
}

function StandardTable<T>({
	columns,
	rows,
	rowKey,
	onRowClick,
	onToggle,
	selectedKey,
	initialSort,
	limit = 15,
	dense,
	empty,
	expanded,
	pinned,
	loading,
	error,
	onRetry,
	retryBusy = false,
	selectedKeys,
	onSelectionChange,
	bulkActions,
	title,
	subtitle,
	tools,
	summary,
	group,
	stale,
	radioKey,
	onRadioChange,
	radioLabel,
	emptyAction,
	emptyGroups,
}: TableProps<T>) {
	const radioName = useId();
	const containerRef = useRef<HTMLElement>(null);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;
		const observer = new ResizeObserver(entries => {
			const width = entries[0]?.contentRect.width;
			if (width !== undefined) setContainerWidth(width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const [sort, setSort] = useState(initialSort ?? null);
	const [shown, setShown] = useState(limit);
	const sorted = useMemo(() => {
		const column = columns.find(item => item.key === sort?.key);
		const groupOrder = new Map<string, number>();
		if (group)
			for (const row of rows) {
				const key = group(row).key;
				if (!groupOrder.has(key)) groupOrder.set(key, groupOrder.size);
			}
		return [...rows].sort((a, b) => {
			if (group) {
				const order = (groupOrder.get(group(a).key) ?? 0) - (groupOrder.get(group(b).key) ?? 0);
				if (order) return order;
			}
			const pin = Number(!!pinned?.(b)) - Number(!!pinned?.(a));
			if (pin) return pin;
			if (!sort || !column?.sort) return 0;
			const left = column.sort(a),
				right = column.sort(b);
			const leftEmpty = left == null || left === "",
				rightEmpty = right == null || right === "";
			if (leftEmpty || rightEmpty) return Number(leftEmpty) - Number(rightEmpty);
			const comparison =
				typeof left === "number" && typeof right === "number"
					? left - right
					: String(left).localeCompare(String(right));
			return sort.dir === "asc" ? comparison : -comparison;
		});
	}, [rows, columns, sort, pinned, group]);
	const visible = sorted.slice(0, shown);
	const toggleSort = (column: Column<T>) => {
		if (!column.sort) return;
		setSort(current => ({
			key: column.key,
			dir: current?.key === column.key && current.dir === "desc" ? "asc" : "desc",
		}));
	};
	const selectRow = (key: string | number, checked: boolean) => {
		const next = new Set(selectedKeys);
		if (checked) next.add(key);
		else next.delete(key);
		onSelectionChange?.(next);
	};
	const selectable = selectedKeys !== undefined && onSelectionChange !== undefined;
	const visibleColumns = columns.filter(column =>
		containerWidth === null
			? true
			: !(column.priority === 3 && containerWidth <= 1080) && !(column.priority === 2 && containerWidth <= 860),
	).length;
	const computedSpan = Math.max(
		1,
		visibleColumns + Number(selectable) + Number(!!onRadioChange) + Number(!!expanded && !!(onToggle ?? onRowClick)),
	);
	// Group and detail rows span what the browser actually shows: CSS container queries hide priority columns
	// at slightly different widths than the observer reports, which left group rows short of the table edge.
	const [renderedSpan, setRenderedSpan] = useState<number | null>(null);
	useLayoutEffect(() => {
		const cells = containerRef.current?.querySelectorAll(":scope > table > thead > tr > th");
		if (!cells?.length || typeof getComputedStyle !== "function") return;
		const shown = Array.from(cells).filter(cell => getComputedStyle(cell).display !== "none").length;
		if (shown && shown !== renderedSpan) setRenderedSpan(shown);
	});
	const span = renderedSpan ?? computedSpan;
	return (
		<section ref={containerRef} className="table--std" data-dense={dense ?? false}>
			{(title || subtitle || tools || columns.some(column => column.sort)) && (
				<div className="std-head">
					<div>
						{title && <strong>{title}</strong>}
						{(subtitle || loading) && (
							<div className="std-subtitle">{loading && !error ? LOADING_TEXT : subtitle}</div>
						)}
					</div>
					<div className="std-tools">
						{tools}
						<label className="std-mobile-sort">
							<span>Sort</span>
							<select
								value={sort ? `${sort.key}:${sort.dir}` : ""}
								onChange={event => {
									if (!event.target.value) {
										setSort(null);
										return;
									}
									const [key, dir] = event.target.value.split(":");
									if (key && (dir === "asc" || dir === "desc")) setSort({ key, dir });
								}}
							>
								<option value="">Default</option>
								{columns
									.filter(column => column.sort)
									.flatMap(column => [
										<option key={`${column.key}:desc`} value={`${column.key}:desc`}>
											{column.header} ↓
										</option>,
										<option key={`${column.key}:asc`} value={`${column.key}:asc`}>
											{column.header} ↑
										</option>,
									])}
							</select>
						</label>
					</div>
				</div>
			)}
			{summary != null && <div className="std-summary">{loading && !error ? LOADING_TEXT : summary}</div>}
			{error ? (
				<div className="std-state" role="alert">
					{error}
					{onRetry && (
						<button type="button" disabled={retryBusy} onClick={() => onRetry()}>
							{retryBusy ? "Checking…" : "Try again"}
						</button>
					)}
				</div>
			) : loading ? (
				<div className="std-skeleton" role="status" aria-label="Loading">
					{Array.from({ length: 5 }, (_, row) => (
						<div key={row} className="std-skeleton-row">
							{columns.map(column => (
								<span key={column.key} data-priority={column.priority} />
							))}
						</div>
					))}
				</div>
			) : !rows.length && !emptyGroups?.length ? (
				<div className="std-state">
					{empty ?? <EmptyState />}
					{emptyAction}
				</div>
			) : (
				<table>
					<thead>
						<tr>
							{selectable && (
								<th className="std-control">
									<input
										type="checkbox"
										aria-label="Select all rows"
										checked={visible.length > 0 && visible.every(row => selectedKeys.has(rowKey(row)))}
										onChange={event => {
											const next = new Set(selectedKeys);
											for (const row of visible) {
												if (event.target.checked) next.add(rowKey(row));
												else next.delete(rowKey(row));
											}
											onSelectionChange(next);
										}}
									/>
								</th>
							)}
							{onRadioChange && <th className="std-control" aria-label="Choose row" />}
							{expanded && (onToggle || onRowClick) && <th className="std-control" aria-label="Expand row" />}
							{columns.map(column => (
								<th
									key={column.key}
									data-align={
										column.align ??
										(["number", "money", "percent", "duration", "bar", "actions"].includes(column.kind ?? "")
											? "right"
											: "left")
									}
									data-priority={column.priority}
									style={{ width: column.width }}
									aria-sort={
										sort?.key === column.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
									}
								>
									{column.sort ? (
										<button type="button" onClick={() => toggleSort(column)}>
											{column.header} {sort?.key === column.key && (sort.dir === "asc" ? "↑" : "↓")}
										</button>
									) : (
										column.header
									)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{visible.map((row, index) => {
							const key = rowKey(row),
								detail = expanded?.(row) ?? null;
							const heading = group?.(row),
								previous = index ? group?.(visible[index - 1]) : undefined;
							return (
								<Fragment key={key}>
									{heading != null && heading.key !== previous?.key && (
										<tr className="std-group">
											<th colSpan={span}>
												<span>{heading.label}</span>
												{heading.action}
											</th>
										</tr>
									)}
									<tr
										data-pinned={!!pinned?.(row)}
										data-stale={!!stale?.(row)}
										data-selected={selectedKey === key}
										tabIndex={onRowClick ? 0 : undefined}
										onClick={event => {
											if (
												onRowClick &&
												!(event.target as Element).closest("button, a, input, select, textarea")
											)
												onRowClick(row);
										}}
										onKeyDown={event => {
											if (
												onRowClick &&
												event.target === event.currentTarget &&
												(event.key === "Enter" || event.key === " ")
											) {
												event.preventDefault();
												onRowClick(row);
											}
										}}
									>
										{selectable && (
											<td className="std-control">
												<input
													type="checkbox"
													aria-label={`Select ${key}`}
													checked={selectedKeys.has(key)}
													onChange={event => selectRow(key, event.target.checked)}
												/>
											</td>
										)}
										{onRadioChange && (
											<td className="std-control">
												<input
													type="radio"
													name={`${radioName}-${heading?.key ?? "all"}`}
													aria-label={radioLabel?.(row) ?? `Choose ${key}`}
													checked={typeof radioKey === "function" ? radioKey(row) : radioKey === key}
													onChange={() => onRadioChange(row)}
												/>
											</td>
										)}
										{expanded && (onToggle || onRowClick) && (
											<td className="std-control">
												<button
													type="button"
													aria-label={`${detail == null ? "Expand" : "Collapse"} ${key}`}
													aria-expanded={detail != null}
													onClick={() => (onToggle ?? onRowClick)?.(row)}
												>
													{detail == null ? "▸" : "▾"}
												</button>
											</td>
										)}
										{columns.map(column => (
											<td
												key={column.key}
												data-align={
													column.align ??
													(["number", "money", "percent", "duration", "bar", "actions"].includes(
														column.kind ?? "",
													)
														? "right"
														: "left")
												}
												data-kind={column.kind}
												data-priority={column.priority}
												data-wrap={column.wrap}
											>
												{column.render(row)}
											</td>
										))}
									</tr>
									{detail != null && (
										<tr className="std-detail">
											<td colSpan={span}>{detail}</td>
										</tr>
									)}
								</Fragment>
							);
						})}
						{emptyGroups?.map(empty => (
							<Fragment key={`empty-group-${empty.key}`}>
								<tr className="std-group">
									<th colSpan={span}>
										<span>{empty.label}</span>
									</th>
								</tr>
								<tr className="std-group-empty">
									<td colSpan={span}>{empty.note}</td>
								</tr>
							</Fragment>
						))}
					</tbody>
				</table>
			)}
			{selectedKeys && selectedKeys.size > 0 && bulkActions && (
				<div className="std-bulk">
					{selectedKeys.size} selected {bulkActions}
				</div>
			)}
			{!loading && !error && sorted.length > limit && (
				<div className="std-paging">
					<span>
						Showing {formatInteger(visible.length)} of {formatInteger(sorted.length)}
					</span>
					{visible.length < sorted.length ? (
						<button type="button" onClick={() => setShown(n => n + limit)}>
							Show {limit} more
						</button>
					) : (
						<button type="button" onClick={() => setShown(limit)}>
							Show fewer
						</button>
					)}
				</div>
			)}
		</section>
	);
}

/** Shown in subtitles, counters and summaries until the first answer arrives: never a zero that reads as final. */
export const LOADING_TEXT = "Loading…";

/** `ready()` once loaded, "Loading…" before: `subtitle={loadingText(q.loading, () => `${n} jobs`)}`. */
export function loadingText<T>(loading: boolean, ready: () => T): T | typeof LOADING_TEXT {
	return loading ? LOADING_TEXT : ready();
}

/** "unreachable since 18 Nov at 14:05 PKT", or plain "unreachable" without a time. */
export function unreachableTitle(since?: number | string | Date | null): string {
	const date = since == null ? null : new Date(since);
	if (!date || !Number.isFinite(date.getTime())) return "unreachable";
	// Built from parts: the joining text of a formatted date differs between ICU builds (macOS vs Linux).
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Karachi",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";
	return `unreachable since ${part("day")} ${part("month")} at ${part("hour")}:${part("minute")} PKT`;
}

/**
 * Machine identity uses a square. An unreachable machine gets an amber dot after its name; the words live in the
 * tooltip and accessible name, so the cell never truncates them.
 */
export function MachineCell({
	name,
	color,
	reachable = true,
	lastKnown = false,
	since,
}: {
	name: string;
	color: string;
	reachable?: boolean;
	/** Reachable, but the hub is serving its last good answer (grace period): neither live nor unreachable. */
	lastKnown?: boolean;
	/** When the machine was last reachable / last answered (ms, ISO string or Date). */
	since?: number | string | Date | null;
}) {
	const status = !reachable ? unreachableTitle(since) : lastKnown ? lastKnownTitle(since) : null;
	return (
		<span className="std-machine" title={status ? `${name}: ${status}` : undefined}>
			<span className="std-machine-swatch" style={{ background: color }} aria-hidden="true" />
			<span className="std-machine-name">{name}</span>
			{status && (
				<span
					className="std-unreachable"
					data-state={reachable ? "last-known" : "unreachable"}
					role="img"
					aria-label={status}
				/>
			)}
		</span>
	);
}

/** "last known as of 18 Nov at 14:05 PKT; reconnecting", or without the time when unknown. */
export function lastKnownTitle(since?: number | string | Date | null): string {
	const at = unreachableTitle(since).replace(/^unreachable since /, "");
	return at === "unreachable" ? "last known; reconnecting" : `last known as of ${at}; reconnecting`;
}

/** Compact elapsed time, using whole minutes. */
export function formatCompactDuration(milliseconds: number): string {
	const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
	if (!minutes) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

export function RelativeDateCell({ value, now = Date.now() }: { value: number | string | Date; now?: number }) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return <>—</>;
	const delta = date.getTime() - now,
		absolute = Math.abs(delta);
	const text =
		absolute >= 7 * 86400_000
			? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Karachi" }).format(date)
			: new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
					Math.round(delta / (absolute >= 86400_000 ? 86400_000 : absolute >= 3600_000 ? 3600_000 : 60_000)),
					absolute >= 86400_000 ? "day" : absolute >= 3600_000 ? "hour" : "minute",
				);
	return (
		<time
			dateTime={date.toISOString()}
			title={`${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(date)} PKT`}
		>
			{text}
		</time>
	);
}

export function StatusCell({
	children,
	tone = "neutral",
	live = false,
}: {
	children: ReactNode;
	tone?: "neutral" | "ok" | "warn" | "error";
	live?: boolean;
}) {
	return (
		<span className="std-status" data-tone={tone}>
			<span className="std-status-dot" data-live={live} aria-hidden="true" />
			{children}
		</span>
	);
}

export function SparklineCell({
	values,
	color = "currentColor",
	label,
}: {
	values: readonly number[];
	color?: string;
	label: string;
}) {
	const max = Math.max(...values, 0),
		min = Math.min(...values, 0),
		span = max - min || 1;
	const points = values
		.map(
			(value, index) =>
				`${values.length > 1 ? (index * 96) / (values.length - 1) : 0},${20 - ((value - min) / span) * 18}`,
		)
		.join(" ");
	return (
		<svg className="std-sparkline" width="96" height="22" viewBox="0 0 96 22" role="img" aria-label={label}>
			<polygon points={`0,22 ${points} 96,22`} fill={color} opacity=".12" />
			<polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
		</svg>
	);
}

export function TagsCell({ tags }: { tags: readonly string[] }) {
	return (
		<span className="std-tags">
			{tags.slice(0, 2).map((tag, index) => (
				<span className="std-tag" data-index={index} key={`${tag}-${index}`}>
					{tag}
				</span>
			))}
			{tags.length > 2 && <span className="std-tag-more">+{tags.length - 2}</span>}
			{tags.length > 1 && <span className="std-tag-more-narrow">+{tags.length - 1}</span>}
		</span>
	);
}

export function ModelCell({ name, color, thinking }: { name: string; color: string; thinking?: string | null }) {
	return (
		<span className="std-model">
			<span className="std-machine-swatch" style={{ background: color }} aria-hidden="true" />
			{name}
			{thinking && <small>{thinking}</small>}
		</span>
	);
}
