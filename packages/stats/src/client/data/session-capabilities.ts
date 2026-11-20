/**
 * Which Sessions-page actions a machine's hub and a session's plugin can do. Every hint names the machine, because
 * under All machines each row talks to its own machine's hub.
 */
import { ApiError } from "../api";
import { getHubVersion, type HubCapability, type HubVersion } from "./hub";
import { useQuery } from "./query";

/** What each hub capability lets the page do, for the "update the hub" hint. */
const CAPABILITY_ACTION: Record<HubCapability, string> = {
	askAnswer: "answer questions from here",
	sessionMessage: "send messages from here",
	planNotes: "approve a plan with notes",
	sessionGoal: "see the goal's objective",
	sessionInstructions: "list the session's instruction files",
	liveCost: "show cost so far and last activity",
};

/** The hub's capability state: `unknown` while its version is loading or could not be read. */
export type CapabilityState = "on" | "off" | "unknown";

export function capabilityState(version: HubVersion | null | undefined, capability: HubCapability): CapabilityState {
	if (!version) return "unknown";
	return version.capabilities?.[capability] === true ? "on" : "off";
}

export function updateHubHint(machineName: string, capability: HubCapability): string {
	return `Update the hub on ${machineName} to ${CAPABILITY_ACTION[capability]}.`;
}

/** The session runs an older session-control plugin (or omp) than the action needs. */
export function updatePluginHint(machineName: string, action: string): string {
	return `Update the session plugin on ${machineName} and restart this session to ${action}.`;
}

/** The hub refused because the session's plugin lacks the operation (`restart_needed`, or `unsupported` from omp). */
export function isPluginTooOld(error: unknown): boolean {
	return error instanceof ApiError && (error.code === "restart_needed" || error.code === "unsupported");
}

/** How long the drawer waits for a machine's hub to say what it can do before it shows an error with Try again. */
export const CAPABILITY_TIMEOUT_MS = 5000;

/**
 * Run `request` with `signal`, also aborted after `ms`. The timeout rejects with a plain message naming the wait, so a
 * slow machine ends in an error the page can show, never an endless wait.
 */
export async function withTimeout<T>(
	ms: number,
	signal: AbortSignal | undefined,
	request: (signal: AbortSignal) => Promise<T>,
	what: string,
): Promise<T> {
	const timeout = AbortSignal.timeout(ms);
	try {
		return await request(signal ? AbortSignal.any([signal, timeout]) : timeout);
	} catch (error) {
		if (timeout.aborted && !signal?.aborted)
			throw new Error(`${what} did not answer within ${Math.round(ms / 1000)} s.`);
		throw error;
	}
}

/**
 * One machine's hub version, cached per machine and shared by every panel of the drawer (one request per machine);
 * the hub answers it for itself (`/m/<machine>/api/hub/version`). It gives up after {@link CAPABILITY_TIMEOUT_MS}.
 */
export function useHubVersion(machine: string | undefined, enabled: boolean) {
	return useQuery(
		["hub-version", machine ?? ""],
		({ signal }) => withTimeout(CAPABILITY_TIMEOUT_MS, signal, timed => getHubVersion(timed, machine), "The hub"),
		// Capability metadata, not the page's numbers: it doesn't count toward "refreshes every …".
		{ enabled, scope: "local", pollMs: 60_000, countsAsPagePolling: false },
	);
}

/** What panels show while a hub's capabilities are missing: the check's error, if it failed, and a retry. */
export interface CapabilityCheck {
	error: string | null;
	retry: () => void;
	/** The machine can't be asked at all (it is unreachable): said instead of "Checking…", with nothing to retry. */
	unavailable?: string | null;
}
