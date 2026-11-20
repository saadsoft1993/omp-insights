import { describe, expect, spyOn, test } from "bun:test";
import { ApiError } from "../src/client/api";
import type { ModelFlow } from "../src/client/data/hub";
import { applyFlowRole, fetchMachineFlow, flowMatrix } from "../src/client/data/model-flow-fleet";
import { placePopover } from "../src/client/routes/model-flow-popover";

const flow = (revision: string, model: string): ModelFlow => ({
	path: "config.yml",
	revision,
	models: [],
	roles: [{ role: "plan", value: model, model, thinking: null, editable: true, usedBy: [] }],
});

describe("fleet model flow", () => {
	test("marks differing role choices across machines", () => {
		const rows = flowMatrix([
			{ machine: "a", flow: flow("1", "one") },
			{ machine: "b", flow: flow("2", "two") },
		]);
		expect(rows[0].different).toBe(true);
		expect(rows[0].cells.map(cell => cell?.model)).toEqual(["one", "two"]);
	});
	test("does not flag equal choices and flags a missing role", () => {
		const first = flow("1", "one");
		const second = flow("2", "one");
		expect(
			flowMatrix([
				{ machine: "a", flow: first },
				{ machine: "b", flow: second },
			])[0].different,
		).toBe(false);
		expect(
			flowMatrix([
				{ machine: "a", flow: first },
				{ machine: "b", flow: { ...second, roles: [] } },
			])[0].different,
		).toBe(true);
	});

	test("reports each machine's result independently using its revision", async () => {
		const revisions: string[] = [];
		const results = await applyFlowRole(
			[
				{ machine: "a", flow: flow("rev-a", "one") },
				{ machine: "b", flow: flow("rev-b", "two") },
				{ machine: "c", flow: flow("rev-c", "three") },
			],
			"plan",
			{ model: "one", thinking: null },
			async (machine, revision) => {
				revisions.push(`${machine}:${revision}`);
				if (machine === "b") throw new ApiError(409, "model-flow", "changed", "stale");
				if (machine === "c") throw new ApiError(400, "model-flow", "unknown model", "unknown_model");
				return { ...flow("next", "one"), saved: ["plan"] };
			},
		);
		expect(revisions).toEqual(["a:rev-a", "b:rev-b", "c:rev-c"]);
		expect(results.map(result => result.status)).toEqual(["saved", "stale", "unknown_model"]);
	});
});

describe("model flow popover placement (D6)", () => {
	const visible = { top: 56, bottom: 900 };
	test("opens below when the picker fits", () => {
		expect(placePopover({ top: 200, bottom: 230 }, 430, visible)).toEqual({ side: "below", maxHeight: 658 });
	});
	test("flips above on a low row so Save and Cancel stay on screen", () => {
		const placed = placePopover({ top: 700, bottom: 730 }, 430, visible);
		expect(placed.side).toBe("above");
		expect(placed.maxHeight).toBeGreaterThanOrEqual(430);
	});
	test("caps the height on the side with more room when neither side fits", () => {
		expect(placePopover({ top: 400, bottom: 430 }, 900, visible)).toEqual({ side: "below", maxHeight: 458 });
		expect(placePopover({ top: 560, bottom: 590 }, 900, visible)).toEqual({ side: "above", maxHeight: 492 });
	});
});

describe("fetchMachineFlow", () => {
	test("rejects an answer without roles instead of showing every role as unset", async () => {
		const spy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(JSON.stringify({ path: "x", revision: "r", roles: [], models: [] }), {
					headers: { "Content-Type": "application/json" },
				})) as unknown as typeof fetch,
		);
		await expect(fetchMachineFlow()).rejects.toThrow("the hub answered without any roles");
		spy.mockRestore();
	});
});
