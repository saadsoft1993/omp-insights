import { createContext, useContext } from "react";

/**
 * Whether the page this component belongs to is the one on screen. Visited pages stay mounted (hidden) so revisits
 * are instant; anything that speaks for "the page" (polling, a reason-owning failed line) must count only on the
 * visible one. Outside a page (the top bar, tests) it is true.
 */
export const PageActiveContext = createContext(true);

export function usePageActive(): boolean {
	return useContext(PageActiveContext);
}
