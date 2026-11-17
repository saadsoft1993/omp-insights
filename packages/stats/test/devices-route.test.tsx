import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { loadQuery, releaseQuery } from "../src/client/data/query-store";
import type { HubDevice, HubDevices } from "../src/client/data/hub";
import { DevicesRoute } from "../src/client/routes/DevicesRoute";
import { all, byText, click, isDisabled, mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(unmount);

const NOW = Date.now();
const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUV";
const LINK_URL = `https://mac.example.com:8794/#pair=${TOKEN}`;

function device(over: Partial<HubDevice>): HubDevice {
	return {
		id: "aaaaaaaa",
		scope: "tailnet",
		label: "Safari on iPad",
		pairedAt: NOW - 3_600_000,
		expiresAt: NOW + 86_400_000,
		auto: false,
		current: false,
		...over,
	};
}

function devices(over: Partial<HubDevices> = {}): HubDevices {
	return {
		devices: [
			device({ id: "11111111", label: "Chrome on Mac", current: true }),
			device({ id: "22222222", label: "Safari on iPad" }),
			device({ id: "33333333", label: "Firefox on Linux", auto: true, pairedAt: NOW - 7_200_000 }),
			device({ id: "44444444", label: "Chrome local", scope: "local", expiresAt: null }),
		],
		autoPair: false,
		scope: "tailnet",
		canLink: true,
		...over,
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Route `/api/hub/devices*` to the given answers; every call is recorded. */
function mockHub(
	answers: Record<string, () => Response | Promise<Response>>,
	list: () => HubDevices = () => devices(),
) {
	const calls: Call[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({
			url,
			method,
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		if (method === "GET" && url === "/api/hub/devices") return json(list());
		const answer = answers[url];
		if (answer) return answer();
		return json({ error: `unexpected ${url}` }, 500);
	}) as typeof fetch);
	return calls;
}

beforeEach(async () => {
	// A stale cached entry makes every mount fetch its own mock instead of reusing an earlier test's data.
	const key = JSON.stringify(["hub-devices"]);
	const r = loadQuery(key, -1, async () => devices());
	await r.promise;
	releaseQuery(key, r);
});

const gets = (calls: Call[]) => calls.filter(c => c.method === "GET" && c.url === "/api/hub/devices");
const posts = (calls: Call[], url: string) => calls.filter(c => c.method === "POST" && c.url === url);

describe("Devices page", () => {
	it("lists browsers, marking the current one and auto-paired ones", async () => {
		const calls = mockHub({});
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		expect(gets(calls).length).toBeGreaterThan(0);
		const rows = all(h.container, "tbody tr");
		expect(rows).toHaveLength(4);
		const chrome = rows.find(r => (r.textContent ?? "").includes("Chrome on Mac"));
		expect(chrome?.textContent).toContain("this browser");
		expect(rows.filter(r => (r.textContent ?? "").includes("this browser"))).toHaveLength(1);
		const firefox = rows.find(r => (r.textContent ?? "").includes("Firefox on Linux"));
		expect(firefox?.textContent).toContain("auto");
		expect(text(h.container)).toContain("Unpair all auto-paired (1)");
	});

	it("creates a pairing link and shows its URL and a QR code", async () => {
		const calls = mockHub({
			"/api/hub/devices/link": () => json({ url: LINK_URL, expiresAt: Date.now() + 300_000 }),
		});
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(byText(h.container, "button", "Create pairing link"));
		await settle();
		const link = posts(calls, "/api/hub/devices/link");
		expect(link).toHaveLength(1);
		expect(link[0].headers["X-Omp-Hub"]).toBe("1");
		expect(text(h.container)).toContain(LINK_URL);
		const path = h.container.querySelector("svg.pair-qr path[fill='#000']");
		expect(path?.getAttribute("d")?.length ?? 0).toBeGreaterThan(0);
		expect(text(h.container)).toContain("Anyone who opens this link within 5 minutes is paired");
		await click(byText(h.container, "button", "Done"));
		expect(h.container.querySelector("svg.pair-qr")).toBeNull();
	});

	it("disables the create button while the request is pending", async () => {
		let release: (r: Response) => void = () => {};
		const calls = mockHub({
			"/api/hub/devices/link": () => new Promise<Response>(resolve => (release = resolve)),
		});
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(byText(h.container, "button", "Create pairing link"));
		expect(isDisabled(byText(h.container, "button", "Create pairing link"))).toBe(true);
		await click(byText(h.container, "button", "Create pairing link"));
		expect(posts(calls, "/api/hub/devices/link")).toHaveLength(1);
		release(json({ url: LINK_URL, expiresAt: Date.now() + 300_000 }));
		await settle();
		expect(isDisabled(byText(h.container, "button", "Create pairing link"))).toBe(false);
	});

	it("shows the hub's answer when too many links are waiting", async () => {
		mockHub({
			"/api/hub/devices/link": () => json({ error: "3 pairing links are already waiting: use one" }, 429),
		});
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(byText(h.container, "button", "Create pairing link"));
		await settle();
		expect(text(h.container)).toContain("Could not create a link: 3 pairing links are already waiting");
		expect(h.container.querySelector("svg.pair-qr")).toBeNull();
	});

	it("disables link creation when the hub cannot make links", async () => {
		mockHub({}, () => devices({ canLink: false }));
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		expect(isDisabled(byText(h.container, "button", "Create pairing link"))).toBe(true);
	});

	it("labels the button for this Mac on the local page", async () => {
		mockHub({}, () => devices({ scope: "local" }));
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		expect(byText(h.container, "button", "Create link for this Mac")).toBeTruthy();
		expect(byText(h.container, "button", "Create pairing link")).toBeNull();
	});

	it("says the link expired once its time has passed", async () => {
		const start = Date.now();
		mockHub({
			"/api/hub/devices/link": () => json({ url: LINK_URL, expiresAt: Date.now() + 300_000 }),
		});
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		vi.useFakeTimers({ now: start });
		try {
			await click(byText(h.container, "button", "Create pairing link"));
			await act(async () => {
				await Promise.resolve();
			});
			expect(h.container.querySelector("svg.pair-qr")).not.toBeNull();
			expect(text(h.container)).toContain("Expires in 5:00");
			await act(async () => {
				vi.advanceTimersByTime(299_000);
			});
			expect(text(h.container)).toContain("Expires in 0:01");
			expect(h.container.querySelector("svg.pair-qr")).not.toBeNull();
			await act(async () => {
				vi.advanceTimersByTime(2_000);
			});
			expect(text(h.container)).toContain("This link expired; create a new one.");
			expect(h.container.querySelector("svg.pair-qr")).toBeNull();
			expect(text(h.container)).not.toContain(LINK_URL);
		} finally {
			vi.useRealTimers();
		}
	});

	it("unpairs one browser after confirmation and refetches the list", async () => {
		const calls = mockHub({ "/api/hub/devices/revoke": () => json({ revoked: 1, self: false }) });
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		const before = gets(calls).length;
		const row = all(h.container, "tbody tr").find(r => (r.textContent ?? "").includes("Safari on iPad"));
		await click(byText(row as Element, "button", "Unpair"));
		expect(text(h.body)).toContain("Unpair this browser?");
		expect(posts(calls, "/api/hub/devices/revoke")).toHaveLength(0);
		await click(confirmButton(h.body));
		await settle();
		const revoke = posts(calls, "/api/hub/devices/revoke");
		expect(revoke).toHaveLength(1);
		expect(revoke[0].body).toEqual({ id: "22222222" });
		expect(revoke[0].headers["X-Omp-Hub"]).toBe("1");
		expect(gets(calls).length).toBeGreaterThan(before);
		expect(text(h.container)).toContain("Unpaired 1 browser.");
	});

	it("reloads the page when the browser unpaired itself", async () => {
		mockHub({ "/api/hub/devices/revoke": () => json({ revoked: 1, self: true }) });
		const reload = vi.fn();
		const h = mount();
		Object.defineProperty(globalThis.window.location, "reload", { configurable: true, value: reload });
		await h.render(<DevicesRoute active />);
		await settle();
		const row = all(h.container, "tbody tr").find(r => (r.textContent ?? "").includes("Chrome on Mac"));
		await click(byText(row as Element, "button", "Unpair"));
		expect(text(h.body)).toContain("it goes back to the Pair screen");
		await click(confirmButton(h.body));
		await settle();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("unpairs every other browser", async () => {
		const calls = mockHub({ "/api/hub/devices/revoke-others": () => json({ revoked: 3 }) });
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		await click(byText(h.container, "button", "Unpair every other browser"));
		expect(text(h.body)).toContain("Only this browser stays paired");
		await click(confirmButton(h.body));
		await settle();
		expect(posts(calls, "/api/hub/devices/revoke-others")).toHaveLength(1);
		expect(text(h.container)).toContain("Unpaired 3 browsers.");
	});

	it("shows an error when unpairing fails", async () => {
		mockHub({ "/api/hub/devices/revoke": () => json({ error: "boom" }, 500) });
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		const row = all(h.container, "tbody tr").find(r => (r.textContent ?? "").includes("Safari on iPad"));
		await click(byText(row as Element, "button", "Unpair"));
		await click(confirmButton(h.body));
		await settle();
		expect(text(h.container)).toContain("Could not unpair: boom");
	});

	it("warns about auto-pair when unpairing a tailnet browser", async () => {
		mockHub({}, () => devices({ autoPair: true }));
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		const tailnet = all(h.container, "tbody tr").find(r => (r.textContent ?? "").includes("Safari on iPad"));
		await click(byText(tailnet as Element, "button", "Unpair"));
		expect(text(h.body)).toContain("Auto-pair is on");
	});

	it("does not warn about auto-pair when unpairing a local browser", async () => {
		mockHub({}, () => devices({ autoPair: true }));
		const h = mount();
		await h.render(<DevicesRoute active />);
		await settle();
		const local = all(h.container, "tbody tr").find(r => (r.textContent ?? "").includes("Chrome local"));
		await click(byText(local as Element, "button", "Unpair"));
		expect(text(h.body)).toContain("Unpair this browser?");
		expect(text(h.body)).not.toContain("Auto-pair is on");
	});
});

/** The dialog's confirming button (the row buttons are also labelled "Unpair"). */
function confirmButton(body: Element): Element {
	const dialog = body.querySelector("[role=dialog]") ?? body;
	const buttons = all(dialog, "button").filter(b => (b.textContent ?? "").trim() === "Unpair");
	const button = buttons[buttons.length - 1];
	if (!button) throw new Error("confirm button not found");
	return button;
}
