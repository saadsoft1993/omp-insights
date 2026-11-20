import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/aws/fixture.json";
import expected from "./fixtures/aws/expected.json";
import {
	awsModel,
	callouts,
	explain,
	money,
	pivot,
	pivotCsv,
	shortName,
	total,
	type AwsData,
} from "../src/client/routes/aws/awsModel";

const data = fixture as AwsData;
const options = { group: "Client" as const, split: "service", months: 13 };
describe("AWS model against the standalone Chrome rendering", () => {
	for (const view of ["both", "alpha", "beta"] as const)
		test(view, () => {
			const model = awsModel(data, view),
				p = pivot(model, options),
				golden = expected[view];
			const stats: Record<string, string> = {
				"This month so far": money(model.mtd, 0),
				"Credits this month": money(
					total(model.sumBy("credits_monthly", model.cur)) + total(model.sumBy("refunds_monthly", model.cur)),
					0,
				),
				"Billed so far": money(model.billed("monthly", model.cur), 0),
				"Credit left": money(model.creditLeft, 0),
				"Forecast month-end": model.forecast == null ? "–" : money(model.forecast, 0),
				"Last month": money(model.lastTotal, 0),
				"Run-rate / month": money(model.rr, 0),
				"On dead + idle / mo": money(model.wasteTotal, 0),
			};
			expect(golden.stats.map(s => stats[s.label])).toEqual(golden.stats.map(s => s.value));
			expect(
				model.rows.map(r => ({
					name: shortName(r.svc),
					account: data.accounts.find(a => a.key === r.acc)!.label,
					rr: money(r.rr),
				})),
			).toEqual(golden.services);
			expect(["Total", ...p.totals.map(v => money(v)), money(p.totals.reduce((a, b) => a + b, 0))]).toEqual(
				golden.totals,
			);
			expect(callouts(model, view).map(({ title, text }) => ({ title, text }))).toEqual(golden.callouts);
		});
	test("CSV header and aggregate row", () => {
		const p = pivot(awsModel(data, "alpha"), options),
			lines = pivotCsv(p, options).trim().split("\n");
		expect(lines[0]).toBe(`Client,Service,${p.months.map(m => m.slice(0, 7)).join(",")},Total`);
		const row = p.rows[0];
		expect(lines[1]).toBe([row.g, "TOTAL", ...row.per.map(x => x.toFixed(2)), row.tot.toFixed(2)].join(","));
	});
	test("usage explanation", () => expect(explain("US-BoxUsage:t4g.small")).toBe("EC2 instance hours (t4g.small)"));
});
