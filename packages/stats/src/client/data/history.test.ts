import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../types";
import { historyName, horizonMachines, isRunning, upsertPage, visibleHistory, type HistoryState } from "./history";

const row = (file: string, endedAt: number): SessionSummary => ({
	file,
	endedAt,
	startedAt: endedAt,
	folder: "/x",
	title: null,
	firstMessage: null,
	sessionId: file,
	cwd: "/x",
	parentSession: null,
	continuationOf: null,
	missing: false,
	requests: 0,
	toolCalls: 0,
	subagents: 0,
	totalTokens: 0,
	costTotal: 0,
	unpricedRequests: 0,
	models: [],
});
const empty = (): HistoryState => ({ rows: new Map(), pages: {} });

describe("session history", () => {
	test("hides rows below the newest reachable horizon", () => {
		let state = upsertPage(empty(), "a", [row("a1", 100), row("a2", 80)], 2, true);
		state = upsertPage(state, "b", [row("b1", 90), row("b2", 40)], 2, true);
		expect(horizonMachines(state.pages, new Set(["a", "b"]))).toEqual(["a"]);
		expect(visibleHistory(state, new Set(["a", "b"])).map(r => r.file)).toEqual(["a1", "b1", "a2"]);
	});
	test("upserts refetched first pages without losing gap rows", () => {
		let state = upsertPage(empty(), "a", [row("a", 5), row("b", 4)], 2, true);
		state = upsertPage(state, "a", [row("c", 3), row("d", 2)], 2);
		state = upsertPage(state, "a", [row("new", 6), row("a", 5)], 2, true);
		expect([...state.rows.values()].map(r => r.file)).toContain("b");
	});
	test("stops when an old server repeats its page", () => {
		let state = upsertPage(empty(), "a", [row("a", 5), row("b", 4)], 2, true);
		state = upsertPage(state, "a", [row("a", 5), row("b", 4)], 2);
		expect(state.pages.a.exhausted).toBe(true);
	});
	test("status requires machine and session id", () => {
		const r = { ...row("id", 1), machine: "a" };
		expect(isRunning(r, new Set(["a:id"]))).toBe(true);
		expect(isRunning(r, new Set(["b:id"]))).toBe(false);
	});
	test("name falls back through title, message, and stem", () => {
		expect(historyName({ ...row("/a/example.jsonl", 1), title: " ", firstMessage: "Hello" })).toBe("Hello");
		expect(historyName(row("/a/example.jsonl", 1))).toBe("example");
	});
});
