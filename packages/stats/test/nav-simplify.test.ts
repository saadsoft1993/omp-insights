import { describe, expect, test } from "bun:test";
import { NAV, SECTION_IDS, shortcutSection } from "../src/client/app/nav";

describe("dashboard navigation", () => {
	const items = NAV.flatMap(group => group.items);
	test("lists every section exactly once", () => {
		expect(items.map(item => item.id).sort()).toEqual([...SECTION_IDS].sort());
	});
	test("uses unique hotkeys and icons", () => {
		const hotkeys = items.flatMap(item => (item.hotkey ? [item.hotkey] : []));
		const icons = items.map(item => item.icon);
		expect(new Set(hotkeys).size).toBe(hotkeys.length);
		expect(new Set(icons).size).toBe(icons.length);
	});
	test("each available shortcut resolves in fleet and single-machine modes", () => {
		for (const item of items) {
			if (!item.hotkey) continue;
			expect(shortcutSection(item.hotkey, true)).toBe(item.id);
			expect(shortcutSection(item.hotkey, false)).toBe(item.fleetOnly ? undefined : item.id);
		}
	});
	test("keeps controls and machine settings in their groups", () => {
		expect(NAV.find(group => group.heading === "Control center")?.items.map(item => item.id)).toEqual([
			"delivery",
			"aws",
			"sms",
		]);
		expect(NAV.find(group => group.heading === "Control")?.items.map(item => item.id)).toEqual(
			expect.arrayContaining(["sessions", "history"]),
		);
		expect(NAV.find(group => group.heading === "Settings")?.items.map(item => item.id)).toEqual([
			"relay",
			"alerts",
			"jobs",
			"devices",
			"flow",
			"machines",
		]);
	});
});
