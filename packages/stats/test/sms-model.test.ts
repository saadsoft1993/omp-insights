import { describe, expect, test } from "bun:test";
import {
	boardColumns,
	burnUp,
	burnUpDaily,
	CSV_COLUMNS,
	defaultFilters,
	filterOptions,
	groupRows,
	matches,
	mrMatches,
	mrStatusCounts,
	parseFilters,
	serializeFilters,
	smsSyncRequest,
	statusCounts,
	throughput,
	ticketCsv,
	timelinePace,
} from "../src/client/routes/sms/smsModel";
import { issues, mrs } from "./fixtures/sms/fixture";
describe("SMS report model", () => {
	test("refresh request uses the hub job label for confirmation", () => {
		expect(smsSyncRequest()).toEqual({
			label: "sms-dashboard-sync",
			confirm: "sms-dashboard-sync",
			confirmImpact: false,
		});
	});
	test("burn-up preserves daily spacing through gaps", () => {
		const sample = { ...issues[1], created_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-04T00:00:00Z" };
		const days = burnUpDaily([sample], Date.parse("2026-01-05T12:00:00Z"));
		expect(days.map(d => d.created)).toEqual([1, 1, 1, 1, 1]);
		expect(days.map(d => d.closed)).toEqual([0, 0, 0, 1, 1]);
		expect(days[3].time - days[0].time).toBe(3 * 86400000);
	});
	test("combines level, search, select, blocked and founder filters", () => {
		const f = defaultFilters();
		expect(issues.filter(i => matches(i, f))).toHaveLength(40);
		f.levels.add("epic");
		f.blocked = true;
		f.founder = true;
		f.project = "alpha";
		f.q = "synthetic";
		expect(issues.filter(i => matches(i, f)).map(i => i.key)).toEqual(["TEST-1", "TEST-31"]);
	});
	test("counts effective statuses and groups board swimlanes", () => {
		const counts = statusCounts(issues);
		expect(counts.ready).toBe(25);
		expect(counts.done).toBe(25);
		const groups = groupRows(issues, "project");
		expect(groups).toHaveLength(2);
		expect(boardColumns(groups.find(g => g.key === "alpha")!.items).ready).toHaveLength(25);
	});
	test("round trips hash filters including empty levels", () => {
		const f = defaultFilters();
		f.levels.clear();
		f.q = "a & b";
		f.assignee = "Unassigned";
		f.blocked = true;
		f.founder = true;
		const params = serializeFilters(f);
		const encoded = new URLSearchParams(
			Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== null),
		).toString();
		const restored = parseFilters(Object.fromEntries(new URLSearchParams(encoded)));
		expect(restored).toEqual(f);
	});
	test("exports the original CSV header", () => {
		expect(ticketCsv(issues).split("\n")[0]).toBe(CSV_COLUMNS.join(","));
	});
	test("merge request status counts respect applicable filters", () => {
		const f = defaultFilters();
		f.project = "alpha";
		const matching = mrs.filter(m => mrMatches(m, f));
		expect(mrStatusCounts(matching).all).toBe(5);
		expect(mrStatusCounts(matching).ready).toBe(5);
		f.q = "TEST-1";
		expect(mrs.filter(m => mrMatches(m, f))).toHaveLength(1);
	});
	test("burn-up groups cumulative events by day and throughput uses twelve weeks", () => {
		const now = Date.parse("2026-01-04T12:00:00Z");
		const result = burnUp(issues, now);
		expect(result.created.map(p => p[1])).toEqual([50, 50, 50]);
		expect(result.closed.map(p => p[1])).toEqual([0, 25, 25]);
		const weeks = throughput(issues, now);
		expect(weeks).toHaveLength(12);
		expect(weeks.at(-1)?.value).toBe(25);
	});
	test("filter options use other filters, counts and source ordering", () => {
		const f = defaultFilters();
		f.levels.add("epic");
		f.project = "alpha";
		expect(filterOptions(issues, mrs, f, "project", [])).toEqual([
			{ value: "alpha", count: 25 },
			{ value: "beta", count: 25 },
		]);
		const samples = issues.slice(0, 3).map((i, k) => ({
			...i,
			release: ["mvp-2", "pilot-core", "mvp-1"][k],
			milestone: ["Later", "Soon", "Undated"][k],
		}));
		f.project = "";
		expect(filterOptions(samples, mrs, f, "release", []).map(x => x.value)).toEqual(["pilot-core", "mvp-1", "mvp-2"]);
		expect(
			filterOptions(samples, mrs, f, "milestone", [
				{ title: "Later", due: "2026-03-01" },
				{ title: "Soon", due: "2026-01-01" },
			]).map(x => x.value),
		).toEqual(["Soon", "Later", "Undated"]);
		expect(filterOptions(issues, mrs, f, "project", [], true).map(x => x.count)).toEqual([5, 5]);
	});
	test("timeline uses the synced pace, required pace and projection", () => {
		const row = {
			title: "Week",
			start: null,
			due: "2026-02-01",
			issues_done: 2,
			issues_total: 4,
			points_done: 3,
			points_total: 8,
			unit: "points",
			total: 8,
			done: 3,
			pct: 37.5,
			pace_14d: 0.5,
			required_pace: 1.2,
			projected_finish: "2026-02-10",
			status: "at_risk",
		};
		expect(timelinePace(row)).toEqual({ actual: 0.5, required: 1.2, projectedFinish: "2026-02-10", unit: "pts" });
	});
});
