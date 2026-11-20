import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, currentDb, initDb } from "@oh-my-pi/omp-stats/db";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-subagents-");

const when = 1_700_000_000_000;
const iso = new Date(when).toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

async function fixture(count = 5, large = false, regression = false) {
	const dir = path.join(getSessionsDir(), "--fixture--");
	const root = path.join(dir, "1700000000000_root.jsonl");
	const children = root.slice(0, -6);
	await fs.mkdir(children, { recursive: true });
	await Bun.write(
		root,
		JSON.stringify({ type: "session", version: 3, id: "root", timestamp: iso, cwd: "/tmp" }) + "\n",
	);
	for (let i = 0; i < count; i++) {
		const name = `child${String(i).padStart(2, "0")}`;
		const entries: unknown[] = [
			{ type: "session", version: 3, id: name, timestamp: iso, cwd: "/tmp" },
			{
				type: "session_init",
				id: `init-${name}`,
				parentId: null,
				timestamp: iso,
				agent: large ? "😊".repeat(80) : "scout",
				task: large ? "😊".repeat(120) : "inspect",
			},
			{
				type: "message",
				id: `assistant-${name}`,
				parentId: `init-${name}`,
				timestamp: iso,
				message: {
					role: "assistant",
					model: "model",
					provider: "test",
					api: "openai-completions",
					timestamp: when,
					usage,
					stopReason: regression && i === 4 ? undefined : ["stop", "length", "toolUse", "aborted", "error"][i % 5],
					content:
						i % 5 === 2
							? [{ type: "toolCall", id: `call-${name}`, name: "bash", arguments: {} }]
							: [{ type: "text", text: "done" }],
				},
			},
		];
		if (regression && (i === 0 || i === 2)) {
			entries.push({
				type: "model_usage",
				id: `probe-${name}`,
				parentId: null,
				timestamp: new Date(when + 1000).toISOString(),
				purpose: "completion-probe",
				api: "openai-completions",
				provider: "test",
				model: "probe",
				stopReason: i === 0 ? "error" : "stop",
				usage,
			});
		}
		const child = path.join(children, `${name}.jsonl`);
		await Bun.write(child, entries.map(x => JSON.stringify(x)).join("\n") + "\n");
		await fs.utimes(child, new Date(when), new Date(when));
	}
	await syncAllSessions();
	currentDb()!.run(
		"INSERT INTO tool_calls (session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp, is_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
		[path.join(children, "child00.jsonl"), "assistant-child00", "error-call", "/tmp", "bash", "model", "test", when],
	);
	return root;
}

async function request(file: string, parentLive = false) {
	return handleApi(
		new Request(
			`http://localhost/api/session/subagents?file=${encodeURIComponent(file)}${parentLive ? "&parentLive=1" : ""}`,
		),
	);
}

describe("session subagents", () => {
	it("reports final and unfinished statuses independently of parent liveness", async () => {
		const root = await fixture();
		const before = await (await request(root)).json();
		expect(before.map((row: { status: string }) => row.status)).toEqual([
			"done",
			"cut_off",
			"cut_off",
			"cut_off",
			"cut_off",
		]);
		expect(before[0]).toMatchObject({ agent: "scout", title: "inspect", toolErrors: 1 });
		const live = await (await request(root, true)).json();
		expect(live.map((row: { status: string }) => row.status)).toEqual([
			"done",
			"cut_off",
			"running",
			"cut_off",
			"cut_off",
		]);
		const again = await (await request(root)).json();
		expect(again[2].status).toBe("cut_off");
		await fs.utimes(path.join(root.slice(0, -6), "child02.jsonl"), new Date(), new Date());
		const recent = await (await request(root)).json();
		expect(recent[2].status).toBe("running");
	});
	it("ignores later housekeeping and preserves absent stop reasons", async () => {
		const root = await fixture(5, false, true);
		let rows = await (await request(root)).json();
		expect(rows[0].status).toBe("done");
		expect(rows[2].status).toBe("cut_off");
		expect(rows[3].status).toBe("cut_off");
		expect(rows[4].status).toBe("unknown");
		rows = await (await request(root, true)).json();
		expect(rows[0].status).toBe("done");
		expect(rows[2].status).toBe("running");
		expect(rows[3].status).toBe("cut_off");
		expect(rows[4].status).toBe("running");
		await fs.utimes(path.join(root.slice(0, -6), "child04.jsonl"), new Date(), new Date());
		rows = await (await request(root)).json();
		expect(rows[4].status).toBe("running");
	});
	it("backfills stop-reason presence on an existing index", async () => {
		const root = await fixture(5, false, true);
		const db = currentDb()!;
		db.run("UPDATE messages SET stop_reason_present = NULL");
		db.run("DELETE FROM meta WHERE key = 'messages_stop_reason_presence_v1'");
		closeDb();
		await initDb();
		await syncAllSessions();
		const rows = await (await request(root, true)).json();
		expect(rows[3].status).toBe("cut_off");
		expect(rows[4].status).toBe("running");
	});
	it("caps child count and response bytes", async () => {
		const root = await fixture(55);
		const response = await request(root);
		const text = await response.text();
		expect(Buffer.byteLength(text)).toBeLessThan(20 * 1024);
		expect(JSON.parse(text)).toHaveLength(50);
	});
	it("keeps even oversized metadata under the response limit", async () => {
		const root = await fixture(55, true);
		const text = await (await request(root)).text();
		expect(Buffer.byteLength(text)).toBeLessThan(20_000);
		expect(JSON.parse(text).length).toBeGreaterThan(0);
	});
	it("rejects paths outside the sessions directory", async () => {
		expect((await request("/tmp/escape.jsonl")).status).toBe(400);
	});
});
