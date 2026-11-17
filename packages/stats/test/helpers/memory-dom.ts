/** A tiny DOM harness for the Memory page tests: the repo's light DOM, React `act`, and a few event helpers. */
import { vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

export function installGlobal(name: string, value: unknown): void {
	if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

export interface Harness {
	root: Root;
	container: Element;
	body: Element;
	render: (node: ReactNode) => Promise<void>;
}

let active: Root | null = null;

export function mount(): Harness {
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	for (const name of [
		"window",
		"document",
		"navigator",
		"Node",
		"Element",
		"HTMLElement",
		"SVGElement",
		"Event",
		"KeyboardEvent",
	]) {
		const value =
			name === "window"
				? domWindow
				: name === "document"
					? domWindow.document
					: (domWindow as unknown as Record<string, unknown>)[name];
		if (value !== undefined) installGlobal(name, value);
	}
	installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	installGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	// React's text-input change path for a DOM that was absent when react-dom loaded (see `type`) watches IE-style events.
	const proto = (domWindow.Element as unknown as { prototype: Record<string, unknown> }).prototype;
	proto.attachEvent = () => {};
	proto.detachEvent = () => {};
	supportSelects(domWindow.document);
	const container = domWindow.document.getElementById("root") as unknown as Element;
	const root = createRoot(container);
	active = root;
	return {
		root,
		container,
		body: domWindow.document.body as unknown as Element,
		render: node =>
			act(async () => {
				root.render(node);
			}),
	};
}

/**
 * The light DOM has no `<select>.options`, which React reads when it sets a select's value. Give each select one.
 */
function supportSelects(doc: { createElement: (tag: string) => unknown }): void {
	const create = doc.createElement.bind(doc);
	doc.createElement = (tag: string) => {
		const el = create(tag) as { querySelectorAll: (selector: string) => ArrayLike<unknown> };
		if (tag.toLowerCase() === "select") {
			Object.defineProperty(el, "options", { get: () => Array.from(el.querySelectorAll("option")) });
		}
		return el;
	};
}

export async function unmount(): Promise<void> {
	const root = active;
	active = null;
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	vi.restoreAllMocks();
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
}

/** Let pending promises and timers (up to `ms`) run inside `act`. */
export function settle(ms = 20): Promise<void> {
	return act(async () => {
		await Bun.sleep(ms);
	});
}

export function click(el: Element | null | undefined): Promise<void> {
	if (!el) throw new Error("click: element not found");
	return act(async () => {
		el.dispatchEvent(
			new (globalThis.window as unknown as { Event: typeof Event }).Event("click", {
				bubbles: true,
				cancelable: true,
			}),
		);
	});
}

/**
 * Set a controlled input/textarea/select value the way a user's typing would, raising every event either of
 * React's change paths listens to.
 */
export function type(el: Element | null | undefined, value: string): Promise<void> {
	if (!el) throw new Error("type: element not found");
	const node = el as unknown as { value: string; _valueTracker?: { setValue: (v: string) => void } };
	return act(async () => {
		const previous = node.value;
		node.value = value;
		node._valueTracker?.setValue(previous);
		const win = globalThis.window as unknown as { Event: typeof Event };
		const fire = (name: string) => el.dispatchEvent(new win.Event(name, { bubbles: true }));
		// react-dom decides at load time whether `input` events exist; without a DOM then it listens to focus + keyup instead.
		fire("focusin");
		fire("input");
		fire("keyup");
		fire("change");
	});
}

/** The value React last rendered into a controlled field (the light DOM does not mirror it onto `.value`). */
export function valueOf(el: Element | null | undefined): string {
	if (!el) throw new Error("valueOf: element not found");
	const key = Object.keys(el).find(k => k.startsWith("__reactProps$"));
	const props = key ? ((el as unknown as Record<string, { value?: unknown }>)[key] ?? {}) : {};
	return typeof props.value === "string" ? props.value : ((el as unknown as { value: string }).value ?? "");
}

export function isDisabled(el: Element | null | undefined): boolean {
	if (!el) throw new Error("isDisabled: element not found");
	return el.hasAttribute("disabled");
}

export function keydown(el: Element | Window, key: string): Promise<void> {
	return act(async () => {
		const win = globalThis.window as unknown as { Event: typeof Event };
		const event = new win.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key });
		el.dispatchEvent(event);
	});
}

export function all(root: Element, selector: string): Element[] {
	return [...root.querySelectorAll(selector)];
}

/** First element matching `selector` whose text contains `text`. */
export function byText(root: Element, selector: string, text: string): Element | null {
	return all(root, selector).find(el => (el.textContent ?? "").includes(text)) ?? null;
}

export function text(root: Element): string {
	return (root.textContent ?? "").replace(/\s+/g, " ").trim();
}
