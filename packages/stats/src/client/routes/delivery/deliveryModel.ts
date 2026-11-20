export interface Person {
	name: string;
	team: string;
	roster: boolean;
	lead: boolean;
}
export type DailyRow = [number, string, number, number, number, number, ...number[]];
export type Sample = [number, string, string, string, number, string, number];
export interface DeliveryData {
	people: Person[];
	daily: DailyRow[];
	samples: Sample[];
	types: string[];
	unit_types: string[];
	minDate: string;
	maxDate: string;
	synced: string;
	repos: number;
}
export interface PersonRow extends Person {
	pi: number;
	authored: number;
	delivered: number;
	lines: number;
	effort: number;
	days: number;
	types: Record<string, number>;
	units: number;
	feature: number;
	fix: number;
	test: number;
	landing: number;
	score: number;
	lo: number;
	hi: number;
	stab: "firm" | "soft" | "unstable";
	rank: number;
}
export const SCHEMES = [
	[0.35, 0.25, 0.25, 0.15],
	[0.6, 0.15, 0.15, 0.1],
	[0.15, 0.55, 0.2, 0.1],
	[0.2, 0.15, 0.55, 0.1],
	[0.25, 0.2, 0.2, 0.35],
	[0.25, 0.25, 0.25, 0.25],
] as const;
const DAY = 86400000;
export function presetRange(data: DeliveryData, days: number | null) {
	return {
		from: days ? new Date(+new Date(data.maxDate) - (days - 1) * DAY).toISOString().slice(0, 10) : data.minDate,
		to: data.maxDate,
	};
}
export function aggregate(
	data: DeliveryData,
	from: string,
	to: string,
	team: string,
	rosterOnly: boolean,
): PersonRow[] {
	const acc: Record<number, PersonRow> = {};
	for (const row of data.daily) {
		const [pi, date, authored, delivered, lines, effort] = row;
		if (date < from || date > to) continue;
		const person = data.people[pi];
		if ((team !== "All" && person.team !== team) || (rosterOnly && !person.roster)) continue;
		const p = (acc[pi] ||= {
			...person,
			pi,
			authored: 0,
			delivered: 0,
			lines: 0,
			effort: 0,
			days: 0,
			types: {},
			units: 0,
			feature: 0,
			fix: 0,
			test: 0,
			landing: 0,
			score: 0,
			lo: 0,
			hi: 0,
			stab: "firm",
			rank: 0,
		});
		p.authored += authored;
		p.delivered += delivered;
		p.lines += lines;
		p.effort += effort;
		if (delivered > 0) p.days++;
		data.types.forEach((type, i) => {
			const value = Number(row[6 + i]);
			if (value) p.types[type] = (p.types[type] || 0) + value;
		});
	}
	return Object.values(acc).map(p => {
		p.units = data.unit_types.reduce((sum, type) => sum + (p.types[type] || 0), 0);
		p.feature = p.types.feature || 0;
		p.fix = p.types.fix || 0;
		p.test = p.types.test || 0;
		p.landing = p.authored ? p.delivered / p.authored : 0;
		return p;
	});
}
function zf(values: number[]) {
	const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
	const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length || 1)) || 1;
	return (x: number) => (x - mean) / sd;
}
export function score(list: PersonRow[]) {
	const ranked = list.filter(p => p.delivered > 0).map(p => ({ ...p }));
	const none = list.filter(p => p.delivered === 0);
	if (!ranked.length) return { ranked, none };
	const zu = zf(ranked.map(p => p.units)),
		ze = zf(ranked.map(p => p.effort)),
		zd = zf(ranked.map(p => p.days));
	const value = (p: PersonRow, w: readonly number[]) =>
		w[0] * zu(p.units) + w[1] * ze(p.effort) + w[2] * zd(p.days) + w[3] * ((p.landing - 0.85) / 0.2);
	const ranks: Record<string, number[]> = {};
	for (const weights of SCHEMES)
		[...ranked]
			.sort((a, b) => value(b, weights) - value(a, weights))
			.forEach((p, i) => (ranks[p.name] ||= []).push(i + 1));
	for (const p of ranked) {
		p.score = value(p, SCHEMES[0]);
		p.lo = Math.min(...ranks[p.name]);
		p.hi = Math.max(...ranks[p.name]);
		const spread = p.hi - p.lo;
		p.stab = spread <= 4 ? "firm" : spread <= 9 ? "soft" : "unstable";
	}
	ranked
		.sort((a, b) => b.score - a.score)
		.forEach((p, i) => {
			p.rank = i + 1;
		});
	return { ranked, none };
}
export function teamTotals(list: PersonRow[]) {
	const teams: Record<
		string,
		{
			team: string;
			people: number;
			authored: number;
			delivered: number;
			lines: number;
			feature: number;
			fix: number;
			test: number;
			days: number;
			landing: number;
			avg: number;
		}
	> = {};
	for (const p of list) {
		const t = (teams[p.team] ||= {
			team: p.team,
			people: 0,
			authored: 0,
			delivered: 0,
			lines: 0,
			feature: 0,
			fix: 0,
			test: 0,
			days: 0,
			landing: 0,
			avg: 0,
		});
		t.people++;
		t.authored += p.authored;
		t.delivered += p.delivered;
		t.lines += p.lines;
		t.feature += p.feature;
		t.fix += p.fix;
		t.test += p.test;
		t.days += p.days;
	}
	return Object.values(teams)
		.map(t => ({ ...t, landing: t.authored ? t.delivered / t.authored : 0, avg: t.days / (t.people || 1) }))
		.sort((a, b) => b.delivered - a.delivered);
}
export function spark(data: DeliveryData, pi: number, from: string, to: string) {
	const buckets = Array<number>(8).fill(0),
		start = +new Date(from),
		span = Math.max(1, (+new Date(to) - start) / DAY);
	for (const row of data.daily)
		if (row[0] === pi && row[1] >= from && row[1] <= to)
			buckets[Math.min(7, Math.floor(((+new Date(row[1]) - start) / DAY / span) * 8))] += row[3];
	return buckets;
}
export function personSeries(data: DeliveryData, pi: number, from: string, to: string) {
	const start = +new Date(from),
		days = Math.max(1, Math.round((+new Date(to) - start) / DAY));
	const n = Math.min(26, Math.max(6, Math.ceil(days / 7))),
		span = days / n;
	const out = Array.from({ length: n }, (_, i) => ({
		d: 0,
		a: 0,
		lines: 0,
		from: new Date(start + i * span * DAY).toISOString().slice(0, 10),
		to: new Date(start + Math.min(days, (i + 1) * span) * DAY).toISOString().slice(0, 10),
	}));
	for (const row of data.daily)
		if (row[0] === pi && row[1] >= from && row[1] <= to) {
			const bucket = out[Math.min(n - 1, Math.floor((+new Date(row[1]) - start) / DAY / span))];
			bucket.a += row[2];
			bucket.d += row[3];
			bucket.lines += row[4];
		}
	return out;
}
export function highlights(data: DeliveryData, from: string, to: string, team: string, rosterOnly: boolean) {
	const byTeam: Record<string, Sample[]> = {};
	for (const s of data.samples) {
		const p = data.people[s[0]];
		if (s[1] >= from && s[1] <= to && (team === "All" || p.team === team) && (!rosterOnly || p.roster))
			(byTeam[p.team] ||= []).push(s);
	}
	return Object.fromEntries(
		Object.entries(byTeam).map(([name, samples]) => {
			const seen = new Set<string>(),
				picks: Sample[] = [];
			for (const [kind, limit] of [
				["feature", 5],
				["fix", 3],
				["refactor", 1],
			] as const) {
				let count = 0;
				for (const s of samples.filter(s => s[3] === kind).sort((a, b) => a[6] - b[6] || b[4] - a[4])) {
					const key = s[5].toLowerCase().slice(0, 40);
					if (seen.has(key)) continue;
					seen.add(key);
					picks.push(s);
					if (++count >= limit) break;
				}
			}
			return [name, picks];
		}),
	);
}
