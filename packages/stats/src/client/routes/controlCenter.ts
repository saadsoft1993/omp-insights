/**
 * Shared contract for the Control center screens (delivery, aws, sms).
 *
 * App.tsx renders each screen with these props. `sub` is the path after the
 * section (`#/sms/board` → "board"); `params` are the screen's own query
 * parameters from the hash, excluding the dashboard's reserved keys
 * (`range`, `s`, `m`, `tm`). `setParams` merges: a `null` value removes a key.
 * All setters replace the current history entry rather than pushing one.
 */
export interface ControlCenterRouteProps {
	active: boolean;
	sub: string | null;
	params: Readonly<Record<string, string>>;
	setParams: (patch: Record<string, string | null>) => void;
	setSub: (sub: string | null) => void;
	setControl: (update: { sub: string | null; params: Record<string, string | null> }) => void;
}

/** One entry of GET /api/hub/reports. */
export interface HubReportInfo {
	id: string;
	/** Configured part names (e.g. "details", "envs"). */
	parts: string[];
	pdf: boolean;
	/** Data file mtime in epoch milliseconds, or null when the file is not built yet. */
	mtime: number | null;
}
