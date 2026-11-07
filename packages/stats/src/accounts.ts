/**
 * Per-account attribution for the stats dashboard.
 *
 * Assistant turns record the `auth_credentials.id` that served them, and ingest
 * stores it as `messages.credential_id`. This module resolves those ids to
 * accounts from agent.db, opened read-only: identity keys and disable state
 * from `auth_credentials` (never its `data` column, which holds the secrets),
 * active rate-limit blocks from `auth_credential_blocks`, and the latest quota
 * readings from `usage_history`. Credentials sharing a provider and identity
 * (same email and organization, e.g. a re-login next to its disabled
 * predecessor) merge into one account row.
 *
 * A missing agent DB or table yields no credentials, so request totals still
 * show, keyed by the bare credential id.
 */
import { Database } from "bun:sqlite";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import type { CredentialRequestCount, SessionStart } from "./db";
import type { CredentialAggregate, CredentialTimeSeriesPoint } from "./rollup";
import type {
	AccountBlock,
	AccountDashboardStats,
	AccountFlowPoint,
	AccountFlowSeries,
	AccountFlowStats,
	AccountQuotaWindow,
	AccountStats,
	AccountStatus,
	AssignmentChange,
	ProviderAccountTotals,
	ProviderRouting,
	RoutingRequestShare,
	UnattributedUsage,
} from "./shared-types";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Quota readings older than this belong to retired limit windows and are dropped. */
const QUOTA_MAX_AGE_MS = 7 * DAY_MS;
/** Trailing window of the measured request split: requests of every session, however long it has run. */
export const RECENT_WINDOW_MS = 15 * MINUTE_MS;
/** Trailing window of new-session observations: main sessions whose first attributed request falls inside. */
export const NEW_SESSION_WINDOW_MS = HOUR_MS;

/** The non-secret columns of one `auth_credentials` row. */
export interface StoredCredential {
	id: number;
	provider: string;
	credentialType: string;
	disabledCause: string | null;
	identityKey: string | null;
	/** Epoch seconds of the row's last write. */
	updatedAt: number;
}

/** One unexpired `auth_credential_blocks` row. */
export interface StoredCredentialBlock {
	credentialId: number;
	scope: string;
	blockedUntil: number;
}

/** Latest `usage_history` reading of one (provider, account key, limit) series. */
export interface QuotaReading extends AccountQuotaWindow {
	provider: string;
	accountKey: string;
	email: string | null;
	accountId: string | null;
}

/** Everything account attribution needs from agent.db. */
export interface AgentAccountData {
	credentials: StoredCredential[];
	blocks: StoredCredentialBlock[];
	quotas: QuotaReading[];
	/**
	 * Every distinct `usage_history.account_key`, any provider and age. Keys such
	 * as `oauth|account:<uuid>|email:<email>|org:<uuid>` tie an account uuid to an
	 * email and organization, which resolves credentials stored under a bare
	 * `account:<uuid>` identity.
	 */
	accountKeys: string[];
}

/**
 * Read credentials, active blocks and recent quota readings from the agent DB,
 * read-only. Each table is read independently so an older schema missing one
 * of them still yields the others.
 */
export function readAgentAccountData(nowMs: number, dbPath = getAgentDbPath()): AgentAccountData {
	const data: AgentAccountData = { credentials: [], blocks: [], quotas: [], accountKeys: [] };
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch (err) {
		// Expected for fresh or API-key-only installs that never created agent.db.
		logger.debug("agent db unavailable for account stats", { dbPath, error: String(err) });
		return data;
	}
	const readRows = <T>(table: string, sql: string, ...params: number[]): T[] => {
		try {
			return db.prepare(sql).all(...params) as T[];
		} catch (err) {
			logger.debug("agent db table unavailable for account stats", { dbPath, table, error: String(err) });
			return [];
		}
	};
	try {
		db.run("PRAGMA busy_timeout = 5000");
		data.credentials = readRows<{
			id: number;
			provider: string;
			credential_type: string;
			disabled_cause: string | null;
			identity_key: string | null;
			updated_at: number;
		}>(
			"auth_credentials",
			// `data` holds tokens and keys: never select it.
			"SELECT id, provider, credential_type, disabled_cause, identity_key, updated_at FROM auth_credentials ORDER BY id",
		).map(row => ({
			id: row.id,
			provider: row.provider,
			credentialType: row.credential_type,
			disabledCause: row.disabled_cause,
			identityKey: row.identity_key,
			updatedAt: row.updated_at,
		}));
		data.blocks = readRows<{ credential_id: number; block_scope: string; blocked_until_ms: number }>(
			"auth_credential_blocks",
			`SELECT credential_id, block_scope, MAX(blocked_until_ms) AS blocked_until_ms
			 FROM auth_credential_blocks WHERE blocked_until_ms > ?
			 GROUP BY credential_id, block_scope`,
			nowMs,
		).map(row => ({ credentialId: row.credential_id, scope: row.block_scope, blockedUntil: row.blocked_until_ms }));
		data.quotas = readRows<{
			provider: string;
			account_key: string;
			email: string | null;
			account_id: string | null;
			limit_id: string;
			label: string;
			window_label: string | null;
			used_fraction: number | null;
			status: string | null;
			resets_at: number | null;
			recorded_at: number;
		}>(
			"usage_history",
			`SELECT u.provider, u.account_key, u.email, u.account_id, u.limit_id, u.label, u.window_label,
			        u.used_fraction, u.status, u.resets_at, u.recorded_at
			 FROM usage_history u
			 JOIN (
			   SELECT provider, account_key, limit_id, MAX(recorded_at) AS recorded_at
			   FROM usage_history WHERE recorded_at >= ?
			   GROUP BY provider, account_key, limit_id
			 ) latest USING (provider, account_key, limit_id, recorded_at)`,
			nowMs - QUOTA_MAX_AGE_MS,
		).map(row => ({
			provider: row.provider,
			accountKey: row.account_key,
			email: row.email,
			accountId: row.account_id,
			limitId: row.limit_id,
			label: row.label,
			windowLabel: row.window_label,
			usedFraction: row.used_fraction,
			status: row.status,
			resetsAt: row.resets_at,
			recordedAt: row.recorded_at,
		}));
		data.accountKeys = readRows<{ account_key: string }>(
			"usage_history",
			"SELECT DISTINCT account_key FROM usage_history",
		).map(row => row.account_key);
	} finally {
		db.close();
	}
	return data;
}

/** Account state by precedence: needs_login > blocked > active > idle > never. */
export function resolveAccountStatus(
	account: { needsLogin: boolean; blocked: boolean; lastUsed: number | null },
	nowMs: number,
): AccountStatus {
	if (account.needsLogin) return "needs_login";
	if (account.blocked) return "blocked";
	if (account.lastUsed === null) return "never";
	return account.lastUsed >= nowMs - DAY_MS ? "active" : "idle";
}

/** Email, organization and account id named by an identity key (`email:a@b.c|org:<id>`) or usage account key. */
interface Identity {
	email: string | null;
	org: string | null;
	account: string | null;
}

function parseIdentity(key: string | null): Identity {
	const identity: Identity = { email: null, org: null, account: null };
	for (const part of key?.split("|") ?? []) {
		const colon = part.indexOf(":");
		const value = part.slice(colon + 1).trim();
		if (colon < 0 || value.length === 0) continue;
		switch (part.slice(0, colon)) {
			case "email":
				identity.email = value.toLowerCase();
				break;
			case "org":
				identity.org = value;
				break;
			case "account":
				identity.account = value;
				break;
		}
	}
	return identity;
}

interface AccountDraft {
	key: string;
	provider: string;
	label: string;
	identity: Identity;
	credentialType: string | null;
	credentialIds: number[];
	enabledIds: Set<number>;
	/** Newest disabled credential, for its cause. */
	lastDisabled: StoredCredential | null;
	requests: number;
	failedRequests: number;
	totalTokens: number;
	totalCost: number;
	unpricedRequests: number;
	lastUsed: number | null;
}

function newDraft(key: string, provider: string, label: string, identity: Identity, type: string | null): AccountDraft {
	return {
		key,
		provider,
		label,
		identity,
		credentialType: type,
		credentialIds: [],
		enabledIds: new Set(),
		lastDisabled: null,
		requests: 0,
		failedRequests: 0,
		totalTokens: 0,
		totalCost: 0,
		unpricedRequests: 0,
		lastUsed: null,
	};
}

/** Credentials grouped into accounts; resolves any credential id (known or not) to its account. */
interface AccountIndex {
	drafts: Map<string, AccountDraft>;
	draftFor(provider: string, credentialId: number): AccountDraft;
}

/** A numbered sibling of a provider (`anthropic-2`): a second login slot of the same provider. */
const PROVIDER_FAMILY_MEMBER = /^(.+)-\d+$/;

/**
 * Group stored credentials into accounts by provider and identity (same email + org).
 *
 * A bare `account:<uuid>` identity resolves to the email and organization a
 * usage-history account key records for that uuid. A credential of a numbered
 * provider (`<base>-<n>`) whose resolved identity matches an account of
 * `<base>` joins that account; otherwise it stays an account of its own.
 */
function indexAccounts(agent: Pick<AgentAccountData, "credentials" | "accountKeys">): AccountIndex {
	const drafts = new Map<string, AccountDraft>();
	const byCredential = new Map<number, AccountDraft>();

	const byAccountUuid = new Map<string, Identity>();
	for (const accountKey of agent.accountKeys) {
		const identity = parseIdentity(accountKey);
		if (identity.account !== null && identity.email !== null) byAccountUuid.set(identity.account, identity);
	}

	// Base providers first, so a numbered sibling finds the account it may belong to.
	const ordered = [...agent.credentials].sort(
		(a, b) =>
			Number(PROVIDER_FAMILY_MEMBER.test(a.provider)) - Number(PROVIDER_FAMILY_MEMBER.test(b.provider)) ||
			a.id - b.id,
	);
	for (const credential of ordered) {
		const identity = parseIdentity(credential.identityKey);
		if (identity.email === null && identity.account !== null) {
			const resolved = byAccountUuid.get(identity.account);
			if (resolved) {
				identity.email = resolved.email;
				identity.org = identity.org ?? resolved.org;
			}
		}
		// Same email + org is one account, whatever else the key carries.
		const identityKey = identity.email
			? `email:${identity.email}|org:${identity.org ?? ""}`
			: (credential.identityKey ?? `credential:${credential.id}`);
		const base = identity.email ? PROVIDER_FAMILY_MEMBER.exec(credential.provider)?.[1] : undefined;
		let draft = base === undefined ? undefined : drafts.get(`${base}/${identityKey}`);
		const key = `${credential.provider}/${identityKey}`;
		draft ??= drafts.get(key);
		if (!draft) {
			const label =
				identity.email ??
				credential.identityKey ??
				`${credential.credentialType === "api_key" ? "API key" : "Credential"} #${credential.id}`;
			draft = newDraft(key, credential.provider, label, identity, credential.credentialType);
			drafts.set(key, draft);
		}
		draft.credentialIds.push(credential.id);
		byCredential.set(credential.id, draft);
		if (credential.disabledCause === null) {
			draft.enabledIds.add(credential.id);
		} else if (!draft.lastDisabled || credential.updatedAt >= draft.lastDisabled.updatedAt) {
			draft.lastDisabled = credential;
		}
	}

	return {
		drafts,
		// Ids missing from agent.db (another profile's database, a hard-deleted row) still own their traffic.
		draftFor(provider, credentialId) {
			let draft = byCredential.get(credentialId);
			if (!draft) {
				const key = `${provider}/credential:${credentialId}`;
				draft = newDraft(key, provider, `Credential #${credentialId}`, parseIdentity(null), null);
				draft.credentialIds.push(credentialId);
				drafts.set(key, draft);
				byCredential.set(credentialId, draft);
			}
			return draft;
		},
	};
}

/**
 * Earliest request time routing reads: session starts must cover both the
 * new-session window and the selected range, so the last assignment change in range is found.
 */
export function routingSince(rangeCutoff: number | null, nowMs: number): number {
	return Math.min(rangeCutoff ?? 0, nowMs - NEW_SESSION_WINDOW_MS);
}

/**
 * Per-provider routing: the measured recent request split across accounts,
 * which accounts served the first request of new main sessions, and the latest
 * observed change of that account within the range.
 */
function buildRouting(
	index: AccountIndex,
	recent: readonly CredentialRequestCount[],
	sessionStarts: readonly SessionStart[],
	rangeCutoff: number | null,
	nowMs: number,
): ProviderRouting[] {
	const providers = new Map<
		string,
		{ recent: Map<string, number>; recentTotal: number; starts: Array<{ accountKey: string; at: number }> }
	>();
	const providerEntry = (provider: string) => {
		let entry = providers.get(provider);
		if (!entry) {
			entry = { recent: new Map(), recentTotal: 0, starts: [] };
			providers.set(provider, entry);
		}
		return entry;
	};
	for (const row of recent) {
		const draft = index.draftFor(row.provider, row.credentialId);
		const entry = providerEntry(draft.provider);
		entry.recent.set(draft.key, (entry.recent.get(draft.key) ?? 0) + row.requests);
		entry.recentTotal += row.requests;
	}
	for (const start of sessionStarts) {
		const draft = index.draftFor(start.provider, start.credentialId);
		providerEntry(draft.provider).starts.push({ accountKey: draft.key, at: start.at });
	}

	const windowStart = nowMs - NEW_SESSION_WINDOW_MS;
	const rangeStart = rangeCutoff ?? Number.NEGATIVE_INFINITY;
	const routing: ProviderRouting[] = [];
	for (const [provider, entry] of providers) {
		const { starts } = entry;
		const sessionsByAccount = new Map<string, number>();
		for (const start of starts) {
			if (start.at < windowStart) continue;
			sessionsByAccount.set(start.accountKey, (sessionsByAccount.get(start.accountKey) ?? 0) + 1);
		}
		const latest = starts.at(-1);
		const lastAccount = latest && latest.at >= windowStart ? latest.accountKey : null;
		let lastAccountSince: number | null = null;
		if (lastAccount !== null) {
			let first = starts.length - 1;
			while (first > 0 && starts[first - 1].accountKey === lastAccount) first--;
			lastAccountSince = starts[first].at;
		}
		let lastAssignmentChange: AssignmentChange | null = null;
		for (let i = starts.length - 1; i > 0 && starts[i - 1].at >= rangeStart; i--) {
			if (starts[i].accountKey === starts[i - 1].accountKey) continue;
			lastAssignmentChange = {
				fromAccountKey: starts[i - 1].accountKey,
				toAccountKey: starts[i].accountKey,
				at: starts[i].at,
			};
			break;
		}
		let sessions = 0;
		for (const count of sessionsByAccount.values()) sessions += count;
		if (entry.recentTotal === 0 && sessions === 0 && lastAssignmentChange === null) continue;
		routing.push({
			provider,
			recent: {
				windowMs: RECENT_WINDOW_MS,
				requests: entry.recentTotal,
				accounts: [...entry.recent]
					.map(([accountKey, requests]) => ({ accountKey, requests, share: requests / entry.recentTotal }))
					.sort((a, b) => b.requests - a.requests || a.accountKey.localeCompare(b.accountKey)),
			},
			newSessions: {
				windowMs: NEW_SESSION_WINDOW_MS,
				sessions,
				accounts: [...sessionsByAccount]
					.map(([accountKey, count]) => ({ accountKey, sessions: count }))
					.sort((a, b) => b.sessions - a.sessions || a.accountKey.localeCompare(b.accountKey)),
				lastAccount,
				lastAccountSince,
				latest: latest ? { accountKey: latest.accountKey, at: latest.at } : null,
			},
			lastAssignmentChange,
		});
	}
	return routing.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Fold per-credential traffic and agent.db state into account rows, the
 * per-provider unattributed remainder, and per-provider routing.
 *
 * @param inRange totals per (provider, credential) over the selected range
 * @param allTime totals per (provider, credential) over all time; only `lastUsed` is read, so status ignores the range
 * @param recent attributed requests per credential in the last {@link RECENT_WINDOW_MS}
 * @param sessionStarts first attributed request per (transcript, provider) since {@link routingSince}, oldest first
 * @param rangeCutoff start of the selected range (null = all time); bounds the last-switch search
 */
export function buildAccountStats(input: {
	inRange: readonly CredentialAggregate[];
	allTime: readonly CredentialAggregate[];
	recent: readonly CredentialRequestCount[];
	sessionStarts: readonly SessionStart[];
	rangeCutoff: number | null;
	agent: AgentAccountData;
	nowMs: number;
}): AccountDashboardStats {
	const { inRange, allTime, agent, nowMs } = input;
	const index = indexAccounts(agent);

	for (const row of allTime) {
		if (row.credentialId === null) continue;
		const draft = index.draftFor(row.provider, row.credentialId);
		draft.lastUsed = Math.max(draft.lastUsed ?? 0, row.lastUsed);
	}

	const unattributed = new Map<string, UnattributedUsage>();
	// Keyed by the request's own provider, exactly as the Providers page counts it.
	const requestsByProvider = new Map<string, ProviderAccountTotals>();
	for (const row of inRange) {
		const split = requestsByProvider.get(row.provider) ?? {
			provider: row.provider,
			requests: 0,
			accountRequests: 0,
			unattributedRequests: 0,
		};
		split.requests += row.requests;
		if (row.credentialId === null) split.unattributedRequests += row.requests;
		else split.accountRequests += row.requests;
		requestsByProvider.set(row.provider, split);
		if (row.credentialId === null) {
			const entry = unattributed.get(row.provider) ?? {
				provider: row.provider,
				requests: 0,
				failedRequests: 0,
				totalTokens: 0,
				totalCost: 0,
				unpricedRequests: 0,
				lastUsed: null,
			};
			entry.requests += row.requests;
			entry.failedRequests += row.failedRequests;
			entry.totalTokens += row.totalTokens;
			entry.totalCost += row.totalCost;
			entry.unpricedRequests += row.unpricedRequests;
			entry.lastUsed = Math.max(entry.lastUsed ?? 0, row.lastUsed);
			unattributed.set(row.provider, entry);
			continue;
		}
		const draft = index.draftFor(row.provider, row.credentialId);
		draft.requests += row.requests;
		draft.failedRequests += row.failedRequests;
		draft.totalTokens += row.totalTokens;
		draft.totalCost += row.totalCost;
		draft.unpricedRequests += row.unpricedRequests;
	}

	const routing = buildRouting(index, input.recent, input.sessionStarts, input.rangeCutoff, nowMs);
	const recentByAccount = new Map<string, RoutingRequestShare>();
	const latestNewSessionAccounts = new Set<string>();
	for (const provider of routing) {
		for (const share of provider.recent.accounts) recentByAccount.set(share.accountKey, share);
		if (provider.newSessions.lastAccount !== null) latestNewSessionAccounts.add(provider.newSessions.lastAccount);
	}

	const providerTotals = new Map<string, { requests: number; tokens: number }>();
	for (const draft of index.drafts.values()) {
		const totals = providerTotals.get(draft.provider) ?? { requests: 0, tokens: 0 };
		totals.requests += draft.requests;
		totals.tokens += draft.totalTokens;
		providerTotals.set(draft.provider, totals);
	}

	const accounts: AccountStats[] = [];
	for (const draft of index.drafts.values()) {
		const needsLogin = draft.credentialType !== null && draft.enabledIds.size === 0;

		const blockByScope = new Map<string, number>();
		for (const block of agent.blocks) {
			if (!draft.enabledIds.has(block.credentialId)) continue;
			blockByScope.set(block.scope, Math.max(blockByScope.get(block.scope) ?? 0, block.blockedUntil));
		}
		const blocks: AccountBlock[] = [...blockByScope]
			.map(([scope, until]) => ({ scope, until }))
			.sort((a, b) => a.until - b.until);

		const quotaByLimit = new Map<string, AccountQuotaWindow>();
		const { email, org, account } = draft.identity;
		for (const reading of agent.quotas) {
			// A numbered sibling provider (`anthropic-2`) reports quota for the same accounts.
			if (
				reading.provider !== draft.provider &&
				PROVIDER_FAMILY_MEMBER.exec(reading.provider)?.[1] !== draft.provider
			) {
				continue;
			}
			const readingIdentity = parseIdentity(reading.accountKey);
			const readingEmail = readingIdentity.email ?? reading.email?.toLowerCase() ?? null;
			const matches = email
				? readingEmail === email && (org === null || readingIdentity.org === org)
				: account !== null && (readingIdentity.account ?? reading.accountId) === account;
			if (!matches) continue;
			const known = quotaByLimit.get(reading.limitId);
			if (known && known.recordedAt >= reading.recordedAt) continue;
			// A reading taken before its window reset says nothing about the current window.
			const reset = reading.resetsAt !== null && reading.resetsAt <= nowMs;
			quotaByLimit.set(reading.limitId, {
				limitId: reading.limitId,
				label: reading.label,
				windowLabel: reading.windowLabel,
				usedFraction: reset ? null : reading.usedFraction,
				status: reset ? null : reading.status,
				resetsAt: reading.resetsAt,
				recordedAt: reading.recordedAt,
			});
		}
		const quotas = [...quotaByLimit.values()].sort(
			(a, b) => b.recordedAt - a.recordedAt || a.label.localeCompare(b.label),
		);

		const totals = providerTotals.get(draft.provider);
		const recent = recentByAccount.get(draft.key);
		accounts.push({
			key: draft.key,
			provider: draft.provider,
			label: draft.label,
			email,
			orgId: org,
			credentialType: draft.credentialType,
			credentialIds: [...draft.credentialIds].sort((a, b) => a - b),
			status: resolveAccountStatus({ needsLogin, blocked: blocks.length > 0, lastUsed: draft.lastUsed }, nowMs),
			disabledCause: needsLogin ? (draft.lastDisabled?.disabledCause ?? null) : null,
			blocks,
			requests: draft.requests,
			failedRequests: draft.failedRequests,
			totalTokens: draft.totalTokens,
			totalCost: draft.totalCost,
			unpricedRequests: draft.unpricedRequests,
			lastUsed: draft.lastUsed,
			requestShare: totals && totals.requests > 0 ? draft.requests / totals.requests : 0,
			tokenShare: totals && totals.tokens > 0 ? draft.totalTokens / totals.tokens : 0,
			quotas,
			recentRequests: recent?.requests ?? 0,
			recentShare: recent?.share ?? 0,
			servingNow: recent !== undefined && recent.requests > 0,
			servedLatestNewSession: latestNewSessionAccounts.has(draft.key),
		});
	}
	accounts.sort(
		(a, b) => a.provider.localeCompare(b.provider) || b.requests - a.requests || a.label.localeCompare(b.label),
	);

	return {
		accounts,
		unattributed: [...unattributed.values()].sort((a, b) => b.requests - a.requests),
		providerTotals: [...requestsByProvider.values()].sort(
			(a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider),
		),
		routing,
	};
}

/**
 * Map per-credential buckets onto account series: credentials of one account
 * add into one series, and each provider's unattributed traffic is a series of
 * its own.
 */
export function buildAccountFlow(
	points: readonly CredentialTimeSeriesPoint[],
	agent: Pick<AgentAccountData, "credentials" | "accountKeys">,
): AccountFlowStats {
	const index = indexAccounts(agent);
	const series = new Map<string, AccountFlowSeries>();
	const merged = new Map<string, AccountFlowPoint>();
	for (const point of points) {
		let entry: AccountFlowSeries;
		if (point.credentialId === null) {
			const key = `${point.provider}/unattributed`;
			entry = series.get(key) ?? { key, provider: point.provider, label: "Unattributed", accountKey: null };
		} else {
			const draft = index.draftFor(point.provider, point.credentialId);
			entry = series.get(draft.key) ?? {
				key: draft.key,
				provider: draft.provider,
				label: draft.label,
				accountKey: draft.key,
			};
		}
		series.set(entry.key, entry);
		const id = `${point.timestamp}\0${entry.key}`;
		const bucket = merged.get(id) ?? { timestamp: point.timestamp, key: entry.key, requests: 0, tokens: 0 };
		bucket.requests += point.requests;
		bucket.tokens += point.totalTokens;
		merged.set(id, bucket);
	}
	return {
		series: [...series.values()],
		points: [...merged.values()].sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key)),
	};
}
