import { describe, expect, it } from "bun:test";
import { buildHash, parseHash } from "../src/client/data/useHashRoute";

describe("sessions hash route", () => {
	it("reads the session id an alert link carries", () => {
		const route = parseHash("#/sessions/0192-abc");
		expect(route.section).toBe("sessions");
		expect(route.hubSession).toBe("0192-abc");
	});

	it("decodes an encoded id and survives a malformed one", () => {
		expect(parseHash("#/sessions/a%2Fb%20c").hubSession).toBe("a/b c");
		expect(parseHash("#/sessions/100%").hubSession).toBe("100%");
	});

	it("keeps the plain list route free of a selection", () => {
		expect(parseHash("#/sessions").hubSession).toBeNull();
		expect(parseHash("#/sessions/").hubSession).toBeNull();
		expect(parseHash("#/sessions?range=7d")).toMatchObject({ section: "sessions", range: "7d", hubSession: null });
	});

	it("ignores an id under other sections", () => {
		expect(parseHash("#/models/x").hubSession).toBeNull();
	});

	it("round-trips through buildHash with the id encoded", () => {
		const route = { section: "sessions" as const, range: "24h" as const, session: null, hubSession: "a/b c" };
		const hash = buildHash(route);
		expect(hash).toBe("#/sessions/a%2Fb%20c?range=24h");
		expect(parseHash(hash)).toEqual(route);
	});

	it("drops the selection outside the sessions page", () => {
		expect(buildHash({ section: "models", range: "24h", session: null, hubSession: "x" })).toBe("#/models?range=24h");
	});
});
