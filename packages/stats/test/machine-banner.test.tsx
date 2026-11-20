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
		expect(machineHue("Ada Macbook")).toBe(machineHue("  ada macbook "));
		expect(machineHue("Ada Macbook")).not.toBe(machineHue("Ada Mac mini"));
		expect(machineView("Ada Macbook")?.accent).not.toBe(machineView("Ada Mac mini")?.accent);
	});

	it("spells out the scope and tidies the name", () => {
		const view = machineView("  Ada \n Mac  mini ");
		expect(view?.name).toBe("Ada Mac mini");
		expect(view?.label).toBe("Ada Mac mini: sessions on this Mac only");
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
		stubFetch(() => Response.json({ name: "Ada Mac mini" }));
		const { root: view, container } = mount();
		await act(async () => view.render(<MachineBanner />));
		await act(async () => {
			await Bun.sleep(10);
		});
		const chip = container.querySelector(".machine-banner");
		expect(chip?.textContent).toContain("Ada Mac mini");
		expect(chip?.textContent).toContain("sessions on this Mac only");
		expect(chip?.getAttribute("aria-label")).toBe("Ada Mac mini: sessions on this Mac only");
	});
});

it("shows missing aggregate machine names but no healthy strip", async () => {
	const { MissingMachineNumbers } = await import("../src/client/app/MachineBanner");
	const { root: view, container } = mount();
	await act(async () =>
		view.render(
			<MissingMachineNumbers
				machines={[{ id: "a", name: "Server", ok: true, error: null, stale: false, outdated: false }]}
			/>,
		),
	);
	expect(container.textContent).toBe("");
	await act(async () =>
		view.render(
			<MissingMachineNumbers
				machines={[
					{ id: "a", name: "Server", ok: true, error: null, stale: false, outdated: false },
					{ id: "b", name: "Mini", ok: false, error: "offline", stale: false, outdated: false },
				]}
			/>,
		),
	);
	expect(container.textContent).toContain("Mini");
	expect(container.textContent).toContain("Mini's stats didn't answer; numbers may be missing.");
	expect(container.textContent).not.toContain("offline");
	expect(container.querySelector(".missing-machines span")?.getAttribute("title")).toBe("Details: offline");
	// Every machine failed but nothing else lists the reasons: the banner stays (suppression is opt-in).
	const failed = [{ id: "b", name: "Mini", ok: false, error: "offline", stale: false, outdated: false }];
	await act(async () => view.render(<MissingMachineNumbers machines={failed} />));
	expect(container.textContent).toContain("Mini's stats didn't answer");
	// With a reason-owning all-failed view mounted, the banner steps aside and says it only once.
	const { AllMachinesFailed } = await import("../src/client/app/MachineBanner");
	await act(async () =>
		view.render(
			<>
				<MissingMachineNumbers machines={failed} />
				<p className="owner">
					<AllMachinesFailed machines={failed} />
				</p>
			</>,
		),
	);
	expect(container.querySelector(".missing-machines")).toBeNull();
	expect(container.querySelector(".owner")?.textContent).toContain("Mini's stats didn't answer");
	// Once the owner leaves, the banner is back.
	await act(async () => view.render(<MissingMachineNumbers machines={failed} />));
	expect(container.querySelector(".missing-machines")).not.toBeNull();
});

it("a hidden page's all-failed line doesn't hide the visible page's banner", async () => {
	const { AllMachinesFailed, MissingMachineNumbers } = await import("../src/client/app/MachineBanner");
	const { PageActiveContext } = await import("../src/client/data/page-active");
	const failed = [
		{ id: "b", name: "Mini", ok: false, error: "offline", stale: false, outdated: false, lastKnown: false },
	];
	const { root: view, container } = mount();
	const pages = (modelsVisible: boolean) => (
		<>
			<div className="models" hidden={!modelsVisible}>
				<PageActiveContext.Provider value={modelsVisible}>
					<AllMachinesFailed machines={failed} />
				</PageActiveContext.Provider>
			</div>
			<div className="history" hidden={modelsVisible}>
				<PageActiveContext.Provider value={!modelsVisible}>
					<MissingMachineNumbers machines={failed} />
				</PageActiveContext.Provider>
			</div>
		</>
	);
	// Models (kept mounted, hidden) shows its failed line; History is on screen: its banner stays.
	await act(async () => view.render(pages(false)));
	expect(container.querySelector(".history .missing-machines")).not.toBeNull();
	// Models on screen: its own line lists the reasons, so the (now hidden) History banner steps aside.
	await act(async () => view.render(pages(true)));
	expect(container.querySelector(".history .missing-machines")).toBeNull();
});
