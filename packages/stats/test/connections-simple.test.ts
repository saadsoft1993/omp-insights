import { afterEach, expect, it, vi } from "bun:test";
import { fetchConnections, removeCredential } from "../src/client/data/connections";
import { resetFleetForTests, setFleet, parseMachines } from "../src/client/app/machine";

afterEach(() => {
	vi.restoreAllMocks();
	resetFleetForTests();
});

it("reads and removes a credential on the requested machine", async () => {
	setFleet(
		parseMachines([
			{ id: "server", self: true, ok: true },
			{ id: "mini", ok: true },
		]),
	);
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		calls.push({ url: String(input), init });
		return Response.json(
			String(input).endsWith("/remove") ? { removed: true } : { machine: "mini", providers: [], login: null },
		);
	});
	expect((await fetchConnections("mini")).machine).toBe("mini");
	await removeCredential("mini", 7, "person@example.com");
	expect(calls[0].url).toBe("/m/mini/api/hub/connections");
	expect(calls[1].url).toBe("/m/mini/api/hub/connections/remove");
	expect(JSON.parse(String(calls[1].init?.body))).toEqual({ credentialId: 7, confirm: "person@example.com" });
	expect(new Headers(calls[1].init?.headers).get("X-Omp-Hub")).toBe("1");
});
