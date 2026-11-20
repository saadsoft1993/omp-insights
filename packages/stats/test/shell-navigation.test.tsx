import { afterEach, expect, test, vi } from "bun:test";
import { act } from "react";
import { Shell } from "../src/client/app/Shell";
import { parseMachines, resetFleetForTests, setFleet } from "../src/client/app/machine";
import { detectHub, resetHubForTests } from "../src/client/data/hub-presence";
import { clearQueryCache } from "../src/client/data/query-store";
import { NAV, type DashboardSection } from "../src/client/app/nav";
import { click, installGlobal, mount, settle, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	resetFleetForTests();
	resetHubForTests();
	clearQueryCache();
});

function setup(fleet: boolean) {
	const h = mount();
	const values = new Map<string, string>();
	installGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	Object.defineProperty(window, "scrollTo", { configurable: true, value: () => {} });
	vi.spyOn(globalThis, "fetch").mockImplementation(
		(async () => new Response("error", { status: 500 })) as typeof fetch,
	);
	setFleet(fleet ? parseMachines([{ id: "server", name: "Server", self: true }]) : null);
	return { h, values };
}

function shell(section: DashboardSection, onSectionChange: (section: DashboardSection) => void) {
	return (
		<Shell
			section={section}
			onSectionChange={onSectionChange}
			range="24h"
			onRangeChange={() => {}}
		>
			Content
		</Shell>
	);
}

async function press(key: string) {
	await act(async () => {
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: key });
		window.dispatchEvent(event);
	});
}

for (const fleet of [false, true]) {
	test(`G shortcuts navigate every available page (fleet=${fleet})`, async () => {
		const { h } = setup(fleet);
		const navigate = vi.fn();
		await h.render(shell("overview", navigate));
		for (const item of NAV.flatMap(group => group.items)) {
			if (!item.hotkey) continue;
			navigate.mockClear();
			await press("g");
			await press(item.hotkey);
			if (item.fleetOnly && !fleet) expect(navigate).not.toHaveBeenCalled();
			else expect(navigate).toHaveBeenCalledWith(item.id);
		}
	});
}

test("the header supports narrow screens without hiding the machine label from readers", async () => {
	const { h } = setup(true);
	await h.render(shell("overview", () => {}));
	expect(h.container.querySelector("header.topbar")?.classList.contains("topbar-wrap-narrow")).toBe(true);
	expect(h.container.querySelector('button[aria-label="Machine"]')).not.toBeNull();
	expect(h.container.querySelector(".topbar-actions")?.classList.contains("topbar-actions-narrow")).toBe(true);
});

test("navigation labels keep their full title and may wrap instead of truncating (D23)", async () => {
	const { h } = setup(false);
	await h.render(shell("accounts", () => {}));
	const label = Array.from(h.container.querySelectorAll(".nav-row-label")).find(
		node => node.textContent === "Accounts & quota",
	) as HTMLElement;
	expect(label.getAttribute("title")).toBe("Accounts & quota");
	expect(label.getAttribute("style")).toBeNull();
});

test("Settings persists its disclosure state and expands for the current section", async () => {
	const { h, values } = setup(false);
	await h.render(shell("overview", () => {}));
	const button = h.container.querySelector(".nav-settings-toggle");
	expect(button?.getAttribute("aria-expanded")).toBe("false");
	await click(button);
	expect(values.get("omp.nav.settings")).toBe("open");
	await h.render(shell("overview", () => {}));
	expect(button?.getAttribute("aria-expanded")).toBe("true");
	await h.render(null);
	await h.render(shell("overview", () => {}));
	const restored = h.container.querySelector(".nav-settings-toggle");
	expect(restored?.getAttribute("aria-expanded")).toBe("true");
	await click(restored);
	expect(values.get("omp.nav.settings")).toBe("closed");
	await h.render(shell("relay", () => {}));
	expect(restored?.getAttribute("aria-expanded")).toBe("true");
});

test("machine selector opens on every page and Escape closes it", async () => {
	const { h } = setup(true);
	for (const section of ["overview", "machines"] as const) {
		await h.render(shell(section, () => {}));
		const button = h.container.querySelector('button[aria-label="Machine"]');
		expect(button).not.toBeNull();
		await click(button);
		expect(button?.getAttribute("aria-expanded")).toBe("true");
		const list = h.container.querySelector('[role="listbox"]');
		await act(async () => {
			const event = new Event("keydown", { bubbles: true });
			Object.defineProperty(event, "key", { value: "Escape" });
			list?.dispatchEvent(event);
		});
		expect(button?.getAttribute("aria-expanded")).toBe("false");
	}
});

test("hub-only groups and shortcuts follow hub presence", async () => {
	const { h } = setup(false);
	const navigate = vi.fn();
	await h.render(shell("overview", navigate));
	expect(h.container.textContent).toContain("Control");
	expect(h.container.textContent).toContain("Settings");
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
	await act(async () => {
		await detectHub();
	});
	expect(h.container.textContent).not.toContain("Control");
	expect(h.container.textContent).not.toContain("Settings");
	for (const heading of ["Usage", "Activity", "Insights"]) expect(h.container.textContent).toContain(heading);
	await press("g");
	await press("n");
	expect(navigate).not.toHaveBeenCalled();
});

test("control center availability follows hub reports", async () => {
	const { h } = setup(false);
	vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
		if (String(input).includes("/api/hub/reports")) return Response.json({ reports: [{ id: "delivery" }] });
		return new Response(null, { status: 404 });
	});
	await h.render(shell("overview", () => {}));
	await settle();
	expect(h.container.querySelector(".sidebar")?.textContent).toContain("Delivery analytics");
	expect(h.container.querySelector(".sidebar")?.textContent).not.toContain("AWS costs");
});
