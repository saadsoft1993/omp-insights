export const SMS_SYNC_JOB = "sms-dashboard-sync";

export function smsSyncRequest() {
	return { label: SMS_SYNC_JOB, confirm: SMS_SYNC_JOB, confirmImpact: false };
}

export const STAGES = [
	"no-status",
	"need-decision-bd",
	"ready",
	"in-development",
	"in-review",
	"in-qa",
	"blocked",
	"waiting-external-review-merge",
	"done",
	"canceled",
	"duplicate",
] as const;
export const STATUS_COLORS: Record<string, string> = {
	"no-status": "#c9c8c1",
	"need-decision-bd": "#a9cdf5",
	ready: "#6ea8ec",
	"in-development": "#2a78d6",
	"in-review": "#1c5cab",
	"in-qa": "#0f3d78",
	blocked: "#d03b3b",
	"waiting-external-review-merge": "#e39a0b",
	done: "#0ca30c",
	canceled: "#8a8983",
	duplicate: "#b3b2ab",
};
export const MR_STAGES = STAGES.slice(1);
export const LEVELS = ["epic", "story", "task", "sub-task", "bug", "unlabelled"] as const;
export const SELECTS = [
	"project",
	"release",
	"milestone",
	"area",
	"epic",
	"eff_status",
	"priority",
	"role",
	"assignee",
	"state",
] as const;
export type SelectField = (typeof SELECTS)[number];
export interface Issue {
	key: string | null;
	ref: string;
	title: string;
	type: string;
	eff_status: string;
	project: string;
	release: string | null;
	milestone: string | null;
	area: string | null;
	epic: string | null;
	priority: string | null;
	role: string | null;
	state: string;
	assignees: string[];
	blocked: boolean;
	founder_approval: boolean;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	url: string;
	points?: number | null;
	mrs?: unknown[];
	[key: string]: unknown;
}
export interface MergeRequest {
	id: number;
	project: string;
	title: string;
	ref: string;
	author: string;
	source_branch: string;
	target_branch: string;
	keys: string[];
	status: string;
	status_via: string;
	updated_at: string;
	url: string;
	description?: string;
	links?: { url: string; key?: string; ref?: string; title?: string; status?: string }[];
	[key: string]: unknown;
}
export type Filters = Record<SelectField, string> & {
	levels: Set<string>;
	q: string;
	blocked: boolean;
	founder: boolean;
};
export function defaultFilters(): Filters {
	return {
		levels: new Set(["story", "task", "bug", "unlabelled"]),
		q: "",
		blocked: false,
		founder: false,
		project: "",
		release: "",
		milestone: "",
		area: "",
		epic: "",
		eff_status: "",
		priority: "",
		role: "",
		assignee: "",
		state: "",
	};
}
export function parseFilters(p: Readonly<Record<string, string>>): Filters {
	const f = defaultFilters();
	if (p.levels !== undefined) f.levels = new Set(p.levels.split(",").filter(Boolean));
	for (const k of SELECTS) f[k] = p[k] || "";
	f.q = p.q || "";
	f.blocked = p.blocked === "1";
	f.founder = p.founder === "1";
	return f;
}
export function serializeFilters(f: Filters): Record<string, string | null> {
	const p: Record<string, string | null> = {
		levels: [...f.levels].join(","),
		q: f.q || null,
		blocked: f.blocked ? "1" : null,
		founder: f.founder ? "1" : null,
	};
	for (const k of SELECTS) p[k] = f[k] || null;
	return p;
}
export function fieldValues(i: Issue, f: SelectField): string[] {
	if (f === "assignee") return i.assignees.length ? i.assignees : ["Unassigned"];
	return [String(i[f] ?? "(none)")];
}
export function matches(i: Issue, f: Filters, skip?: string): boolean {
	if (skip !== "levels" && !f.levels.has(i.type)) return false;
	if ((f.blocked && !i.blocked) || (f.founder && !i.founder_approval)) return false;
	if (f.q && !`${i.title}\n${i.ref}`.toLowerCase().includes(f.q.toLowerCase())) return false;
	return SELECTS.every(k => k === skip || !f[k] || fieldValues(i, k).includes(f[k]));
}
export function mrMatches(m: MergeRequest, f: Filters, skip?: string): boolean {
	return (
		(skip === "project" || !f.project || m.project === f.project) &&
		(!f.q ||
			[m.title, m.ref, m.author, m.source_branch, ...m.keys].join(" ").toLowerCase().includes(f.q.toLowerCase()))
	);
}
export function statusCounts(list: Issue[]): Record<string, number> {
	const counts: Record<string, number> = Object.fromEntries(STAGES.map(s => [s, 0]));
	for (const i of list) counts[i.eff_status] = (counts[i.eff_status] || 0) + 1;
	return counts;
}
export function mrStatusCounts(list: MergeRequest[]): Record<string, number> {
	const counts: Record<string, number> = Object.fromEntries(MR_STAGES.map(s => [s, 0]));
	counts.all = list.length;
	for (const m of list) counts[m.status] = (counts[m.status] || 0) + 1;
	return counts;
}
export function groupRows(list: Issue[], field: SelectField) {
	const groups = new Map<string, Issue[]>();
	for (const i of list)
		for (const v of fieldValues(i, field)) {
			const a = groups.get(v);
			if (a) a.push(i);
			else groups.set(v, [i]);
		}
	return [...groups]
		.map(([key, items]) => ({ key, items, total: items.length, c: statusCounts(items) }))
		.sort((a, b) => b.total - a.total);
}
export function boardColumns(list: Issue[]) {
	const by: Record<string, Issue[]> = Object.fromEntries(STAGES.map(s => [s, []]));
	for (const i of list) (by[i.eff_status] ||= []).push(i);
	for (const items of Object.values(by)) items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	return by;
}
export const CSV_COLUMNS = [
	"key",
	"title",
	"type",
	"eff_status",
	"state",
	"project",
	"release",
	"milestone",
	"epic",
	"area",
	"priority",
	"role",
	"points",
	"assignees",
	"created_at",
	"updated_at",
	"closed_at",
	"url",
];
export function ticketCsv(rows: Issue[]): string {
	const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
	return [
		CSV_COLUMNS.join(","),
		...rows.map(i => CSV_COLUMNS.map(k => q(Array.isArray(i[k]) ? (i[k] as unknown[]).join("; ") : i[k])).join(",")),
	].join("\n");
}
export function sortTickets(rows: Issue[], key: string, dir: number): Issue[] {
	const val = (i: Issue) =>
		key === "assignees"
			? i.assignees.join(", ")
			: key === "eff_status"
				? STAGES.indexOf(i.eff_status as (typeof STAGES)[number])
				: key === "key"
					? i.key || i.ref
					: (i[key] ?? "");
	return [...rows].sort((a, b) => {
		const x = val(a),
			y = val(b);
		return (
			(typeof x === "number" && typeof y === "number"
				? x - y
				: String(x).localeCompare(String(y), undefined, { numeric: true })) * dir
		);
	});
}
const DAY = 86400000;
export function burnUp(list: Issue[], now = Date.now()) {
	const events: [number, number, number][] = [];
	for (const i of list) {
		events.push([Date.parse(i.created_at), 1, 0]);
		if (i.closed_at) events.push([Date.parse(i.closed_at), 0, 1]);
	}
	events.sort((a, b) => a[0] - b[0]);
	const created: [number, number][] = [],
		closed: [number, number][] = [];
	let a = 0,
		b = 0,
		last = -1;
	for (const [t, dc, dd] of events) {
		a += dc;
		b += dd;
		const day = Math.floor(t / DAY) * DAY;
		if (day === last) {
			created[created.length - 1][1] = a;
			closed[closed.length - 1][1] = b;
		} else {
			created.push([day, a]);
			closed.push([day, b]);
			last = day;
		}
	}
	if (created.length) {
		created.push([now, a]);
		closed.push([now, b]);
	}
	return { created, closed };
}
/** One slot per UTC day, carrying the last known cumulative value across gaps. */
export function burnUpDaily(list: Issue[], now = Date.now()) {
	const { created, closed } = burnUp(list, now);
	if (!created.length) return [];
	const first = Math.floor(created[0][0] / DAY) * DAY;
	const last = Math.floor(Math.max(now, created[created.length - 1][0]) / DAY) * DAY;
	const rows: { time: number; created: number; closed: number }[] = [];
	let index = 0,
		createdCount = 0,
		closedCount = 0;
	for (let time = first; time <= last; time += DAY) {
		while (index < created.length && Math.floor(created[index][0] / DAY) * DAY <= time) {
			createdCount = created[index][1];
			closedCount = closed[index][1];
			index++;
		}
		rows.push({ time, created: createdCount, closed: closedCount });
	}
	return rows;
}
export function weekStart(t: number) {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
}
export function throughput(list: Issue[], now = Date.now()) {
	const start = weekStart(now);
	const counts = new Map(Array.from({ length: 12 }, (_, k) => [start - (11 - k) * 7 * DAY, 0]));
	for (const i of list)
		if (i.closed_at) {
			const w = weekStart(Date.parse(i.closed_at));
			if (counts.has(w)) counts.set(w, counts.get(w)! + 1);
		}
	return [...counts].map(([time, value]) => ({ time, value }));
}

export interface MilestoneInfo {
	title: string;
	due: string | null;
}
export function filterOptions(
	issues: Issue[],
	mrs: MergeRequest[],
	filters: Filters,
	field: SelectField,
	milestones: MilestoneInfo[],
	mr = false,
): { value: string; count: number }[] {
	const counts = new Map<string, number>();
	if (mr) {
		for (const m of mrs)
			if (mrMatches(m, filters, "project")) counts.set(m.project, (counts.get(m.project) || 0) + 1);
	} else {
		for (const issue of issues)
			if (matches(issue, filters, field))
				for (const value of fieldValues(issue, field)) counts.set(value, (counts.get(value) || 0) + 1);
	}
	if (filters[field] && !counts.has(filters[field])) counts.set(filters[field], 0);
	const releases = ["pilot-core", "mvp-1", "mvp-2", "mvp-3+"];
	const order = (value: string) => {
		const n = releases.indexOf(value);
		return n < 0 ? 99 : n;
	};
	const due = (value: string) => milestones.find(m => m.title === value)?.due || "9999";
	return [...counts]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) =>
			field === "eff_status"
				? STAGES.indexOf(a.value as (typeof STAGES)[number]) - STAGES.indexOf(b.value as (typeof STAGES)[number])
				: field === "release"
					? order(a.value) - order(b.value)
					: field === "milestone"
						? due(a.value).localeCompare(due(b.value))
						: a.value.localeCompare(b.value, undefined, { numeric: true }),
		);
}
export interface TimelineMilestone {
	title: string;
	start: string | null;
	due: string | null;
	issues_done: number;
	issues_total: number;
	points_done: number;
	points_total: number;
	unit: string;
	total: number;
	done: number;
	pct: number;
	pace_14d: number;
	required_pace: number | null;
	projected_finish: string | null;
	status: string;
}
export function timelinePace(m: TimelineMilestone) {
	return {
		actual: m.pace_14d,
		required: m.required_pace,
		projectedFinish: m.projected_finish,
		unit: m.unit === "points" ? "pts" : "issues",
	};
}
