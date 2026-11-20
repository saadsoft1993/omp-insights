import { afterEach, expect, test, vi } from "bun:test";
import { act } from "react";
import { detectHub, resetHubForTests, useHubPresent } from "../src/client/data/hub-presence";
import { resetPairingForTests, useUnpaired } from "../src/client/data/pairing";
import { shortcutSection } from "../src/client/app/nav";
import { installGlobal, mount, text, unmount } from "./helpers/memory-dom";

afterEach(async () => {
	await unmount();
	resetHubForTests();
	resetPairingForTests();
	vi.restoreAllMocks();
});

test("a missing hub hides hub navigation and shortcuts", async () => {
	installGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
	const view = mount();
	function Presence() {
		return <span>{useHubPresent() ? "present" : "absent"}</span>;
	}
	await view.render(<Presence />);
	await act(async () => { await detectHub(); });
	expect(text(view.container)).toBe("absent");
	expect(shortcutSection("n", true, false)).toBeUndefined();
	expect(shortcutSection("o", false, false)).toBe("overview");
});

test.each([
	["200", () => Promise.resolve(new Response(null, { status: 200 })), false],
	["401", () => Promise.resolve(new Response(null, { status: 401 })), true],
	["network error", () => Promise.reject(new TypeError("network error")), false],
	["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError")), false],
])("%s keeps the hub present", async (_name, answer, unpaired) => {
	installGlobal("fetch", vi.fn(answer));
	const view = mount();
	function Presence() {
		return <span>{`${useHubPresent() ? "present" : "absent"}:${useUnpaired()}`}</span>;
	}
	await view.render(<Presence />);
	await act(async () => {
		await detectHub();
	});
	expect(text(view.container)).toBe(`present:${unpaired}`);
});
