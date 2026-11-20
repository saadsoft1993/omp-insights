import { afterEach, expect, test, vi } from "bun:test";
import { AccountsRoute } from "../src/client/routes/AccountsRoute";
import { detectHub, resetHubForTests } from "../src/client/data/hub-presence";
import { resetFleetForTests } from "../src/client/app/machine";
import { clearQueryCache } from "../src/client/data/query-store";
import fixture from "./fixtures/accounts-fleet/stats-accounts-macbook.json";
import { click, mount, settle, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	resetHubForTests();
	resetFleetForTests();
	clearQueryCache();
});

test("standalone accounts show recorded usage without waiting for hub login data", async () => {
	const calls: string[] = [];
	resetHubForTests();
	const account = { ...fixture.accounts[0], status: "needs_login", disabledCause: "token expired" };
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		const url = String(input);
		calls.push(url);
		if (url.includes("/api/hub/version")) return new Response(null, { status: 404 });
		if (url.includes("accounts/flow")) return Response.json({ series: [], points: [] });
		if (url.includes("provider-windows")) return Response.json({ usageSeries: [], windowInsights: [] });
		return Response.json({ accounts: [account], unattributed: [], providerTotals: [], routing: [] });
	});
	await detectHub();
	const view = mount();
	await view.render(<AccountsRoute active range="24h" />);
	await settle();
	const row = view.container.querySelector('.table--std tbody tr[tabindex="0"]');
	expect(row).not.toBeNull();
	await click(row);
	const content = view.container.textContent ?? "";
	expect(content).toContain("Login status needs the omp hub");
	expect(content).toContain("Needs login");
	expect(content).toContain("6,047");
	expect(content).toContain("10%");
	expect(content).not.toContain("Checking…");
	expect(content).not.toContain("login list still loading");
	expect([...view.container.querySelectorAll("button")].some(button => /Add account|Reconnect|Remove/.test(button.textContent ?? ""))).toBe(false);
	expect(calls.some(url => url.includes("/api/hub/connections"))).toBe(false);
});
