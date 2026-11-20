import { createContext, useContext } from "react";
import type { CapabilityCheck } from "../data/session-capabilities";

/**
 * The drawer's one capability check for the session's machine, shared by every panel that waits on it. Outside a
 * drawer (tests, other pages) there is no check to retry, so panels only say they are checking.
 */
export const CapabilityCheckContext = createContext<CapabilityCheck | null>(null);

/** "Checking what <machine>'s hub can do…" while the check runs; its error and Try again once it failed or timed out. */
export function CapabilityChecking({ machineName, inline = false }: { machineName: string; inline?: boolean }) {
	const check = useContext(CapabilityCheckContext);
	const Line = inline ? "span" : "p";
	const Row = inline ? "span" : "div";
	if (check?.unavailable) return <Line className="sd-hint">{check.unavailable}</Line>;
	if (!check?.error) return <Line className="sd-hint">Checking what {machineName}'s hub can do…</Line>;
	return (
		<Row className="sd-row">
			<Line className="sd-hint" data-tone="bad" role="alert">
				Could not check what {machineName}'s hub can do: {check.error}
			</Line>
			<button type="button" className="btn" data-size="sm" onClick={check.retry}>
				Try again
			</button>
		</Row>
	);
}
