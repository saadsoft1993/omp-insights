import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLiveTrafficStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getRecentRequests, getTranscriptActivity, type LiveRequestRow } from "@oh-my-pi/omp-stats/db";
import {
	AGENT_RECENT_MS,
	AGENT_SILENT_MS,
	agentName,
	agentStatus,
	buildLiveTraffic,
	FLOW_WINDOW_MS,
	type GatewayInfo,
	hasQuotaWarning,
	liveAccountState,
	loadGateways,
	projectLabel,
} from "@oh-my-pi/omp-stats/live-traffic";
import {
	emptyActivity,
	mergeActivity,
	type TranscriptActivityRow,
	trackActivity,
} from "@oh-my-pi/omp-stats/transcript-activity";
import type { AccountQuotaWindow, AccountStats } from "@oh-my-pi/omp-stats/types";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const isolation = installStatsTestIsolation("@pi-stats-live-");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const NOW = Date.UTC(2026, 10, 7, 14, 30);
const SESSIONS = "/sessions";
const ROOT = `${SESSIONS}/-projects-acme-shop/2026-11-07T08-43-59-892Z_01a1b52d.jsonl`;
const SUBAGENT = `${SESSIONS}/-projects-acme-shop/2026-11-07T08-43-59-892Z_01a1b52d/Reviewer.jsonl`;
const OTHER = `${SESSIONS}/-projects-other-app/2026-11-07T12-00-00-000Z_02b2.jsonl`;

function quota(usedFraction: number | null): AccountQuotaWindow {
	return {
		limitId: "anthropic:7d",
		label: "Claude 7 Day",
		windowLabel: "7 Day",
		usedFraction,
		status: "ok",
		resetsAt: NOW + MINUTE,
		recordedAt: NOW - MINUTE,
	};
}

function account(overrides: Partial<AccountStats> & { key: string; credentialIds: number[] }): AccountStats {
	return {
		provider: "anthropic",
		label: overrides.key,
		email: null,
		orgId: null,
		credentialType: "oauth",
		status: "active",
		disabledCause: null,
		blocks: [],
		requests: 0,
		failedRequests: 0,
		totalTokens: 0,
		totalCost: 0,
		unpricedRequests: 0,
		lastUsed: NOW - 2 * MINUTE,
		requestShare: 0,
		tokenShare: 0,
		quotas: [],
		recentRequests: 0,
		recentShare: 0,
		servingNow: false,
		servedLatestNewSession: false,
		...overrides,
	};
}

function row(
	sessionFile: string,
	ageMs: number,
	credentialId: number | null,
	provider = "anthropic",
	usagePurpose: string | null = null,
): LiveRequestRow {
	return {
		sessionFile,
		provider,
		credentialId,
		model: "claude-opus-5-5",
		tokens: 100,
		timestamp: NOW - ageMs,
		usagePurpose,
	};
}

const PERSONAL = account({
	key: "anthropic/email:me@example.com|org:o3",
	label: "me@example.com",
	credentialIds: [3, 6],
});
const TEAM = account({ key: "anthropic/email:team@example.com|org:o1", label: "team@example.com", credentialIds: [1] });

function snapshot(
	rows: LiveRequestRow[],
	options: { accounts?: AccountStats[]; gateways?: Map<string, GatewayInfo>; activity?: TranscriptActivityRow[] } = {},
) {
	return buildLiveTraffic({
		rows,
		activity: options.activity ?? [],
		accounts: options.accounts ?? [PERSONAL, TEAM],
		lastNoAccount: new Map([["gateway", NOW - 3 * 60 * MINUTE]]),
		gateways: options.gateways ?? new Map(),
		metadata: new Map([[ROOT, { title: "Fix enrolment report", cwd: "/Users/me/projects/acme-shop" }]]),
		sessionsDir: SESSIONS,
		nowMs: NOW,
	});
}

describe("buildLiveTraffic", () => {
	it("counts a subagent transcript as its parent session", () => {
		const live = snapshot([row(ROOT, 30 * SECOND, 3), row(SUBAGENT, 20 * SECOND, 6), row(OTHER, 10 * SECOND, 1)]);
		expect(live.sessions.map(s => [s.id, s.name, s.project, s.rpm])).toEqual([
			[OTHER, "other-app", "other-app", 1],
			[ROOT, "Fix enrolment report", "acme-shop", 2],
		]);
		expect(live.sessions.find(s => s.id === ROOT)?.started).toBe(Date.UTC(2026, 10, 7, 8, 43, 59, 892));
		// Credentials 3 and 6 are one account: one line from the session, carrying both requests.
		expect(live.edges).toContainEqual({ from: ROOT, to: PERSONAL.key, rpm: 2, last: NOW - 20 * SECOND });
		expect(live.recent.map(r => r.session)).toEqual([OTHER, ROOT, ROOT]);
		// The label is the email already, so the card names the credentials behind the account.
		expect(live.targets.find(t => t.key === PERSONAL.key)?.meta).toBe("credential #3, #6");
	});

	it("counts rates over the last minute and keeps the five-minute window for lines", () => {
		const live = snapshot([
			row(ROOT, 4 * MINUTE, 1),
			row(ROOT, 40 * SECOND, 3),
			row(ROOT, 10 * SECOND, 3),
			// Older than five minutes: not shown at all.
			row(OTHER, FLOW_WINDOW_MS + SECOND, 3),
		]);
		const edge = (to: string) => live.edges.find(e => e.from === ROOT && e.to === to);
		expect(edge(PERSONAL.key)?.rpm).toBe(2);
		// Traffic in the last five minutes but not the last minute: a dashed line (rpm 0).
		expect(edge(TEAM.key)).toEqual({ from: ROOT, to: TEAM.key, rpm: 0, last: NOW - 4 * MINUTE });
		expect(live.sessions.map(s => s.id)).toEqual([ROOT]);
		const target = (key: string) => live.targets.find(t => t.key === key);
		expect([target(PERSONAL.key)?.rpm, target(PERSONAL.key)?.tpm, target(PERSONAL.key)?.state]).toEqual([
			2,
			200,
			"active",
		]);
		expect([target(TEAM.key)?.rpm, target(TEAM.key)?.state, target(TEAM.key)?.last]).toEqual([
			0,
			"quiet",
			NOW - 4 * MINUTE,
		]);
		expect(live.recent).toHaveLength(3);
	});

	it("splits requests with no account recorded into housekeeping and turns", () => {
		const live = snapshot([
			row(ROOT, 4 * MINUTE, null, "anthropic", "job-widget"),
			row(ROOT, 3 * MINUTE, null, "anthropic", "auto-thinking"),
			row(ROOT, 2 * MINUTE, null, "anthropic", "job-widget"),
			// An ordinary turn made with an API key: no credential either, but not housekeeping.
			row(ROOT, 10 * SECOND, null),
		]);
		expect(live.targets.find(t => t.key === "anthropic/none")).toMatchObject({
			kind: "no_account",
			label: "No account recorded",
			meta: "account not recorded in the session log",
			state: "active",
			rpm: 1,
			breakdown: {
				housekeeping: 3,
				turns: 1,
				purposes: [
					{ purpose: "job-widget", requests: 2 },
					{ purpose: "auto-thinking", requests: 1 },
				],
			},
		});
		expect(live.edges).toEqual([{ from: ROOT, to: "anthropic/none", rpm: 1, last: NOW - 10 * SECOND }]);
		// Requests on an account never land in a breakdown.
		expect(live.targets.find(t => t.key === PERSONAL.key)?.breakdown).toBeNull();
	});

	it("names gateways after their models and shows configured ones while idle", () => {
		const gateways = new Map<string, GatewayInfo>([
			["gateway", { name: "Team Gateway", host: "llm.example.com" }],
			["idle-gw", { name: "Idle Model", host: null }],
		]);
		const live = snapshot([row(ROOT, 10 * SECOND, null, "gateway")], { gateways });
		expect(live.targets.find(t => t.key === "gateway/none")).toMatchObject({
			kind: "gateway",
			label: "Team Gateway",
			meta: "API-key gateway · llm.example.com",
			state: "active",
			rpm: 1,
		});
		expect(live.targets.find(t => t.key === "idle-gw/none")).toMatchObject({
			kind: "gateway",
			label: "Idle Model",
			meta: "API-key gateway",
			state: "quiet",
			rpm: 0,
			last: null,
		});
	});

	it("separates the quota warning from the rate-limited state", () => {
		const nearlyFull = account({ key: "a", credentialIds: [1], quotas: [quota(0.97)] });
		const blocked = account({ key: "b", credentialIds: [2], status: "blocked" });
		const live = snapshot([row(ROOT, 10 * SECOND, 1)], { accounts: [nearlyFull, blocked] });
		const byKey = new Map(live.targets.map(t => [t.key, t]));
		expect([byKey.get("a")?.state, byKey.get("a")?.quotaWarning]).toEqual(["active", true]);
		expect([byKey.get("b")?.state, byKey.get("b")?.quotaWarning]).toEqual(["rate_limited", false]);
	});
});

describe("live state rules", () => {
	it("maps only blocks to rate_limited and keeps needs_login", () => {
		expect(liveAccountState({ status: "blocked" }, 5)).toBe("rate_limited");
		expect(liveAccountState({ status: "needs_login" }, 5)).toBe("needs_login");
		expect(liveAccountState({ status: "active" }, 1)).toBe("active");
		expect(liveAccountState({ status: "idle" }, 0)).toBe("quiet");
	});

	it("warns on a current window at 95% or more and ignores reset windows", () => {
		expect(hasQuotaWarning({ quotas: [quota(0.95)] })).toBe(true);
		expect(hasQuotaWarning({ quotas: [quota(0.94)] })).toBe(false);
		expect(hasQuotaWarning({ quotas: [quota(null)] })).toBe(false);
	});

	it("shortens omp's session folder names", () => {
		expect(projectLabel("-projects-acme-shop")).toBe("acme-shop");
		expect(projectLabel("--private-tmp--")).toBe("private-tmp");
	});
});

describe("loadGateways", () => {
	it("reads model names and host from models.yml, never the key, and tolerates a missing file", async () => {
		const file = path.join(isolation.current()?.path() ?? "", "models.yml");
		expect(loadGateways(file).size).toBe(0);
		await Bun.write(
			file,
			[
				"providers:",
				"  gateway:",
				"    baseUrl: https://llm.example.com/v1",
				"    apiKey: sk-secret",
				"    models:",
				"      - id: team-gateway-coding",
				"        name: Team Gateway",
				"  bare:",
				"    models:",
				"      - id: plain-model",
				"",
			].join("\n"),
		);
		const gateways = loadGateways(file);
		expect(Object.fromEntries(gateways)).toEqual({
			gateway: { name: "Team Gateway", host: "llm.example.com" },
			bare: { name: "plain-model", host: null },
		});
		expect(JSON.stringify(Object.fromEntries(gateways))).not.toContain("sk-secret");
	});
});

describe("getLiveTrafficStats", () => {
	it("serves the live snapshot from freshly ingested rows", async () => {
		const now = Date.now();
		const dir = path.join(getSessionsDir(), "--tmp--live");
		await fs.mkdir(path.join(dir, "root"), { recursive: true });
		const entry = (id: string, at: number) =>
			JSON.stringify({
				type: "message",
				id,
				parentId: null,
				timestamp: new Date(at).toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "stop",
					timestamp: at,
					usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
				},
			});
		const housekeeping = JSON.stringify({
			type: "model_usage",
			id: "w-1",
			parentId: null,
			timestamp: new Date(now - 3 * SECOND).toISOString(),
			purpose: "job-widget",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		});
		await Bun.write(path.join(dir, "root.jsonl"), `${entry("r-1", now - 5 * SECOND)}\n${housekeeping}\n`);
		await Bun.write(path.join(dir, "root", "Helper.jsonl"), `${entry("h-1", now - 2 * SECOND)}\n`);
		await fs.mkdir(getAgentDir(), { recursive: true });
		await syncAllSessions();

		const live = await getLiveTrafficStats();
		expect(live.sessions).toHaveLength(1);
		expect(live.sessions[0]).toMatchObject({ id: path.join(dir, "root.jsonl"), rpm: 3 });
		// The two turns carry no credential (an API key, say) and stay turns; only the model_usage entry is housekeeping.
		expect(live.targets.find(t => t.key === "anthropic/none")).toMatchObject({
			kind: "no_account",
			rpm: 3,
			tpm: 22,
			breakdown: { housekeeping: 1, turns: 2, purposes: [{ purpose: "job-widget", requests: 1 }] },
		});
		const stored = new Map(getRecentRequests(10).map(r => [r.entryId, r.usagePurpose]));
		expect(Object.fromEntries(stored)).toEqual({ "r-1": null, "w-1": "job-widget", "h-1": null });
	});

	it("stores purpose and credential for lines appended to an already-synced transcript", async () => {
		const now = Date.now();
		const dir = path.join(getSessionsDir(), "--tmp--append");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		const turn = (id: string, at: number, credentialId?: number) =>
			JSON.stringify({
				type: "message",
				id,
				parentId: null,
				timestamp: new Date(at).toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "stop",
					timestamp: at,
					...(credentialId === undefined ? {} : { credentialId }),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				},
			});
		const housekeeping = (id: string, at: number, purpose: string) =>
			JSON.stringify({
				type: "model_usage",
				id,
				parentId: null,
				timestamp: new Date(at).toISOString(),
				purpose,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			});
		await Bun.write(
			file,
			`${turn("t-1", now - 60 * SECOND, 3)}\n${housekeeping("u-1", now - 50 * SECOND, "job-caption")}\n`,
		);
		await syncAllSessions();
		const firstSize = (await fs.stat(file)).size;

		// What the watcher and the Live poll do: the file grows, then only that file is synced from its stored offset.
		await fs.appendFile(
			file,
			`${housekeeping("u-2", now - 20 * SECOND, "job-widget")}\n${turn("t-2", now - 10 * SECOND, 4)}\n${turn("t-3", now - 5 * SECOND)}\n`,
		);
		expect((await fs.stat(file)).size).toBeGreaterThan(firstSize);
		await syncAllSessions({ files: [file] });

		const stored = Object.fromEntries(
			getRecentRequests(10)
				.filter(r => r.sessionFile === file)
				.map(r => [r.entryId, [r.credentialId, r.usagePurpose]]),
		);
		expect(stored).toEqual({
			"t-1": [3, null],
			"u-1": [null, "job-caption"],
			"u-2": [null, "job-widget"],
			"t-2": [4, null],
			"t-3": [null, null],
		});
	});
});

function activityRow(sessionFile: string, overrides: Partial<TranscriptActivityRow>): TranscriptActivityRow {
	return {
		sessionFile,
		parent: null,
		lastAt: null,
		toolName: null,
		toolIntent: null,
		toolAt: null,
		exitAt: null,
		exitReason: null,
		yieldedAt: null,
		...overrides,
	};
}

const SESSION_DIR = ROOT.replace(/\.jsonl$/, "");

describe("transcript activity", () => {
	it("keeps the last tool, exit and turn state, and merges a tail over what was stored", () => {
		const at = (ms: number) => new Date(NOW + ms).toISOString();
		const head = emptyActivity();
		for (const entry of [
			{ type: "session", id: "s", timestamp: at(0), cwd: "/x", version: 3, parentSession: ROOT },
			{
				type: "custom",
				customType: "tool_execution_start",
				timestamp: at(1000),
				data: { toolName: "bash", intent: "x".repeat(200), startedAt: at(1000), args: { command: "rm -rf /" } },
			},
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp: at(2000),
				message: { role: "assistant", stopReason: "stop" },
			},
		] as const) {
			trackActivity(head, entry as never);
		}
		const stored = mergeActivity(SUBAGENT, null, head);
		expect(stored).toMatchObject({
			parent: ROOT,
			lastAt: NOW + 2000,
			toolName: "bash",
			toolAt: NOW + 1000,
			yieldedAt: NOW + 2000,
		});
		expect(stored.toolIntent).toHaveLength(120);
		expect(JSON.stringify(stored)).not.toContain("rm -rf");

		// A tail: the user messages it again, then it exits. Earlier facts survive.
		const tail = emptyActivity();
		trackActivity(tail, {
			type: "message",
			id: "u",
			parentId: null,
			timestamp: at(5000),
			message: { role: "user" },
		} as never);
		trackActivity(tail, {
			type: "custom",
			customType: "session_exit",
			timestamp: at(6000),
			data: { reason: "dispose" },
		} as never);
		expect(mergeActivity(SUBAGENT, stored, tail)).toMatchObject({
			parent: ROOT,
			toolName: "bash",
			lastAt: NOW + 6000,
			yieldedAt: null,
			exitAt: NOW + 6000,
			exitReason: "dispose",
		});
	});
});

describe("live subagents", () => {
	it("names advisors and nested agents and derives their state", () => {
		expect(agentName(["__advisor.default.jsonl"])).toBe("Advisor");
		expect(agentName(["Lead", "Scout.jsonl"])).toBe("Lead/Scout");
		expect(agentStatus({ lastAt: NOW - 1000, exitAt: NOW - 1000, yieldedAt: null }, NOW)).toBe("finished");
		// Revived after an exit: later entries mean it is running again.
		expect(agentStatus({ lastAt: NOW - 1000, exitAt: NOW - 60_000, yieldedAt: null }, NOW)).toBe("running");
		expect(agentStatus({ lastAt: NOW - 1000, exitAt: null, yieldedAt: NOW - 1000 }, NOW)).toBe("idle");
		expect(agentStatus({ lastAt: NOW - AGENT_SILENT_MS - 1, exitAt: null, yieldedAt: null }, NOW)).toBe("stopped");
	});

	it("lists subagents inside their session with state, current tool and their share of the traffic", () => {
		const live = snapshot(
			[
				row(ROOT, 5 * SECOND, 3),
				row(`${SESSION_DIR}/Builder.jsonl`, 20 * SECOND, 3),
				row(`${SESSION_DIR}/Parked.jsonl`, 30 * SECOND, 1),
				row(`${SESSION_DIR}/__advisor.default.jsonl`, 2 * SECOND, null),
			],
			{
				activity: [
					activityRow(ROOT, {
						lastAt: NOW - 4 * SECOND,
						toolName: "task",
						toolIntent: "Delegating review",
						toolAt: NOW - 4 * SECOND,
					}),
					activityRow(`${SESSION_DIR}/Builder.jsonl`, {
						lastAt: NOW - 10 * SECOND,
						toolName: "bash",
						toolIntent: "Running tests",
						toolAt: NOW - 10 * SECOND,
					}),
					activityRow(`${SESSION_DIR}/Reviewer.jsonl`, { lastAt: NOW - 2 * MINUTE, exitAt: NOW - 110 * SECOND }),
					activityRow(`${SESSION_DIR}/Parked.jsonl`, { lastAt: NOW - 30 * SECOND, yieldedAt: NOW - 30 * SECOND }),
					activityRow(`${SESSION_DIR}/__advisor.default.jsonl`, { lastAt: NOW - 2 * SECOND }),
				],
			},
		);
		const [session] = live.sessions;
		// The session's own last tool, not one of its agents'.
		expect(session.doing).toEqual({ name: "task", intent: "Delegating review", at: NOW - 4 * SECOND });
		const agents = Object.fromEntries(session.agents.map(a => [a.name, a]));
		expect(agents.Builder).toMatchObject({
			status: "running",
			doing: { intent: "Running tests" },
			rpm: 1,
			targets: [PERSONAL.key],
		});
		expect(agents.Reviewer.status).toBe("finished");
		expect(agents.Parked).toMatchObject({ status: "idle", targets: [TEAM.key] });
		expect(agents.Advisor).toMatchObject({ status: "running", rpm: 1, targets: ["anthropic/none"] });
		expect(session.agentsRunning).toBe(2);
		// Main + Builder + Parked + Advisor within the minute.
		expect(session.rpm).toBe(4);
		expect(session.agents.map(a => a.status)).toEqual(["running", "running", "idle", "finished"]);
		expect(live.recent.find(r => r.agent === "Advisor")?.session).toBe(ROOT);
		expect(live.recent.find(r => r.ts === NOW - 5 * SECOND)?.agent).toBeNull();
	});

	it("drops agents once they are done, waiting or silent for long enough", () => {
		const file = (name: string) => `${SESSION_DIR}/${name}.jsonl`;
		const live = snapshot([], {
			activity: [
				activityRow(file("Running"), { lastAt: NOW - AGENT_SILENT_MS + MINUTE }),
				activityRow(file("StoppedRecently"), { lastAt: NOW - AGENT_SILENT_MS - MINUTE }),
				activityRow(file("StoppedLongAgo"), { lastAt: NOW - AGENT_SILENT_MS - FLOW_WINDOW_MS - MINUTE }),
				activityRow(file("IdleRecently"), {
					lastAt: NOW - AGENT_RECENT_MS + MINUTE,
					yieldedAt: NOW - AGENT_RECENT_MS + MINUTE,
				}),
				activityRow(file("IdleLongAgo"), {
					lastAt: NOW - AGENT_RECENT_MS - MINUTE,
					yieldedAt: NOW - AGENT_RECENT_MS - MINUTE,
				}),
				activityRow(file("FinishedLongAgo"), {
					lastAt: NOW - AGENT_RECENT_MS - MINUTE,
					exitAt: NOW - AGENT_RECENT_MS - MINUTE,
				}),
				activityRow(file("HourOld"), { lastAt: NOW - 60 * MINUTE, toolName: "bash", toolIntent: "x" }),
			],
		});
		const [session] = live.sessions;
		expect(Object.fromEntries(session.agents.map(a => [a.name, a.status]))).toEqual({
			Running: "running",
			IdleRecently: "idle",
			StoppedRecently: "stopped",
		});
		// A session listed only for its agents still shows, with no traffic of its own.
		expect([session.id, session.rpm, session.agentsRunning]).toEqual([ROOT, 0, 1]);
		expect(
			snapshot([], { activity: [activityRow(file("HourOld"), { lastAt: NOW - 60 * MINUTE })] }).sessions,
		).toEqual([]);
	});

	it("keeps a session working while its subagents run after its own turn ended", () => {
		const live = snapshot(
			[
				// The sms session's own last request was 4 minutes ago; another session sent one 2 minutes ago.
				row(ROOT, 4 * MINUTE, 3),
				row(OTHER, 2 * MINUTE, 3),
			],
			{
				activity: [
					activityRow(ROOT, { lastAt: NOW - 4 * MINUTE, yieldedAt: NOW - 4 * MINUTE }),
					activityRow(`${SESSION_DIR}/Builder.jsonl`, { lastAt: NOW - 20 * SECOND, toolName: "bash" }),
				],
			},
		);
		expect(live.sessions.map(s => [s.id, s.rpm, s.agentsRunning, s.working])).toEqual([
			[ROOT, 0, 1, true],
			[OTHER, 0, 0, false],
		]);
	});

	it("ingests agent activity from transcripts, including lines appended later", async () => {
		const now = Date.now();
		const at = (ms: number) => new Date(now + ms).toISOString();
		const root = path.join(getSessionsDir(), "--tmp--agents", "2026-11-07T08-00-00-000Z_s1.jsonl");
		const builder = path.join(getSessionsDir(), "--tmp--agents", "2026-11-07T08-00-00-000Z_s1", "Builder.jsonl");
		await fs.mkdir(path.dirname(builder), { recursive: true });
		const line = (value: unknown) => `${JSON.stringify(value)}\n`;
		const toolStart = (ms: number, intent: string) =>
			line({
				type: "custom",
				customType: "tool_execution_start",
				timestamp: at(ms),
				data: { toolName: "bash", intent, startedAt: at(ms), args: { command: "secret-arg" } },
			});
		await Bun.write(
			root,
			line({ type: "session", version: 3, id: "s1", timestamp: at(-60_000), cwd: "/tmp/agents" }) +
				toolStart(-50_000, "Delegating"),
		);
		await Bun.write(
			builder,
			line({
				type: "session",
				version: 3,
				id: "b1",
				timestamp: at(-40_000),
				cwd: "/tmp/agents",
				parentSession: root,
			}) + toolStart(-30_000, "Reading files"),
		);
		await syncAllSessions();
		await fs.appendFile(builder, toolStart(-5_000, "Running tests"));
		await syncAllSessions({ files: [builder] });

		const live = await getLiveTrafficStats();
		expect(live.sessions).toHaveLength(1);
		expect(live.sessions[0]).toMatchObject({ id: root, doing: { intent: "Delegating" }, agentsRunning: 1 });
		expect(live.sessions[0].agents).toEqual([
			expect.objectContaining({
				name: "Builder",
				status: "running",
				doing: { name: "bash", intent: "Running tests", at: now - 5_000 },
			}),
		]);
		const [stored] = getTranscriptActivity(0, [builder]).filter(r => r.sessionFile === builder);
		expect(stored.parent).toBe(root);
		expect(JSON.stringify(stored)).not.toContain("secret-arg");
	});
});
