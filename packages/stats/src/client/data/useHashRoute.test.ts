import { describe, expect, test } from "bun:test";
import { buildHash, parseHash } from "./useHashRoute";

describe("trace machine links", () => {
	test("round trips the selected machine separately from the trace machine", () => {
		const route = {
			section: "traces" as const,
			range: "24h" as const,
			session: "/home/me/a b.jsonl",
			hubSession: null,
			sub: null,
			params: {},
			machine: "*",
			traceMachine: "mini",
		};
		expect(parseHash(buildHash(route))).toEqual(route);
	});
	test("old m links still select their machine", () => {
		expect(parseHash("#/traces?s=file&m=mini")).toMatchObject({ session: "file", machine: "mini" });
	});
});
