import { afterEach, describe, expect, test } from "bun:test";
import { resetFleetForTests, setFleet } from "../app/machine";
import { getHistorySubagents, historyAfter } from "./history-subagents";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	resetFleetForTests();
});

describe("history range and subagents", () => {
	test("maps each header range to its after timestamp", () => {
		const now = 10000000000;
		expect(historyAfter("1h", now)).toBe(now - 3600000);
		expect(historyAfter("24h", now)).toBe(now - 86400000);
		expect(historyAfter("7d", now)).toBe(now - 7 * 86400000);
		expect(historyAfter("30d", now)).toBe(now - 30 * 86400000);
		expect(historyAfter("90d", now)).toBe(now - 90 * 86400000);
		expect(historyAfter("all", now)).toBeUndefined();
	});
	test("uses the row machine and only sends parentLive for live parents", async () => {
		setFleet([
			{
				id: "mini",
				name: "Mini",
				self: false,
				ok: true,
				latencyMs: null,
				version: null,
				lastOkAt: null,
				dashboardUrl: null,
			},
		]);
		const requests: string[] = [];
		globalThis.fetch = (async input => {
			requests.push(String(input));
			return new Response("[]");
		}) as typeof fetch;
		await getHistorySubagents("/a b.jsonl", "mini", true);
		await getHistorySubagents("/a b.jsonl", "mini", false);
		expect(requests[0]).toBe("/m/mini/api/session/subagents?file=%2Fa+b.jsonl&parentLive=1");
		expect(requests[1]).toBe("/m/mini/api/session/subagents?file=%2Fa+b.jsonl");
	});
	test("exposes API errors", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "session not found" }), { status: 404 })) as unknown as typeof fetch;
		await expect(getHistorySubagents("/missing", undefined, false)).rejects.toThrow("session not found");
	});
});
