import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	answerLogin,
	cancelLogin,
	fetchProviders,
	LoginError,
	pollLogin,
	setPriority,
	startLogin,
} from "../src/client/data/login-flow";

afterEach(() => vi.restoreAllMocks());
import { resetFleetForTests, setFleet } from "../src/client/app/machine";

describe("login flow API", () => {
	it("sends every operation with the expected body and hub header", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ providers: [], entries: [] }));
		await fetchProviders();
		await startLogin(undefined, "anthropic", "a@example.com");
		await answerLogin(undefined, "id", "");
		await cancelLogin(undefined, "id");
		await pollLogin(undefined, "id");
		await setPriority({ credentialId: 7, choice: "backup", fleet: false });
		await setPriority({ machine: "mini", credentialId: 7, choice: "first", fleet: true });
		expect(fetch.mock.calls.map(c => String(c[0]))).toEqual([
			"/api/hub/connections/providers",
			"/api/hub/connections/start",
			"/api/hub/connections/answer",
			"/api/hub/connections/cancel",
			"/api/hub/connections/login?id=id",
			"/api/hub/connections/priority",
			"/api/hub/connections/priority-fleet",
		]);
		for (const i of [1, 2, 3, 5, 6])
			expect((fetch.mock.calls[i][1]?.headers as Record<string, string>)["X-Omp-Hub"]).toBe("1");
		expect(JSON.parse(String(fetch.mock.calls[6][1]?.body))).toEqual({
			machine: "mini",
			credentialId: 7,
			choice: "first",
		});
	});
	it("preserves the busy login for resume", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ error: "busy", login: { id: "running" } }, { status: 409 }),
		);
		try {
			await startLogin(undefined, "p");
			throw new Error("expected rejection");
		} catch (e) {
			expect(e).toBeInstanceOf(LoginError);
			expect((e as LoginError).login?.id).toBe("running");
		}
	});
	it("prefixes machine requests but never fleet priority", async () => {
		setFleet([
			{
				id: "mini",
				name: "Mini",
				self: true,
				ok: true,
				latencyMs: null,
				version: null,
				lastOkAt: null,
				dashboardUrl: null,
			},
		]);
		try {
			const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ providers: [], entries: [] }));
			await fetchProviders("mini");
			await startLogin("mini", "p");
			await answerLogin("mini", "id", "answer");
			await cancelLogin("mini", "id");
			await pollLogin("mini", "id");
			await setPriority({ machine: "mini", credentialId: 1, choice: "first", fleet: true });
			for (const call of fetch.mock.calls.slice(0, 5)) expect(String(call[0])).toStartWith("/m/mini/api/hub/");
			expect(String(fetch.mock.calls[5][0])).toBe("/api/hub/connections/priority-fleet");
		} finally {
			resetFleetForTests();
		}
	});
});
