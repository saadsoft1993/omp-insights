import { type RefObject, useLayoutEffect } from "react";

/** Space kept between a popover and the edge of what the user can see. */
const EDGE = 8;
/** Gap between the anchor cell and the popover. */
const GAP = 4;
/** Below this many pixels a popover is too cramped to use, so the page scrolls to give it room. */
const MIN_USABLE = 220;

export interface PopoverPlacement {
	side: "below" | "above";
	/** The tallest the popover may be on that side without leaving the visible area. */
	maxHeight: number;
}

/**
 * Where an anchored popover fits: below its anchor when its natural height fits there (or below has the
 * most room), otherwise above. `top`/`bottom` bound the visible area (under the top bar, above any sticky bar).
 */
export function placePopover(
	anchor: { top: number; bottom: number },
	natural: number,
	visible: { top: number; bottom: number },
): PopoverPlacement {
	const below = Math.floor(visible.bottom - anchor.bottom - GAP - EDGE);
	const above = Math.floor(anchor.top - visible.top - GAP - EDGE);
	if (natural <= below || below >= above) return { side: "below", maxHeight: Math.max(below, 0) };
	return { side: "above", maxHeight: Math.max(above, 0) };
}

function visibleArea(view: Window): { top: number; bottom: number } {
	const document = view.document;
	const topbar =
		Number.parseFloat(view.getComputedStyle(document.documentElement).getPropertyValue("--topbar-h")) || 0;
	let bottom = view.innerHeight;
	// The unsaved-changes bar sticks to the bottom of the viewport and would cover a popover's footer.
	const bar = document.querySelector(".mf-changebar")?.getBoundingClientRect();
	if (bar && bar.height > 0 && bar.top < bottom && bar.bottom > bottom - bar.height - 24) bottom = bar.top;
	return { top: topbar, bottom };
}

/**
 * Keeps an absolutely positioned popover inside the viewport: it flips above its anchor when there is
 * more room there, and caps its height so its own footer (Save / Cancel) is always on screen.
 * Popovers laid out in the flow (the phone layout) are left alone.
 */
export function usePopoverFit(ref: RefObject<HTMLElement | null>): void {
	useLayoutEffect(() => {
		const element = ref.current;
		const anchor = element?.parentElement;
		const view = element?.ownerDocument.defaultView;
		if (!element || !anchor || typeof view?.getComputedStyle !== "function") return;
		const fit = () => {
			element.removeAttribute("data-side");
			element.style.removeProperty("--mf-pop-max");
			if (view.getComputedStyle(element).position !== "absolute") return;
			const box = anchor.getBoundingClientRect();
			const placement = placePopover(box, element.scrollHeight, visibleArea(view));
			element.dataset.side = placement.side;
			element.style.setProperty("--mf-pop-max", `${Math.max(placement.maxHeight, MIN_USABLE)}px`);
			if (placement.maxHeight < MIN_USABLE) element.scrollIntoView?.({ block: "nearest" });
		};
		fit();
		view.addEventListener("resize", fit);
		return () => view.removeEventListener("resize", fit);
	}, [ref]);
}
