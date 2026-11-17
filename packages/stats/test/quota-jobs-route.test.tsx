import { afterEach, describe, expect, it, vi } from "bun:test";
import { PairScreen } from "../src/client/app/PairScreen";
import { markUnpaired } from "../src/client/data/pairing";
import { JobsRoute } from "../src/client/routes/JobsRoute";
import { QuotaCard, QuotaView } from "../src/client/routes/QuotaCard";
import { all, byText, mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(unmount);

const NOW = Date.now();

const QUOTA = {
	generatedAt: NOW,
	cacheAgeMs: 1000,
	cacheStale: false,
	source: "local usage records",
	providers: { "openai-codex": 1, anthropic: 1 },
	accounts: [
		{
			provider: "openai-codex",
			label: "me@example.com",
			state: "active",
			windows: [{ label: "5h", usedPercent: 97, resetsAt: NOW + 3_600_000, observedAt: NOW - 60_000, state: "ok", high: true }],
		},
		{
			provider: "anthropic",
			label: "work@example.com",
			state: "needs_login",
			windows: [{ label: "weekly", usedPercent: null, resetsAt: NOW - 1000, observedAt: NOW - 7_200_000, state: "stale", high: false }],
		},
	],
};

const JOBS = {
	now: NOW,
	jobs: [
		{ label: "com.example.daily", file: "com.example.daily.plist", readable: true, note: null, schedule: "daily 07:00", status: "ok", exit: "last exit ok", pid: null, lastLogWrite: NOW - 5_400_000 },
		{ label: "com.example.broken", file: "com.example.broken.plist", readable: false, note: "unreadable plist", schedule: null, status: "not loaded", exit: null, pid: null, lastLogWrite: null },
		{ label: "com.example.failing", file: "com.example.failing.plist", readable: true, note: null, schedule: "Mon 08:00", status: "failed", exit: "last exit 1", pid: null, lastLogWrite: NOW - 60_000 },
	],
	gaps: [{ start: NOW - 7_200_000, end: NOW - 6_000_000, alerted: false }],
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Pair screen", () => {
	it("shows the pairing steps while the hub does not auto-pair", async () => {
		const h = mount();
		await h.render(<PairScreen />);
		expect(text(h.container)).toContain("serve.py --pair");
		expect(h.container.querySelector(".pair-auto")).toBeNull();
	});

	it("asks to open the app itself when the hub auto-pairs, and keeps the link steps as a fallback", async () => {
		markUnpaired(true);
		const h = mount();
		await h.render(<PairScreen />);
		expect(h.container.querySelector(".pair-auto")).not.toBeNull();
		expect(text(h.container)).toContain("Home Screen icon");
		expect(byText(h.container, "button", "Try again")).toBeTruthy();
		const fallback = h.container.querySelector(".pair-fallback");
		expect(fallback?.textContent).toContain("serve.py --pair");
		expect(fallback?.querySelector("input[aria-label='Pairing link']")).not.toBeNull();
	});
});

describe("Quota card", () => {
	it("loads /api/hub/quota and shows it on a wide screen", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((async () => json(QUOTA)) as typeof fetch);
		const h = mount();
		await h.render(<QuotaCard active wide />);
		await settle();
		expect(fetchMock.mock.calls[0][0]).toBe("/api/hub/quota");
		expect(text(h.container)).toContain("97%");
	});

	it("is a compact always-open card on a wide screen, with stale shown as such", async () => {
		const h = mount();
		await h.render(<QuotaView data={QUOTA} wide />);
		const body = text(h.container);
		expect(h.container.querySelector("details")).toBeNull();
		expect(body).toContain("Codex");
		expect(body).toContain("97%");
		expect(body).toContain("Needs login");
		expect(body).toContain("stale");
		expect(body).toContain("Codex: one account, no backup");
		expect(body).toContain("local usage records");
	});

	it("is one collapsible row on a phone with the worst usage in the headline", async () => {
		const h = mount();
		await h.render(<QuotaView data={QUOTA} wide={false} />);
		const details = h.container.querySelector("details");
		expect(details).not.toBeNull();
		expect(details?.hasAttribute("open")).toBe(false);
		expect(details?.querySelector("summary")?.textContent).toContain("Codex 97% used");
	});

	it("ages readings on the real clock and says when the hub stopped refreshing", async () => {
		const h = mount();
		const [codex, ...rest] = QUOTA.accounts;
		const aged = { ...codex, windows: [{ ...codex.windows[0], observedAt: NOW - 3_660_000, resetsAt: NOW + 7_140_000 }] };
		const old = { ...QUOTA, accounts: [aged, ...rest], generatedAt: NOW - 3_600_000, cacheAgeMs: 3_600_000, cacheStale: true };
		await h.render(<QuotaView data={old} wide refreshError="HTTP error 500" />);
		const body = text(h.container);
		expect(body).toContain("has not refreshed these readings for 1h");
		expect(body).toContain("Could not refresh quota: HTTP error 500");
		// read 61 minutes ago on the real clock (it would say "1m" if ages ran from the collection time)
		expect(body).toContain("read 1h 1m ago");
	});

	it("renders nothing for an empty account list", async () => {
		const h = mount();
		await h.render(<QuotaView data={{ ...QUOTA, accounts: [] }} wide />);
		expect(h.container.querySelector(".quota-card")).toBeNull();
	});
});

describe("Jobs route", () => {
	it("lists failed jobs first, shows the unreadable plist row and the gap", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((async () => json(JOBS)) as typeof fetch);
		const h = mount();
		await h.render(<JobsRoute active />);
		await settle();
		expect(fetchMock.mock.calls[0][0]).toBe("/api/hub/jobs");
		const rows = all(h.container, ".job-row");
		expect(rows.map(r => r.querySelector(".job-label")?.textContent)).toEqual([
			"com.example.failing",
			"com.example.daily",
			"com.example.broken",
		]);
		const body = text(h.container);
		expect(body).toContain("Failed, exit 1");
		expect(body).toContain("unreadable plist");
		expect(body).toContain("last log write");
		expect(body).toContain("Monitoring gaps");
		expect(body).toContain("alert pending");
		expect(rows.map(r => r.textContent).join(" ")).not.toContain("last run");
	});
});

describe("pairing link bootstrap", () => {
	const savedHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
	const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	let faked = false;
	afterEach(() => {
		if (!faked) return;
		faked = false;
		if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (savedHistory) Object.defineProperty(globalThis, "history", savedHistory);
		else Reflect.deleteProperty(globalThis, "history");
	});

	function fakeLocation(hash: string) {
		faked = true;
		const calls = { reload: 0, replaced: [] as string[] };
		const location = {
			hash,
			pathname: "/",
			reload: () => {
				calls.reload++;
			},
		};
		Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { location } });
		Object.defineProperty(globalThis, "history", {
			configurable: true,
			writable: true,
			value: {
				replaceState: (_s: unknown, _t: string, url: string) => {
					calls.replaced.push(url);
					location.hash = url.slice(url.indexOf("#"));
				},
			},
		});
		return { calls, location };
	}

	it("does not reload after a refused cross-site #pair link, so no navigation can mint an auto cookie", async () => {
		const { redeemPairingLink } = await import("../src/client/data/pairing");
		const { calls, location } = fakeLocation("#pair=AAAAAAAAAAAAAAAAAAAA");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((async () => json({ error: "pairing link was already used or expired" }, 403)) as typeof fetch);
		let rendered = 0;
		expect(redeemPairingLink(() => rendered++)).toBe(true);
		await Bun.sleep(20);
		expect(fetchMock.mock.calls).toHaveLength(1);
		expect(calls.reload).toBe(0);
		expect(rendered).toBe(1); // the app renders in place
		expect(calls.replaced).toEqual(["/#/sessions"]);
		expect(location.hash).toBe("#/sessions"); // the fragment is gone
		expect(fetchMock.mock.calls).toHaveLength(1); // and nothing else was requested
	});

	it("shows the refusal on the Pair screen", async () => {
		const h = mount();
		await h.render(<PairScreen />);
		expect(text(h.container)).toContain("already used or expired");
	});

	it("reloads once, and only after the hub accepted the token", async () => {
		const { redeemPairingLink } = await import("../src/client/data/pairing");
		const { calls } = fakeLocation("#pair=BBBBBBBBBBBBBBBBBBBB");
		vi.spyOn(globalThis, "fetch").mockImplementation((async () => json({ ok: true })) as typeof fetch);
		let rendered = 0;
		redeemPairingLink(() => rendered++);
		expect(calls.reload).toBe(0); // not before the answer
		await Bun.sleep(20);
		expect(calls.reload).toBe(1);
		expect(rendered).toBe(0);
	});

	it("does nothing when the location holds no token", async () => {
		const { redeemPairingLink } = await import("../src/client/data/pairing");
		const { calls } = fakeLocation("#/sessions");
		const fetchMock = vi.spyOn(globalThis, "fetch");
		expect(redeemPairingLink()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(calls.reload).toBe(0);
	});
});
