/**
 * Live traffic: which sessions are sending requests to which account right now.
 *
 * Built from the raw `messages` rows of the last five minutes. Requests are
 * logged when they complete, so every rate here counts completed requests: a
 * long request in flight shows up only when it finishes. Sessions are root
 * transcripts; a subagent or advisor transcript counts as its parent session.
 * Targets are the merged accounts of the Accounts page, the API-key gateways
 * configured in the profile's models.yml (shown even when idle), and per
 * provider the requests whose session log names no account, split into
 * housekeeping calls (`model_usage` entries, by purpose) and ordinary turns.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { LiveRequestRow } from "./db";
import type {
	AccountStats,
	LiveAgent,
	LiveAgentStatus,
	LiveEdge,
	LiveRequest,
	LiveSession,
	LiveTarget,
	LiveTargetState,
	LiveToolActivity,
	LiveTrafficStats,
} from "./shared-types";
import { basenameTimestamp, type SessionMetadata } from "./trace";
import type { TranscriptActivityRow } from "./transcript-activity";

/** A target or session is active when it completed a request this recently. */
export const LIVE_WINDOW_MS = 60_000;
/** Sessions, lines and the request table cover this window; older traffic is not shown. */
export const FLOW_WINDOW_MS = 5 * 60_000;
/** A quota window at or above this used fraction earns a warning badge. */
export const QUOTA_WARNING_FRACTION = 0.95;
const RECENT_LIMIT = 25;
/** Rows timestamped this far ahead of the clock are skew; further ahead they are dropped as bogus. */
const FUTURE_TOLERANCE_MS = 60_000;
/** An agent with no exit recorded that has written nothing for this long is shown as stopped ("no activity"). */
export const AGENT_SILENT_MS = 15 * 60_000;
/** Agents that finished or are waiting stay listed this long after their last entry. */
export const AGENT_RECENT_MS = 10 * 60_000;
/** Stopped agents stay listed for one flow window after they went silent. */
const AGENT_STOPPED_SHOWN_MS = AGENT_SILENT_MS + FLOW_WINDOW_MS;
/** Transcript activity older than this cannot change what the page lists. */
export const ACTIVITY_LOOKBACK_MS = Math.max(AGENT_STOPPED_SHOWN_MS, AGENT_RECENT_MS);
const AGENT_ORDER: Record<LiveAgentStatus, number> = { running: 0, idle: 1, stopped: 2, finished: 3 };

/** An API-key gateway from models.yml, named after the display names given to its models. */
export interface GatewayInfo {
	name: string;
	host: string | null;
}

/**
 * Custom providers from the profile's models.yml, by provider id: the
 * gateways reached with an API key. Only model names and the base URL host
 * are kept; keys and headers are never copied out of the parsed file.
 */
export function loadGateways(modelsPath = path.join(getAgentDir(), "models.yml")): Map<string, GatewayInfo> {
	const gateways = new Map<string, GatewayInfo>();
	let parsed: unknown;
	try {
		parsed = YAML.parse(fs.readFileSync(modelsPath, "utf8"));
	} catch (err) {
		// No models.yml (the common case) or one that does not parse: no gateways to show.
		logger.debug("models.yml unavailable for live traffic", { modelsPath, error: String(err) });
		return gateways;
	}
	if (!parsed || typeof parsed !== "object" || !("providers" in parsed)) return gateways;
	const { providers } = parsed;
	if (!providers || typeof providers !== "object") return gateways;
	for (const [id, config] of Object.entries(providers)) {
		if (!config || typeof config !== "object") continue;
		const names: string[] = [];
		const models = "models" in config && Array.isArray(config.models) ? config.models : [];
		for (const model of models) {
			if (!model || typeof model !== "object") continue;
			const name =
				"name" in model && typeof model.name === "string" && model.name
					? model.name
					: "id" in model
						? model.id
						: null;
			if (typeof name === "string" && name.length > 0) names.push(name);
		}
		let host: string | null = null;
		if ("baseUrl" in config && typeof config.baseUrl === "string") {
			try {
				host = new URL(config.baseUrl).hostname || null;
			} catch {
				host = null;
			}
		}
		gateways.set(id, { name: names.join(" / ") || id, host });
	}
	return gateways;
}

/** Live state of an account: needs_login and blocks come from agent.db, the rest from the last minute's requests. */
export function liveAccountState(account: Pick<AccountStats, "status">, rpm: number): LiveTargetState {
	if (account.status === "needs_login") return "needs_login";
	if (account.status === "blocked") return "rate_limited";
	return rpm > 0 ? "active" : "quiet";
}

/** Whether any current quota window of the account is at or above {@link QUOTA_WARNING_FRACTION}. */
export function hasQuotaWarning(account: Pick<AccountStats, "quotas">): boolean {
	return account.quotas.some(q => (q.usedFraction ?? 0) >= QUOTA_WARNING_FRACTION);
}

/** omp's sessions folder name (`-projects-acme-shop`) as a short project label. */
export function projectLabel(folder: string): string {
	let label = folder.replace(/^-+|-+$/g, "");
	for (const prefix of ["projects-", "private-tmp-", "Users-"]) {
		if (label.startsWith(prefix)) label = label.slice(prefix.length);
	}
	return label || folder;
}

/** Where a transcript sits: its root session file, sessions folder and stem, and the subagent name if it is one. */
export interface TranscriptLocation {
	id: string;
	folder: string;
	stem: string;
	agent: string | null;
}

/**
 * The root session of a transcript: `<sessions>/<folder>/<stem>.jsonl` itself,
 * or for a subagent/advisor transcript inside `<sessions>/<folder>/<stem>/`,
 * that session's `<stem>.jsonl`. `agent` names the subagent (null for the
 * session's own transcript).
 */
export function rootSessionOf(sessionFile: string, sessionsDir: string): TranscriptLocation {
	const parts = path.relative(sessionsDir, sessionFile).split(path.sep);
	if (parts.length < 2 || parts[0] === ".." || path.isAbsolute(parts[0])) {
		const stem = path.basename(sessionFile, ".jsonl");
		return { id: sessionFile, folder: "", stem, agent: null };
	}
	const stem = parts[1].replace(/\.jsonl$/, "");
	return {
		id: path.join(sessionsDir, parts[0], `${stem}.jsonl`),
		folder: parts[0],
		stem,
		agent: parts.length > 2 ? agentName(parts.slice(2)) : null,
	};
}

/** A subagent transcript's path inside its session folder as a display name (`__advisor.default` → Advisor). */
export function agentName(relParts: readonly string[]): string {
	const name = relParts.join("/").replace(/\.jsonl$/, "");
	return name.startsWith("__advisor") ? "Advisor" : name;
}

/**
 * What an agent's transcript says about it: finished (an exit at or after its
 * last entry), idle (ended its turn with a plain answer, waiting to be
 * messaged), running (wrote within {@link AGENT_SILENT_MS}, no exit since),
 * else stopped. An exit followed by later entries means the agent was revived.
 */
export function agentStatus(
	activity: Pick<TranscriptActivityRow, "lastAt" | "exitAt" | "yieldedAt">,
	nowMs: number,
): LiveAgentStatus {
	const { lastAt, exitAt } = activity;
	if (exitAt !== null && (lastAt === null || exitAt >= lastAt - 1000)) return "finished";
	if (activity.yieldedAt !== null) return "idle";
	if (lastAt !== null && nowMs - lastAt <= AGENT_SILENT_MS) return "running";
	return "stopped";
}

function toolOf(activity: TranscriptActivityRow | undefined): LiveToolActivity | null {
	if (!activity || (activity.toolName === null && activity.toolIntent === null)) return null;
	return { name: activity.toolName, intent: activity.toolIntent, at: activity.toolAt };
}

/** Key of the target a request without a stored credential goes to: its provider's gateway or background node. */
function noAccountKey(provider: string): string {
	return `${provider}/none`;
}

/**
 * Fold the five-minute request window and recent transcript activity into
 * sessions (with their subagents), targets, lines and the latest requests.
 *
 * @param rows completed requests since `nowMs - FLOW_WINDOW_MS`
 * @param activity transcript activity written since `nowMs - ACTIVITY_LOOKBACK_MS`, plus that of the sessions' own transcripts
 * @param accounts merged accounts (Accounts page identity resolution) with status and quotas
 * @param lastNoAccount newest request without a credential per provider, any age (idle gateways show it)
 * @param metadata title and working directory per root session file, when known
 */
export function buildLiveTraffic(input: {
	rows: readonly LiveRequestRow[];
	activity: readonly TranscriptActivityRow[];
	accounts: readonly AccountStats[];
	lastNoAccount: ReadonlyMap<string, number>;
	gateways: ReadonlyMap<string, GatewayInfo>;
	metadata: ReadonlyMap<string, SessionMetadata>;
	sessionsDir: string;
	nowMs: number;
}): LiveTrafficStats {
	const { rows, accounts, gateways, metadata, sessionsDir, nowMs } = input;
	const accountOf = new Map<number, AccountStats>();
	for (const account of accounts) for (const id of account.credentialIds) accountOf.set(id, account);

	const sessions = new Map<string, LiveSession>();
	const sessionFor = (root: TranscriptLocation): LiveSession => {
		let session = sessions.get(root.id);
		if (!session) {
			const meta = metadata.get(root.id);
			const project = meta?.cwd ? path.basename(meta.cwd) : root.folder ? projectLabel(root.folder) : root.stem;
			session = {
				id: root.id,
				name: meta?.title || project,
				project,
				started: basenameTimestamp(root.stem) ?? null,
				rpm: 0,
				last: null,
				doing: null,
				agents: [],
				agentsRunning: 0,
				working: false,
			};
			sessions.set(root.id, session);
		}
		return session;
	};
	const activityOf = new Map(input.activity.map(row => [row.sessionFile, row]));

	// Subagents: transcripts inside a session's folder, listed while they matter.
	const agentsByFile = new Map<string, LiveAgent>();
	for (const row of input.activity) {
		const root = rootSessionOf(row.sessionFile, sessionsDir);
		if (root.agent === null) continue;
		const status = agentStatus(row, nowMs);
		const age = row.lastAt === null ? Number.POSITIVE_INFINITY : nowMs - row.lastAt;
		if ((status === "finished" || status === "idle") && age > AGENT_RECENT_MS) continue;
		if (status === "stopped" && age > AGENT_STOPPED_SHOWN_MS) continue;
		const agent: LiveAgent = {
			id: row.sessionFile,
			name: root.agent,
			status,
			doing: toolOf(row),
			last: row.lastAt,
			rpm: 0,
			requests: 0,
			targets: [],
		};
		agentsByFile.set(row.sessionFile, agent);
		const session = sessionFor(root);
		session.agents.push(agent);
		if (status === "running") session.agentsRunning++;
	}
	const perTarget = new Map<string, { provider: string; rpm: number; tpm: number; last: number }>();
	const breakdowns = new Map<string, { housekeeping: number; turns: number; purposes: Map<string, number> }>();
	const edges = new Map<string, LiveEdge>();
	const recent: LiveRequest[] = [];

	for (const row of rows) {
		const age = nowMs - row.timestamp;
		if (age > FLOW_WINDOW_MS || age < -FUTURE_TOLERANCE_MS) continue;
		const root = rootSessionOf(row.sessionFile, sessionsDir);
		const session = sessionFor(root);
		const agent = agentsByFile.get(row.sessionFile);
		const account = row.credentialId === null ? undefined : accountOf.get(row.credentialId);
		const targetKey = account?.key ?? noAccountKey(row.provider);
		const target = perTarget.get(targetKey) ?? {
			provider: account?.provider ?? row.provider,
			rpm: 0,
			tpm: 0,
			last: 0,
		};
		const edgeKey = `${root.id}\0${targetKey}`;
		const edge = edges.get(edgeKey) ?? { from: root.id, to: targetKey, rpm: 0, last: 0 };
		target.last = Math.max(target.last, row.timestamp);
		edge.last = Math.max(edge.last, row.timestamp);
		session.last = Math.max(session.last ?? 0, row.timestamp);
		if (age <= LIVE_WINDOW_MS) {
			target.rpm++;
			target.tpm += row.tokens;
			edge.rpm++;
			session.rpm++;
			if (agent) agent.rpm++;
		}
		if (agent) {
			agent.requests++;
			if (!agent.targets.includes(targetKey)) agent.targets.push(targetKey);
		}
		perTarget.set(targetKey, target);
		if (!account) {
			const breakdown = breakdowns.get(targetKey) ?? { housekeeping: 0, turns: 0, purposes: new Map() };
			if (row.usagePurpose === null) breakdown.turns++;
			else {
				breakdown.housekeeping++;
				breakdown.purposes.set(row.usagePurpose, (breakdown.purposes.get(row.usagePurpose) ?? 0) + 1);
			}
			breakdowns.set(targetKey, breakdown);
		}
		edges.set(edgeKey, edge);
		recent.push({
			ts: row.timestamp,
			session: root.id,
			agent: root.agent,
			target: targetKey,
			model: row.model,
			tokens: row.tokens,
		});
	}

	for (const session of sessions.values()) {
		// What the session itself last started, from its own transcript (never one of its agents').
		session.doing = toolOf(activityOf.get(session.id));
		session.agents.sort((a, b) => AGENT_ORDER[a.status] - AGENT_ORDER[b.status] || (b.last ?? 0) - (a.last ?? 0));
		session.working = session.rpm > 0 || session.agentsRunning > 0;
	}

	const targets: LiveTarget[] = [];
	for (const account of accounts) {
		const traffic = perTarget.get(account.key);
		const rpm = traffic?.rpm ?? 0;
		targets.push({
			key: account.key,
			provider: account.provider,
			kind: "account",
			label: account.label,
			// The label is usually the email already; then name the stored credentials behind it instead.
			meta:
				account.email && account.email !== account.label
					? account.email
					: `credential ${account.credentialIds.map(id => `#${id}`).join(", ")}`,
			state: liveAccountState(account, rpm),
			quotaWarning: hasQuotaWarning(account),
			rpm,
			tpm: traffic?.tpm ?? 0,
			last: traffic?.last || account.lastUsed,
			quotas: account.quotas.filter(q => q.usedFraction !== null),
			breakdown: null,
		});
	}
	// Configured gateways show even when nothing went through them lately.
	for (const provider of gateways.keys()) {
		const key = noAccountKey(provider);
		if (!perTarget.has(key)) perTarget.set(key, { provider, rpm: 0, tpm: 0, last: 0 });
	}
	for (const [key, traffic] of perTarget) {
		if (key !== noAccountKey(traffic.provider)) continue;
		const gateway = gateways.get(traffic.provider);
		const breakdown = breakdowns.get(key);
		targets.push({
			key,
			provider: traffic.provider,
			kind: gateway ? "gateway" : "no_account",
			label: gateway ? gateway.name : "No account recorded",
			meta: gateway
				? gateway.host
					? `API-key gateway · ${gateway.host}`
					: "API-key gateway"
				: "account not recorded in the session log",
			state: traffic.rpm > 0 ? "active" : "quiet",
			quotaWarning: false,
			rpm: traffic.rpm,
			tpm: traffic.tpm,
			last: traffic.last || input.lastNoAccount.get(traffic.provider) || null,
			quotas: [],
			breakdown: {
				housekeeping: breakdown?.housekeeping ?? 0,
				turns: breakdown?.turns ?? 0,
				purposes: [...(breakdown?.purposes ?? [])]
					.map(([purpose, requests]) => ({ purpose, requests }))
					.sort((a, b) => b.requests - a.requests || a.purpose.localeCompare(b.purpose)),
			},
		});
	}
	targets.sort(
		(a, b) =>
			a.provider.localeCompare(b.provider) ||
			Number(a.kind !== "account") - Number(b.kind !== "account") ||
			a.label.localeCompare(b.label),
	);

	return {
		now: nowMs,
		windowMs: LIVE_WINDOW_MS,
		flowWindowMs: FLOW_WINDOW_MS,
		sessions: [...sessions.values()].sort(
			(a, b) =>
				Number(b.working) - Number(a.working) || (b.last ?? 0) - (a.last ?? 0) || a.name.localeCompare(b.name),
		),
		targets,
		edges: [...edges.values()],
		recent: recent.sort((a, b) => b.ts - a.ts).slice(0, RECENT_LIMIT),
	};
}
