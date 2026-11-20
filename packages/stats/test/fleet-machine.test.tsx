import { concreteMachine, getFleet } from "../src/client/app/machine";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getOverviewStats, requestSync } from "../src/client/api";
import {
	detectFleet,
	fleetListProblem,
	machineKey,
	machinePath,
	machinePrefix,
	parseMachines,
	reloadSelection,
	resetFleetForTests,
	selection,
	selectMachine,
	setFleet,
} from "../src/client/app/machine";
import {
	getHubLink,
	getHubRelay,
	getHubJobs,
	getHubQuota,
	getHubSessions,
	killHubSession,
	sendSessionKeys,
	startHubSession,
	stopHubSession,
} from "../src/client/data/hub";
import { LiveProvider } from "../src/client/data/live";
import { type QueryResult, useQuery } from "../src/client/data/query";
import { clearQueryCache } from "../src/client/data/query-store";
import { useHashRoute } from "../src/client/data/useHashRoute";

const FLEET = [
	{ id: "server", name: "Ada Server", self: true, ok: true },
	{ id: "macbook", name: "Ada MacBook", self: false, ok: true, dashboardUrl: "https://mb.example:8794/" },
	{ id: "mini", name: "Ada Mac mini", self: false, ok: false },
];

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;

function installGlobal(name: string, value: unknown): void {
	if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function mount(): Root {
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	installGlobal("window", domWindow);
	installGlobal("document", domWindow.document);
	installGlobal("navigator", domWindow.navigator);
	installGlobal("Node", domWindow.Node);
	installGlobal("Element", domWindow.Element);
	installGlobal("HTMLElement", domWindow.HTMLElement);
	installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = domWindow.document.getElementById("root");
	if (!container) throw new Error("Expected test root");
	root = createRoot(container as unknown as Element);
	return root;
}

function fleetOf(...ids: string[]) {
	return parseMachines(FLEET.filter(m => ids.includes(m.id)));
}

function stubFetch(): string[] {
	const calls: string[] = [];
	installGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			calls.push(String(input));
			return Response.json({});
		}),
	);
	return calls;
}

afterEach(async () => {
	const active = root;
	if (active) {
		await act(async () => active.unmount());
		root = null;
	}
	vi.restoreAllMocks();
	resetFleetForTests();
	clearQueryCache();
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
});

describe("machinePrefix", () => {
	it("is empty without a fleet, whatever the id", () => {
		expect(machinePrefix()).toBe("");
		expect(machinePrefix("macbook")).toBe("");
		expect(machinePath("/api/events", undefined)).toBe("/api/events");
	});

	it("is /m/<id> in fleet mode and empty for an undefined id", () => {
		setFleet(fleetOf("server", "macbook"));
		expect(machinePrefix("macbook")).toBe("/m/macbook");
		expect(machinePrefix(undefined)).toBe("");
		expect(machinePath("/api/events", "macbook")).toBe("/m/macbook/api/events");
	});
});

describe("fleet detection", () => {
	it("accepts a list with a self entry and rejects anything else", () => {
		expect(fleetOf("server", "macbook")?.map(m => m.id)).toEqual(["server", "macbook"]);
		expect(parseMachines({ machines: FLEET })?.length).toBe(3);
		expect(parseMachines({ error: "not found" })).toBeNull();
		expect(parseMachines([])).toBeNull();
		expect(parseMachines({ machines: [], self: null })).toBeNull();
		expect(
			parseMachines({
				machines: [
					{ id: "server", self: true, version: { commit: "0123456789abcdef", dirty: true, startedAt: 1 } },
				],
			})?.[0].version,
		).toBe("01234567+");
		expect(parseMachines(fleetOf("macbook"))).toBeNull();
		expect(parseMachines([{ id: "Bad Id", self: true }])).toBeNull();
	});

	it("404 means single-machine mode; a network error keeps the known fleet", async () => {
		installGlobal(
			"fetch",
			vi.fn(async () => Response.json(FLEET)),
		);
		await detectFleet();
		expect(selection()).toBe("*");
		installGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		await detectFleet();
		expect(selection()).toBe("*");
		installGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: "not found" }, { status: 404 })),
		);
		await detectFleet();
		expect(selection()).toBeUndefined();
	});

	it("defaults to self, honours a stored choice that is in the fleet, and drops one that is not", () => {
		setFleet(fleetOf("server", "macbook"));
		expect(selection()).toBe("*");
		selectMachine("macbook");
		expect(selection()).toBe("macbook");
		setFleet(fleetOf("server"));
		expect(selection()).toBe("server");
	});
});

describe("dashboardUrl", () => {
	const urlOf = (dashboardUrl: unknown) =>
		parseMachines([{ id: "server", self: true, dashboardUrl }])?.[0].dashboardUrl;

	it("accepts only absolute https URLs", () => {
		expect(urlOf("https://mb.example:8794/")).toBe("https://mb.example:8794/");
		expect(urlOf("http://mb.example:8794/")).toBeNull();
		expect(urlOf("javascript:alert(1)")).toBeNull();
		expect(urlOf("data:text/html,<b>x</b>")).toBeNull();
		expect(urlOf("/relative/path")).toBeNull();
		expect(urlOf("//mb.example/")).toBeNull();
		expect(urlOf(42)).toBeNull();
	});
});

describe("machineKey", () => {
	it("appends the machine so keys of two machines differ and bucket routing by first element stays", () => {
		expect(machineKey(["trace", "f"], undefined)).toEqual(["trace", "f"]);
		const a = machineKey(["trace", "f"], "macbook");
		const b = machineKey(["trace", "f"], "mini");
		expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
		expect(JSON.stringify(a).startsWith('["trace",')).toBe(true);
	});
});

describe("prefixed transports", () => {
	it("never makes a per-machine request without a machine in all mode", async () => {
		setFleet(fleetOf("server", "macbook"));
		const calls = stubFetch();
		await expect(getOverviewStats("24h", undefined, concreteMachine())).rejects.toThrow("Pick a machine");
		await expect(getHubRelay("")).rejects.toThrow("Pick a machine");
		await expect(getHubQuota("")).rejects.toThrow("Pick a machine");
		await expect(getHubJobs("")).rejects.toThrow("Pick a machine");
		expect(calls).toEqual([]);
	});

	it("keeps a picker change in the hash when the range changes", async () => {
		setFleet(fleetOf("server", "mini"));
		const view = mount();
		const location = { hash: "#/jobs?m=mini" };
		Object.defineProperty(window, "location", { configurable: true, value: location });
		installGlobal("history", {
			replaceState: (_: unknown, __: string, hash: string) => {
				location.hash = hash;
			},
			pushState: (_: unknown, __: string, hash: string) => {
				location.hash = hash;
			},
		});
		let changeRange: ((value: "7d") => void) | undefined;
		function Probe() {
			changeRange = useHashRoute().setRange;
			return null;
		}
		await act(async () => view.render(<Probe />));
		await act(async () => selectMachine("server"));
		await act(async () => changeRange?.("7d"));
		expect(location.hash).toContain("m=server");
		expect(location.hash).toContain("range=7d");
	});
	it("leaves every path alone in single-machine mode", async () => {
		const calls = stubFetch();
		await getOverviewStats(
			"24h",
			undefined,
			concreteMachine() ?? getFleet()?.find(machine => machine.self)?.id,
		).catch(() => {});
		await getHubQuota(concreteMachine() ?? "").catch(() => {});
		await stopHubSession("s1").catch(() => {});
		expect(calls).toEqual(["/api/stats/overview?range=24h", "/api/hub/quota", "/api/hub/sessions/s1/stop"]);
	});

	it("prefixes stats and hub calls with the selected machine", async () => {
		setFleet(fleetOf("server", "macbook"));
		selectMachine("macbook");
		const calls = stubFetch();
		await getOverviewStats(
			"24h",
			undefined,
			concreteMachine() ?? getFleet()?.find(machine => machine.self)?.id,
		).catch(() => {});
		await requestSync(concreteMachine() ?? getFleet()?.find(machine => machine.self)?.id).catch(() => {});
		await getHubQuota(concreteMachine() ?? "").catch(() => {});
		expect(calls).toEqual([
			"/m/macbook/api/stats/overview?range=24h",
			"/m/macbook/api/sync",
			"/m/macbook/api/hub/quota",
		]);
	});

	it("sends session actions to the row's machine, not the selected one", async () => {
		setFleet(fleetOf("server", "macbook"));
		selectMachine("server");
		const calls = stubFetch();
		await stopHubSession("s1", "macbook").catch(() => {});
		await killHubSession("s1", "name", "macbook").catch(() => {});
		await sendSessionKeys("s1", { requestId: "r", keys: ["enter"] }, "macbook").catch(() => {});
		await getHubLink("i1", false, "macbook").catch(() => {});
		await startHubSession("/p", "macbook").catch(() => {});
		await getHubSessions().catch(() => {});
		expect(calls).toEqual([
			"/m/macbook/api/hub/sessions/s1/stop",
			"/m/macbook/api/hub/sessions/s1/kill",
			"/m/macbook/api/hub/sessions/s1/keys",
			"/m/macbook/api/hub/link",
			"/m/macbook/api/hub/start",
			"/api/hub/sessions",
		]);
	});

	it("opens the event stream of the selected machine and reopens it when the selection changes", async () => {
		setFleet(fleetOf("server", "macbook"));
		selectMachine("server");
		const urls: string[] = [];
		const closed: string[] = [];
		class FakeEventSource {
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onmessage: (() => void) | null = null;
			constructor(readonly url: string) {
				urls.push(url);
			}
			close() {
				closed.push(this.url);
			}
		}
		installGlobal("EventSource", FakeEventSource);
		const view = mount();
		await act(async () => view.render(<LiveProvider>{null}</LiveProvider>));
		expect(urls).toEqual(["/m/server/api/events"]);
		await act(async () => selectMachine("macbook"));
		expect(urls).toEqual(["/m/server/api/events", "/m/macbook/api/events"]);
		expect(closed).toEqual(["/m/server/api/events"]);
	});

	it("polls versions without opening an event stream in all-machines mode", async () => {
		setFleet(fleetOf("server", "macbook", "mini"));
		const calls = stubFetch();
		const urls: string[] = [];
		class FakeEventSource {
			constructor(url: string) {
				urls.push(url);
			}
		}
		installGlobal("EventSource", FakeEventSource);
		const view = mount();
		await act(async () => view.render(<LiveProvider>{null}</LiveProvider>));
		expect(urls).toEqual([]);
		expect(calls).toContain("/api/hub/stats-versions");
	});

	for (const [saved, hash, expected] of [
		["server", "#/models?range=24h&m=*", "*"],
		["server", "#/models?range=24h&m=unknown", "*"],
		["unknown", "#/models?range=24h", "*"],
		["server", "#/models?range=24h&m=server", "server"],
	] as const) {
		it(`boots with persisted ${saved} and route ${hash}`, async () => {
			const urls: string[] = [];
			class FakeEventSource {
				constructor(url: string) {
					urls.push(url);
				}
				close() {}
			}
			installGlobal("EventSource", FakeEventSource);
			installGlobal("localStorage", { getItem: () => saved, setItem: () => {} });
			installGlobal("history", { replaceState: () => {}, pushState: () => {} });
			stubFetch();
			const view = mount();
			Object.defineProperty(window, "location", { configurable: true, value: { hash } });
			reloadSelection();
			setFleet(fleetOf("server", "macbook"));
			function Route() {
				useHashRoute();
				return <div>Dashboard ready</div>;
			}
			await act(async () =>
				view.render(
					<LiveProvider>
						<Route />
					</LiveProvider>,
				),
			);
			expect(document.body.textContent).toContain("Dashboard ready");
			expect(selection()).toBe(expected);
			expect(urls).toEqual(expected === "*" ? [] : ["/m/server/api/events"]);
		});
	}
});

describe("per-machine query cache", () => {
	function Probe({ onResult }: { onResult: (r: QueryResult<string>) => void }) {
		const result = useQuery(["fleet-probe"], async () => `from ${selection()}`);
		onResult(result);
		return null;
	}

	it("never shows one machine's data under another", async () => {
		setFleet(fleetOf("server", "macbook"));
		selectMachine("server");
		const seen: Array<string | null> = [];
		const view = mount();
		const render = () =>
			act(async () => {
				view.render(<Probe onResult={r => seen.push(r.data)} />);
				await Bun.sleep(5);
			});
		await render();
		expect(seen.at(-1)).toBe("from server");

		seen.length = 0;
		await act(async () => selectMachine("macbook"));
		await act(async () => Bun.sleep(5));
		// The first render after the switch has nothing, not the previous machine's answer.
		expect(seen[0]).toBeNull();
		expect(seen.at(-1)).toBe("from macbook");

		// Back to the first machine: served from its own cache entry at once.
		seen.length = 0;
		await act(async () => selectMachine("server"));
		expect(seen[0]).toBe("from server");
	});
});

describe("machine list refresh never loses the fleet to an abort", () => {
	function bodyThatAborts(controller: AbortController): Response {
		const stream = new ReadableStream<Uint8Array>({
			start(sink) {
				sink.enqueue(new TextEncoder().encode('{"machines":[{"id":"server","self":true}'));
				controller.signal.addEventListener("abort", () =>
					sink.error(new DOMException("The operation was aborted.", "AbortError")),
				);
			},
		});
		return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
	}

	it("an abort mid-body keeps the known fleet and notes no problem", async () => {
		setFleet(fleetOf("server", "macbook"));
		const controller = new AbortController();
		installGlobal(
			"fetch",
			vi.fn(async () => bodyThatAborts(controller)),
		);
		const pending = detectFleet(controller.signal);
		controller.abort();
		await pending;
		expect(getFleet()?.map(m => m.id)).toEqual(["server", "macbook"]);
		expect(selection()).toBe("*");
		expect(fleetListProblem()).toBeNull();
	});

	it("a timeout keeps the known fleet", async () => {
		setFleet(fleetOf("server", "macbook"));
		installGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			}),
		);
		await detectFleet(AbortSignal.timeout(1));
		expect(getFleet()?.map(m => m.id)).toEqual(["server", "macbook"]);
		expect(fleetListProblem()).toBeNull();
	});

	it("an unreadable body keeps the known fleet and notes the problem", async () => {
		setFleet(fleetOf("server", "macbook"));
		installGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })),
		);
		await detectFleet();
		expect(getFleet()?.map(m => m.id)).toEqual(["server", "macbook"]);
		expect(fleetListProblem()).toBe("the machine list came back unreadable");
	});

	it("a valid answer replaces the fleet and clears the problem", async () => {
		setFleet(fleetOf("server", "macbook"));
		installGlobal(
			"fetch",
			vi.fn(async () => new Response("not json", { status: 200 })),
		);
		await detectFleet();
		expect(fleetListProblem()).not.toBeNull();
		installGlobal(
			"fetch",
			vi.fn(async () => Response.json(fleetOf("server", "mini"))),
		);
		await detectFleet();
		expect(getFleet()?.map(m => m.id)).toEqual(["server", "mini"]);
		expect(fleetListProblem()).toBeNull();
	});
});
