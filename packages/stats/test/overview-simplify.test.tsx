import { afterEach, expect, test, vi } from "bun:test";
import { OverviewRoute } from "../src/client/routes/OverviewRoute";
import { mount, settle, unmount } from "./helpers/memory-dom";

afterEach(unmount);

test("Overview fetches no account, flow or recent request data", async () => {
	const urls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		urls.push(String(input));
		return new Response("error", { status: 500 });
	}) as typeof fetch);
	const h = mount();
	await h.render(<OverviewRoute active range="7d" onRequestClick={() => {}} />);
	await settle();
	expect(urls.some(url => url.includes("/overview"))).toBe(true);
	expect(urls.some(url => /accounts|account-flow|recent/.test(url))).toBe(false);
	expect(h.container.querySelector('a[href="#/accounts?range=7d"]')?.textContent).toContain("Accounts & quota");
	expect(h.container.querySelector('a[href="#/requests?range=7d"]')?.textContent).toContain("All requests");
});
