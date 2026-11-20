import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/delivery/data.json";
import expected from "./fixtures/delivery/expected.json";
import {
	aggregate,
	highlights,
	personSeries,
	presetRange,
	score,
	teamTotals,
	type DeliveryData,
} from "../src/client/routes/delivery/deliveryModel";

const data = fixture as unknown as DeliveryData;
describe("delivery model against standalone Chrome output", () => {
	for (const [label, golden] of Object.entries(expected)) {
		test(label, () => {
			const list = aggregate(data, golden.from, golden.to, "All", true);
			const authored = list.reduce((s, p) => s + p.authored, 0),
				delivered = list.reduce((s, p) => s + p.delivered, 0);
			const total = (field: "feature" | "fix" | "test") => list.reduce((s, p) => s + p[field], 0).toLocaleString();
			expect([
				delivered.toLocaleString(),
				authored ? `${Math.round((delivered / authored) * 100)}%` : "–",
				total("feature"),
				total("fix"),
				total("test"),
				String(list.length),
			]).toEqual(golden.kpis);
			expect(
				score(list).ranked.map(p => [
					p.name + (p.lead ? "reviewer" : ""),
					`${p.score >= 0 ? "+" : ""}${p.score.toFixed(2)}`,
					p.stab === "soft" ? "±" : p.stab,
				]),
			).toEqual(golden.ranking);
			expect(
				teamTotals(list).map(t => [
					t.team,
					String(t.people),
					`${t.delivered.toLocaleString()} / ${t.authored.toLocaleString()}`,
					`${Math.round(t.landing * 100)}%`,
					String(t.feature),
					String(t.fix),
					String(t.test),
					t.avg.toFixed(1),
					t.lines.toLocaleString(),
				]),
			).toEqual(golden.teams);
		});
	}
	test("presets, highlights and person buckets", () => {
		expect(presetRange(data, 21)).toEqual({ from: "2026-04-10", to: "2026-04-30" });
		expect(presetRange(data, null).from).toBe(data.minDate);
		const buckets = personSeries(data, 0, data.minDate, data.maxDate);
		expect(buckets.length).toBe(17);
		expect(buckets.reduce((s, b) => s + b.a, 0)).toBe(
			aggregate(data, data.minDate, data.maxDate, "All", false).find(p => p.pi === 0)?.authored,
		);
		expect(
			Object.values(highlights(data, data.minDate, data.maxDate, "All", true)).every(
				samples => new Set(samples.map(s => s[5].toLowerCase().slice(0, 40))).size === samples.length,
			),
		).toBe(true);
	});
});
