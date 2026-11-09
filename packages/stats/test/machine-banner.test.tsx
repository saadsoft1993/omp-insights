import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MachineBanner } from "../src/client/app/MachineBanner";
import { machineHue, machineView } from "../src/client/app/machine";

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;

function installGlobal(name: string, value: unknown): void {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function mount(): { root: Root; container: Element } {
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	installGlobal("window", domWindow);
	installGlobal("document", domWindow.document);
	installGlobal("navigator", domWindow.navigator);
	installGlobal("Node", domWindow.Node);
	installGlobal("Element", domWindow.Element);
	installGlobal("HTMLElement", domWindow.HTMLElement);
	installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = domWindow.document.getElementById("root") as unknown as Element;
	root = createRoot(container);
	return { root, container };
}

afterEach(async () => {
	const active = root;
	if (active) {
		await act(async () => {
			active.unmount();
		});
		root = null;
	}
	vi.restoreAllMocks();
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
});

describe("machine view", () => {
	it("gives each Mac its own stable accent", () => {
		expect(machineHue("Dev Macbook")).toBe(machineHue("  dev macbook "));
		expect(machineHue("Dev Macbook")).not.toBe(machineHue("Dev Mac mini"));
		expect(machineView("Dev Macbook")?.accent).not.toBe(machineView("Dev Mac mini")?.accent);
	});

	it("spells out the scope and tidies the name", () => {
		const view = machineView("  Dev \n Mac  mini ");
		expect(view?.name).toBe("Dev Mac mini");
		expect(view?.label).toBe("Dev Mac mini: sessions on this Mac only");
	});

	it("has nothing to show without a name", () => {
		for (const missing of [undefined, null, "", "   "]) expect(machineView(missing)).toBeNull();
	});
});

describe("MachineBanner", () => {
	function stubFetch(respond: () => Response): void {
		installGlobal(
			"fetch",
			vi.fn(async () => respond()),
		);
	}

	// The query cache is module-global: the failing answer goes first so the cached name cannot leak into it.
	it("renders nothing when the hub has no machine endpoint or no name", async () => {
		stubFetch(() => Response.json({ error: "not found" }, { status: 404 }));
		const { root: view, container } = mount();
		await act(async () => view.render(<MachineBanner />));
		await act(async () => {
			await Bun.sleep(10);
		});
		expect(container.querySelector(".machine-banner") ?? null).toBeNull();
	});

	it("shows the machine name the hub reports", async () => {
		stubFetch(() => Response.json({ name: "Dev Mac mini" }));
		const { root: view, container } = mount();
		await act(async () => view.render(<MachineBanner />));
		await act(async () => {
			await Bun.sleep(10);
		});
		const chip = container.querySelector(".machine-banner");
		expect(chip?.textContent).toContain("Dev Mac mini");
		expect(chip?.textContent).toContain("sessions on this Mac only");
		expect(chip?.getAttribute("aria-label")).toBe("Dev Mac mini: sessions on this Mac only");
	});
});
