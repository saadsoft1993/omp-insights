import { describe, expect, test } from "bun:test";
import { applyControl, buildHash, parseHash } from "../src/client/data/useHashRoute";

describe("control center routes", () => {
	test("round trips screen path and query", () => {
		const route = parseHash("#/sms/board?status=open&repo=a%20b");
		expect(route).toMatchObject({ section: "sms", sub: "board", params: { status: "open", repo: "a b" } });
		expect(parseHash(buildHash(route))).toEqual(route);
	});
	test("drilling changes the tab and preserves existing filters in state and hash", () => {
		const route = parseHash("#/sms/overview?range=7d&project=alpha&state=open");
		const next = applyControl(route, { sub: "board", params: { area: "backend" } });
		expect(next).toMatchObject({
			section: "sms",
			sub: "board",
			params: { project: "alpha", state: "open", area: "backend" },
		});
		expect(buildHash(next)).toBe("#/sms/board?range=7d&project=alpha&state=open&area=backend");
		expect(parseHash(buildHash(next))).toEqual(next);
	});
	test("keeps reserved query keys out of screen params", () => {
		const route = parseHash("#/aws?range=7d&s=x&m=y&tm=z&view=costs");
		expect(route.params).toEqual({ view: "costs" });
	});
	test("accepts delivery without a subpath or params", () => {
		expect(parseHash("#/delivery")).toMatchObject({ section: "delivery", sub: null, params: {} });
	});
	test("preserves existing section behavior", () => {
		expect(parseHash("#/sessions/a%2Fb?range=7d&ignored=x")).toMatchObject({
			section: "sessions",
			hubSession: "a/b",
			range: "7d",
			sub: null,
			params: {},
		});
	});
});
