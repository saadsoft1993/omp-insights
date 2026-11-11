import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildAccountFlow,
	buildAccountStats,
	readAgentAccountData,
	resolveAccountStatus,
	type StoredCredential,
} from "@oh-my-pi/omp-stats/accounts";
import {
	getAccountDashboardStats,
	getAccountFlowStats,
	getProviderDashboardStats,
	syncAllSessions,
} from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getMessageCount, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import type { CredentialAggregate } from "@oh-my-pi/omp-stats/rollup";
import { getAgentDbPath, getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-accounts-");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINUTE = 60 * 1000;

/** No routing input: these cases only look at totals, status and quotas. */
const NO_ROUTING = { recent: [], sessionStarts: [], rangeCutoff: null };

function oauth(id: number, identityKey: string, disabledCause: string | null = null): StoredCredential {
	return { id, provider: "anthropic", credentialType: "oauth", disabledCause, identityKey, updatedAt: id };
}

const SPECTRUM = "anthropic/email:team@example.com|org:org-1";
const PERSONAL = "anthropic/email:me@example.com|org:org-3";
const ROUTING_CREDENTIALS = [
	oauth(1, "email:team@example.com|org:org-1"),
	oauth(3, "email:me@example.com|org:org-3"),
	// The same account re-logged in: still the personal account.
	oauth(4, "email:Me@Example.com|org:org-3"),
];

const usage = {
	input: 10,
	output: 5,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 115,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
};

function assistantEntry(
	id: string,
	timestamp: number,
	credentialId?: number,
	provider = "anthropic",
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider,
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			timestamp,
			...(credentialId !== undefined ? { credentialId } : {}),
			usage,
		},
	};
}

function modelUsageEntry(id: string, timestamp: number): Record<string, unknown> {
	return {
		type: "model_usage",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		purpose: "auto-thinking",
		role: "judge",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
	};
}

async function writeSession(name: string, lines: Array<Record<string, unknown>>): Promise<string> {
	const file = path.join(getSessionsDir(), "--tmp--accounts", name);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

interface CredentialFixture {
	id: number;
	provider?: string;
	identityKey: string | null;
	disabledCause?: string | null;
	type?: string;
}

async function createAgentDb(fixture: {
	credentials: CredentialFixture[];
	blocks?: Array<{ credentialId: number; scope: string; until: number }>;
	usage?: Array<{ accountKey: string; limitId: string; usedFraction: number; recordedAt: number }>;
}): Promise<void> {
	const dbPath = getAgentDbPath();
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	try {
		db.run(`
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE auth_credential_blocks (
				credential_id INTEGER NOT NULL,
				provider_key TEXT NOT NULL,
				block_scope TEXT NOT NULL DEFAULT '',
				blocked_until_ms INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (credential_id, provider_key, block_scope)
			);
			CREATE TABLE usage_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				email TEXT,
				account_id TEXT,
				limit_id TEXT NOT NULL,
				label TEXT NOT NULL,
				window_label TEXT,
				used_fraction REAL,
				status TEXT,
				resets_at INTEGER
			);
		`);
		for (const c of fixture.credentials) {
			db.prepare(
				"INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(
				c.id,
				c.provider ?? "anthropic",
				c.type ?? "oauth",
				'{"access":"secret"}',
				c.disabledCause ?? null,
				c.identityKey,
				c.id,
			);
		}
		for (const b of fixture.blocks ?? []) {
			db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, 'anthropic:oauth', ?, ?, 0)",
			).run(b.credentialId, b.scope, b.until);
		}
		for (const u of fixture.usage ?? []) {
			db.prepare(
				"INSERT INTO usage_history (recorded_at, provider, account_key, limit_id, label, window_label, used_fraction, status) VALUES (?, 'anthropic', ?, ?, ?, ?, ?, 'ok')",
			).run(u.recordedAt, u.accountKey, u.limitId, u.limitId, u.limitId, u.usedFraction);
		}
	} finally {
		db.close();
	}
}

function traffic(overrides: Partial<CredentialAggregate> & { credentialId: number | null }): CredentialAggregate {
	return {
		provider: "anthropic",
		requests: 1,
		failedRequests: 0,
		totalTokens: 100,
		totalCost: 0.01,
		unpricedRequests: 0,
		lastUsed: 0,
		...overrides,
	};
}

describe("credential attribution at ingest", () => {
	it("stores the turn's credential id and leaves model_usage entries unattributed", async () => {
		const now = Date.now();
		const file = await writeSession("ingest.jsonl", [
			assistantEntry("turn-1", now - 2000, 7),
			assistantEntry("turn-2", now - 1000),
			modelUsageEntry("judge-1", now),
		]);

		const result = await parseSessionFile(file);
		await initDb();
		insertMessageStats(result.stats);
		expect(getMessageCount()).toBe(3);

		const byEntry = new Map(getRecentRequests(10).map(row => [row.entryId, row.credentialId]));
		expect(byEntry.get("turn-1")).toBe(7);
		expect(byEntry.get("turn-2")).toBeNull();
		expect(byEntry.get("judge-1")).toBeNull();
	});

	it("credits accounts end to end and lists the rest as unattributed", async () => {
		const now = Date.now();
		await createAgentDb({ credentials: [{ id: 7, identityKey: "email:a@example.com|org:org-1" }] });
		await writeSession("e2e.jsonl", [
			assistantEntry("turn-1", now - 2000, 7),
			assistantEntry("turn-2", now - 1000, 7),
			modelUsageEntry("judge-1", now),
		]);
		await syncAllSessions();

		const stats = await getAccountDashboardStats("24h");
		expect(stats.accounts).toHaveLength(1);
		expect(stats.accounts[0]).toMatchObject({
			provider: "anthropic",
			label: "a@example.com",
			credentialIds: [7],
			requests: 2,
			totalTokens: 230,
			status: "active",
			requestShare: 1,
		});
		expect(stats.unattributed).toEqual([
			expect.objectContaining({ provider: "anthropic", requests: 1, totalTokens: 115 }),
		]);
	});

	it("attributes rows ingested before the column existed on the next sync", async () => {
		const now = Date.now();
		const file = await writeSession("backfill.jsonl", [assistantEntry("turn-1", now, 3)]);
		await syncAllSessions();
		closeDb();

		// Simulate an older release: the row is stored without a credential and the
		// transcript's cursor says it was fully ingested; the sentinel is unspent.
		const stat = await fs.stat(file);
		const raw = new Database(getStatsDbPath());
		raw.run("UPDATE messages SET credential_id = NULL");
		raw.run("DELETE FROM meta WHERE key = 'messages_credential_id_v1'");
		raw.run("DELETE FROM file_offsets");
		raw.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			file,
			stat.size,
			stat.mtimeMs,
		);
		raw.close();

		await syncAllSessions();
		expect(getRecentRequests(1)[0]?.credentialId).toBe(3);
	});
});

describe("buildAccountStats", () => {
	it("merges credentials sharing an email and organization into one account", async () => {
		const now = Date.now();
		await createAgentDb({
			credentials: [
				// A re-login: the old row was disabled when its replacement was stored.
				{ id: 1, identityKey: "email:Dev@Example.com|org:org-1", disabledCause: "oauth refresh failed: 401" },
				{ id: 2, identityKey: "email:dev@example.com|org:org-1" },
				// Same email, different organization: a separate subscription.
				{ id: 3, identityKey: "email:dev@example.com|org:org-2" },
			],
			usage: [
				{
					accountKey: "oauth|account:acc-1|email:dev@example.com|org:org-1",
					limitId: "5h",
					usedFraction: 0.2,
					recordedAt: now - HOUR,
				},
				{
					accountKey: "oauth|account:acc-1|email:dev@example.com|org:org-1",
					limitId: "5h",
					usedFraction: 0.4,
					recordedAt: now - 60_000,
				},
				{
					accountKey: "oauth|account:acc-2|email:dev@example.com|org:org-2",
					limitId: "5h",
					usedFraction: 0.9,
					recordedAt: now - 60_000,
				},
			],
		});
		const stats = buildAccountStats({
			inRange: [
				traffic({ credentialId: 1, requests: 3, totalTokens: 300, lastUsed: now - 2 * DAY }),
				traffic({ credentialId: 2, requests: 1, totalTokens: 100, lastUsed: now - HOUR }),
				traffic({ credentialId: 3, requests: 4, totalTokens: 400, lastUsed: now - HOUR }),
			],
			allTime: [
				traffic({ credentialId: 1, lastUsed: now - 2 * DAY }),
				traffic({ credentialId: 2, lastUsed: now - HOUR }),
				traffic({ credentialId: 3, lastUsed: now - HOUR }),
			],
			agent: readAgentAccountData(now),
			...NO_ROUTING,
			nowMs: now,
		});

		expect(stats.accounts).toHaveLength(2);
		const merged = stats.accounts.find(a => a.orgId === "org-1");
		expect(merged).toMatchObject({
			label: "dev@example.com",
			credentialIds: [1, 2],
			requests: 4,
			totalTokens: 400,
			status: "active",
			disabledCause: null,
			requestShare: 0.5,
			lastUsed: now - HOUR,
		});
		expect(merged?.quotas).toEqual([expect.objectContaining({ limitId: "5h", usedFraction: 0.4 })]);
		const other = stats.accounts.find(a => a.orgId === "org-2");
		expect(other?.credentialIds).toEqual([3]);
		expect(other?.quotas.map(q => q.usedFraction)).toEqual([0.9]);
	});

	it("flags blocked accounts and keeps logged-out ones visible even without traffic", () => {
		const now = Date.now();
		const stats = buildAccountStats({
			inRange: [],
			allTime: [
				traffic({ credentialId: 1, lastUsed: now - HOUR }),
				traffic({ credentialId: 2, lastUsed: now - 3 * DAY }),
			],
			agent: {
				credentials: [
					{
						id: 1,
						provider: "anthropic",
						credentialType: "oauth",
						disabledCause: null,
						identityKey: "email:a@x.io",
						updatedAt: 1,
					},
					{
						id: 2,
						provider: "anthropic",
						credentialType: "oauth",
						disabledCause: "deleted by user",
						identityKey: "email:b@x.io",
						updatedAt: 1,
					},
					{
						id: 3,
						provider: "anthropic",
						credentialType: "oauth",
						disabledCause: "deleted by user",
						identityKey: "email:c@x.io",
						updatedAt: 1,
					},
					{
						id: 4,
						provider: "openai-codex",
						credentialType: "oauth",
						disabledCause: null,
						identityKey: "email:d@x.io",
						updatedAt: 1,
					},
				],
				blocks: [{ credentialId: 1, scope: "tier:fable", blockedUntil: now + HOUR }],
				quotas: [
					{
						provider: "anthropic",
						accountKey: "oauth|email:a@x.io",
						email: "a@x.io",
						accountId: null,
						limitId: "5h",
						label: "Claude 5 Hour",
						windowLabel: null,
						usedFraction: 0.98,
						status: "exhausted",
						resetsAt: now - 2 * HOUR,
						recordedAt: now - 6 * HOUR,
					},
					{
						provider: "anthropic",
						accountKey: "oauth|email:a@x.io",
						email: "a@x.io",
						accountId: null,
						limitId: "7d",
						label: "Claude 7 Day",
						windowLabel: null,
						usedFraction: 0.4,
						status: "ok",
						resetsAt: now + DAY,
						recordedAt: now - HOUR,
					},
				],
				accountKeys: [],
			},
			...NO_ROUTING,
			nowMs: now,
		});
		const status = new Map(stats.accounts.map(a => [a.label, a.status]));
		expect(status.get("a@x.io")).toBe("blocked");
		expect(status.get("b@x.io")).toBe("needs_login");
		expect(status.get("c@x.io")).toBe("needs_login");
		expect(status.get("d@x.io")).toBe("never");
		expect(stats.accounts.find(a => a.label === "a@x.io")?.blocks).toEqual([
			{ scope: "tier:fable", until: now + HOUR },
		]);
		expect(stats.accounts.find(a => a.label === "b@x.io")?.disabledCause).toBe("deleted by user");
		const quotas = new Map(stats.accounts.find(a => a.label === "a@x.io")?.quotas.map(q => [q.limitId, q]));
		expect(quotas.get("5h")?.usedFraction).toBeNull();
		expect(quotas.get("7d")?.usedFraction).toBe(0.4);
	});
});

describe("account routing", () => {
	it("splits recent requests across accounts and flags who is serving now", () => {
		const now = Date.now();
		const stats = buildAccountStats({
			inRange: [],
			allTime: [],
			recent: [
				{ provider: "anthropic", credentialId: 1, requests: 15 },
				{ provider: "anthropic", credentialId: 3, requests: 60 },
				{ provider: "anthropic", credentialId: 4, requests: 25 },
			],
			sessionStarts: [],
			rangeCutoff: now - DAY,
			agent: { credentials: ROUTING_CREDENTIALS, blocks: [], quotas: [], accountKeys: [] },
			nowMs: now,
		});
		const [routing] = stats.routing;
		expect(routing.recent.requests).toBe(100);
		expect(routing.recent.accounts).toEqual([
			{ accountKey: PERSONAL, requests: 85, share: 0.85 },
			{ accountKey: SPECTRUM, requests: 15, share: 0.15 },
		]);
		const personal = stats.accounts.find(a => a.key === PERSONAL);
		expect(personal).toMatchObject({
			recentRequests: 85,
			recentShare: 0.85,
			servingNow: true,
			servedLatestNewSession: false,
		});
		expect(routing.newSessions).toMatchObject({ sessions: 0, lastAccount: null, lastAccountSince: null });
	});

	it("finds the last new-session assignment change within the range only", () => {
		const now = Date.now();
		const start = (credentialId: number, at: number) => ({
			sessionFile: `s-${at}`,
			provider: "anthropic",
			credentialId,
			at,
		});
		const sessionStarts = [
			start(1, now - 5 * HOUR),
			start(1, now - 4 * HOUR),
			start(3, now - 3 * HOUR),
			start(1, now - 2 * HOUR),
			start(1, now - 30 * MINUTE),
		];
		const agent = { credentials: ROUTING_CREDENTIALS, blocks: [], quotas: [], accountKeys: [] };
		const wide = buildAccountStats({
			inRange: [],
			allTime: [],
			recent: [],
			sessionStarts,
			rangeCutoff: now - DAY,
			agent,
			nowMs: now,
		});
		expect(wide.routing[0].lastAssignmentChange).toEqual({
			fromAccountKey: PERSONAL,
			toAccountKey: SPECTRUM,
			at: now - 2 * HOUR,
		});
		expect(wide.routing[0].newSessions).toMatchObject({
			sessions: 1,
			lastAccount: SPECTRUM,
			lastAccountSince: now - 2 * HOUR,
		});

		// The change happened before the range: none in range.
		const narrow = buildAccountStats({
			inRange: [],
			allTime: [],
			recent: [],
			sessionStarts: sessionStarts.filter(s => s.at >= now - 90 * MINUTE),
			rangeCutoff: now - 90 * MINUTE,
			agent,
			nowMs: now,
		});
		expect(narrow.routing[0].lastAssignmentChange).toBeNull();
	});

	it("takes the latest new-session account from each session's first request, not from older sessions' traffic", async () => {
		const now = Date.now();
		await createAgentDb({
			credentials: [
				{ id: 1, identityKey: "email:team@example.com|org:org-1" },
				{ id: 3, identityKey: "email:me@example.com|org:org-3" },
			],
		});
		// An older session on #1 keeps sending traffic; the new session's first request was served by #3.
		await writeSession("older.jsonl", [
			assistantEntry("p-1", now - 3 * HOUR, 1),
			assistantEntry("p-2", now - 5 * MINUTE, 1),
			assistantEntry("p-3", now - MINUTE, 1),
		]);
		await writeSession("fresh.jsonl", [
			assistantEntry("f-1", now - 40 * MINUTE, 3),
			assistantEntry("f-2", now - 2 * MINUTE, 3),
		]);
		await writeSession("keyless.jsonl", [assistantEntry("k-1", now - 10 * MINUTE)]);
		// A subagent of the older session starts inside the window on its parent's credential: not a new session.
		await writeSession("older/Reviewer.jsonl", [assistantEntry("r-1", now - 20 * MINUTE, 1)]);
		await syncAllSessions();

		const day = await getAccountDashboardStats("24h");
		expect(day.routing).toHaveLength(1);
		const [routing] = day.routing;
		expect(routing.recent.accounts.map(a => [a.accountKey, a.requests])).toEqual([
			[SPECTRUM, 2],
			[PERSONAL, 1],
		]);
		expect(routing.newSessions).toMatchObject({
			sessions: 1,
			accounts: [{ accountKey: PERSONAL, sessions: 1 }],
			lastAccount: PERSONAL,
			lastAccountSince: now - 40 * MINUTE,
		});
		expect(routing.lastAssignmentChange).toEqual({
			fromAccountKey: SPECTRUM,
			toAccountKey: PERSONAL,
			at: now - 40 * MINUTE,
		});
		const byKey = new Map(day.accounts.map(a => [a.key, a]));
		expect(byKey.get(PERSONAL)).toMatchObject({ servedLatestNewSession: true, servingNow: true });
		expect(byKey.get(SPECTRUM)).toMatchObject({ servedLatestNewSession: false, servingNow: true });

		// Over the last hour the older session's start is out of range, so no assignment change is observed.
		expect((await getAccountDashboardStats("1h")).routing[0].lastAssignmentChange).toBeNull();
	});
});

describe("account identity", () => {
	it("merges a numbered provider's login into the base account through the usage-history account uuid", () => {
		const stats = buildAccountStats({
			inRange: [
				traffic({ credentialId: 3, requests: 5 }),
				traffic({ credentialId: 6, provider: "anthropic-2", requests: 2 }),
			],
			allTime: [],
			...NO_ROUTING,
			agent: {
				credentials: [
					oauth(3, "email:a@x.io|org:o"),
					{ ...oauth(6, "account:U"), provider: "anthropic-2" },
					// No usage-history key names this uuid: nothing to merge it with.
					{ ...oauth(7, "account:V"), provider: "anthropic-2" },
				],
				blocks: [],
				quotas: [],
				accountKeys: ["oauth|account:U|email:a@x.io|org:o"],
			},
			nowMs: Date.now(),
		});
		expect(stats.accounts.map(a => [a.provider, a.label, a.credentialIds, a.requests])).toEqual([
			["anthropic", "a@x.io", [3, 6], 7],
			["anthropic-2", "account:V", [7], 0],
		]);
		// The totals still count each request under its own provider, like the Providers page.
		expect(stats.providerTotals).toEqual([
			{ provider: "anthropic", requests: 5, accountRequests: 5, unattributedRequests: 0 },
			{ provider: "anthropic-2", requests: 2, accountRequests: 2, unattributedRequests: 0 },
		]);
	});

	it("labels a bare account uuid with its email even without a sibling to merge into", () => {
		const stats = buildAccountStats({
			inRange: [],
			allTime: [],
			...NO_ROUTING,
			agent: {
				credentials: [{ ...oauth(6, "account:U"), provider: "anthropic-2" }],
				blocks: [],
				quotas: [],
				accountKeys: ["oauth|account:U|email:a@x.io|org:o"],
			},
			nowMs: Date.now(),
		});
		expect(stats.accounts.map(a => [a.provider, a.label, a.orgId])).toEqual([["anthropic-2", "a@x.io", "o"]]);
	});
});

describe("provider totals", () => {
	it("splits each provider's total into accounts plus unattributed, matching the Providers page", async () => {
		const now = Date.now();
		await createAgentDb({
			credentials: [
				{ id: 1, identityKey: "email:team@example.com|org:org-1" },
				{ id: 3, identityKey: "email:me@example.com|org:org-3" },
				{ id: 5, provider: "openai-codex", identityKey: "email:me@example.com|org:org-5" },
			],
		});
		await writeSession("mix.jsonl", [
			assistantEntry("m-1", now - 50 * MINUTE, 1),
			assistantEntry("m-2", now - 40 * MINUTE, 3),
			assistantEntry("m-3", now - 30 * MINUTE, 3),
			assistantEntry("m-4", now - 20 * MINUTE),
			modelUsageEntry("m-5", now - 10 * MINUTE),
			assistantEntry("m-6", now - 5 * MINUTE, 5, "openai-codex"),
		]);
		await syncAllSessions();

		const [stats, providers] = await Promise.all([getAccountDashboardStats("24h"), getProviderDashboardStats("24h")]);
		expect(stats.providerTotals.map(p => [p.provider, p.requests]).sort()).toEqual(
			providers.providers.map(p => [p.provider, p.totalRequests]).sort(),
		);
		for (const totals of stats.providerTotals) {
			const onAccounts = stats.accounts
				.filter(a => a.provider === totals.provider)
				.reduce((sum, a) => sum + a.requests, 0);
			const notTied = stats.unattributed.find(u => u.provider === totals.provider)?.requests ?? 0;
			expect([totals.accountRequests, totals.unattributedRequests]).toEqual([onAccounts, notTied]);
			expect(onAccounts + notTied).toBe(totals.requests);
		}
		expect(stats.providerTotals.find(p => p.provider === "anthropic")).toEqual({
			provider: "anthropic",
			requests: 5,
			accountRequests: 3,
			unattributedRequests: 2,
		});
	});
});

describe("account flow", () => {
	it("merges credentials of one account into one series and keeps unattributed separate", () => {
		const bucket = Date.UTC(2026, 10, 7, 14);
		const flow = buildAccountFlow(
			[
				{ timestamp: bucket, provider: "anthropic", credentialId: 3, requests: 500, totalTokens: 5000 },
				{ timestamp: bucket, provider: "anthropic", credentialId: 4, requests: 221, totalTokens: 2210 },
				{ timestamp: bucket, provider: "anthropic", credentialId: 1, requests: 131, totalTokens: 1310 },
				{ timestamp: bucket, provider: "anthropic", credentialId: null, requests: 40, totalTokens: 400 },
				{ timestamp: bucket + HOUR, provider: "anthropic", credentialId: 4, requests: 7, totalTokens: 70 },
			],
			{ credentials: ROUTING_CREDENTIALS, accountKeys: [] },
		);
		expect(flow.series.map(s => [s.key, s.label, s.accountKey]).sort()).toEqual(
			[
				[PERSONAL, "me@example.com", PERSONAL],
				[SPECTRUM, "team@example.com", SPECTRUM],
				["anthropic/unattributed", "Unattributed", null],
			].sort(),
		);
		expect(flow.points).toEqual([
			{ timestamp: bucket, key: PERSONAL, requests: 721, tokens: 7210 },
			{ timestamp: bucket, key: SPECTRUM, requests: 131, tokens: 1310 },
			{ timestamp: bucket, key: "anthropic/unattributed", requests: 40, tokens: 400 },
			{ timestamp: bucket + HOUR, key: PERSONAL, requests: 7, tokens: 70 },
		]);
	});

	it("serves account series from the rollups end to end", async () => {
		const now = Date.now();
		await createAgentDb({ credentials: [{ id: 3, identityKey: "email:me@example.com|org:org-3" }] });
		await writeSession("flow.jsonl", [assistantEntry("a-1", now - 2000, 3), modelUsageEntry("j-1", now - 1000)]);
		await syncAllSessions();
		const flow = await getAccountFlowStats("24h");
		const total = (key: string) => flow.points.filter(p => p.key === key).reduce((sum, p) => sum + p.requests, 0);
		expect(total(PERSONAL)).toBe(1);
		expect(total("anthropic/unattributed")).toBe(1);
	});
});

describe("resolveAccountStatus", () => {
	const now = Date.UTC(2026, 10, 7, 12);
	const recent = now - HOUR;
	const stale = now - 2 * DAY;

	it("orders needs_login > blocked > active > idle > never", () => {
		expect(resolveAccountStatus({ needsLogin: true, blocked: true, lastUsed: recent }, now)).toBe("needs_login");
		expect(resolveAccountStatus({ needsLogin: false, blocked: true, lastUsed: recent }, now)).toBe("blocked");
		expect(resolveAccountStatus({ needsLogin: false, blocked: false, lastUsed: recent }, now)).toBe("active");
		expect(resolveAccountStatus({ needsLogin: false, blocked: false, lastUsed: stale }, now)).toBe("idle");
		expect(resolveAccountStatus({ needsLogin: false, blocked: false, lastUsed: null }, now)).toBe("never");
	});

	it("counts the last 24 hours as active regardless of the selected range", () => {
		expect(resolveAccountStatus({ needsLogin: false, blocked: false, lastUsed: now - DAY }, now)).toBe("active");
		expect(resolveAccountStatus({ needsLogin: false, blocked: false, lastUsed: now - DAY - 1 }, now)).toBe("idle");
	});
});
