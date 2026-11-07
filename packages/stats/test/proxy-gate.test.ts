import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
	createProxyGate,
	proxyRequestMac,
	proxyResponseProof,
	readProxyKey,
	STATS_PROXY_AUTH_HEADER,
	STATS_PROXY_NONCE_HEADER,
	STATS_PROXY_PROOF_HEADER,
	STATS_PROXY_TIME_HEADER,
} from "../src/proxy-gate";
import { startServer } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-proxy-gate-");

const KEY_A = "a".repeat(64);
const KEY_B = "0123456789abcdef".repeat(4);
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A key file the way the hub writes it: 0600 in a 0700 directory. */
function keyFile(key: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stats-proxy-"));
	dirs.push(dir);
	fs.chmodSync(dir, 0o700);
	const file = path.join(dir, "stats-proxy.key");
	fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
	return file;
}

/** The hub's replacement of the key: a new file renamed over the old one. */
function rotate(file: string, key: string): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Headers the hub sends for one request, signed with `key`. */
function signed(
	key: string,
	method: string,
	target: string,
	options: { nonce?: string; time?: number; host?: string } = {},
): Record<string, string> {
	const nonce = options.nonce ?? randomBytes(16).toString("hex");
	const time = String(options.time ?? Date.now());
	return {
		host: options.host ?? "127.0.0.1:3850",
		[STATS_PROXY_TIME_HEADER]: time,
		[STATS_PROXY_NONCE_HEADER]: nonce,
		[STATS_PROXY_AUTH_HEADER]: proxyRequestMac(Buffer.from(key, "hex"), method, target, time, nonce),
	};
}

function request(target: string, headers: Record<string, string>, method = "GET"): Request {
	return new Request(`http://127.0.0.1:3850${target}`, { method, headers });
}

/** A request with exactly these headers (fetch would not let a test forge Host). */
function rawRequest(
	port: number,
	method: string,
	urlPath: string,
	headers: Record<string, string>,
): Promise<{ status: number; proof: string | undefined }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; proof: string | undefined }>();
	const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, res => {
		const proof = res.headers[STATS_PROXY_PROOF_HEADER.toLowerCase()];
		// The event stream never ends on its own: the status and headers are all this needs.
		res.destroy();
		resolve({ status: res.statusCode ?? 0, proof: typeof proof === "string" ? proof : undefined });
	});
	req.on("error", reject);
	req.end();
	return promise;
}

describe("readProxyKey", () => {
	it("reads a private key file", () => {
		expect(readProxyKey(keyFile(KEY_A))?.key.toString("hex")).toBe(KEY_A);
	});

	it("refuses a file others can read, a loose directory, a symlink, or a malformed key", () => {
		const loose = keyFile(KEY_A);
		fs.chmodSync(loose, 0o644);
		expect(readProxyKey(loose)).toBeNull();

		const looseDir = keyFile(KEY_A);
		fs.chmodSync(path.dirname(looseDir), 0o755);
		expect(readProxyKey(looseDir)).toBeNull();

		const target = keyFile(KEY_A);
		const link = path.join(path.dirname(target), "link.key");
		fs.symlinkSync(target, link);
		expect(readProxyKey(link)).toBeNull();

		expect(readProxyKey(keyFile("not-a-key"))).toBeNull();
		expect(readProxyKey(path.join(os.tmpdir(), "missing-omp-stats-proxy.key"))).toBeNull();
	});
});

describe("createProxyGate", () => {
	it("signs exactly like the hub (fixed vector shared with the hub's own tests)", () => {
		const key = Buffer.from(KEY_A, "hex");
		const nonce = "0".repeat(32);
		expect(proxyRequestMac(key, "GET", "/api/status", "1000", nonce)).toBe(
			"4d2b8732016a4f08f9d904ba43b010240f4c8789e5bbc2f85241942138611aa4",
		);
		expect(proxyResponseProof(key, nonce)).toBe("ac567d63c7d757392cb83b52a3e79ebf12bb9f996d30f64f3d79259d567f7818");
	});

	it("accepts a signed request and answers with the proof for its nonce", () => {
		const gate = createProxyGate(keyFile(KEY_A));
		const headers = signed(KEY_A, "GET", "/api/stats/overview?range=7d");
		const proof = gate.check(request("/api/stats/overview?range=7d", headers), 3850);
		expect(proof).toBe(proxyResponseProof(Buffer.from(KEY_A, "hex"), headers[STATS_PROXY_NONCE_HEADER]));
	});

	it("refuses a wrong key, another method or target, a wrong Host, and a stale time", () => {
		const gate = createProxyGate(keyFile(KEY_A));
		const target = "/api/stats/overview?range=7d";
		expect(gate.check(request(target, signed(KEY_B, "GET", target)), 3850)).toBeNull();
		expect(gate.check(request(target, signed(KEY_A, "POST", target)), 3850)).toBeNull();
		expect(gate.check(request(target, signed(KEY_A, "GET", "/api/stats/overview?range=1h")), 3850)).toBeNull();
		expect(gate.check(request("/api/sync", signed(KEY_A, "GET", "/api/sync"), "POST"), 3850)).toBeNull();
		for (const host of ["evil.example:3850", "localhost:3850", "127.0.0.1:3851"]) {
			expect(gate.check(request(target, signed(KEY_A, "GET", target, { host })), 3850)).toBeNull();
		}
		expect(
			gate.check(request(target, signed(KEY_A, "GET", target, { time: Date.now() - 120_000 })), 3850),
		).toBeNull();
		expect(gate.check(request(target, {}), 3850)).toBeNull();
	});

	it("accepts each nonce once", () => {
		const gate = createProxyGate(keyFile(KEY_A));
		const headers = signed(KEY_A, "GET", "/api/status");
		expect(gate.check(request("/api/status", headers), 3850)).not.toBeNull();
		expect(gate.check(request("/api/status", headers), 3850)).toBeNull();
	});

	it("follows a rotated key at once, and a flood of bad requests can't delay it", () => {
		const file = keyFile(KEY_A);
		const gate = createProxyGate(file);
		for (let i = 0; i < 50; i++) {
			expect(gate.check(request("/api/status", signed(KEY_B, "GET", "/api/status")), 3850)).toBeNull();
		}
		rotate(file, KEY_B);
		expect(gate.check(request("/api/status", signed(KEY_B, "GET", "/api/status")), 3850)).not.toBeNull();
		expect(gate.check(request("/api/status", signed(KEY_A, "GET", "/api/status")), 3850)).toBeNull();
	});

	it("denies everything while the key file is missing", () => {
		const gate = createProxyGate(path.join(os.tmpdir(), "missing-omp-stats-proxy.key"));
		expect(gate.check(request("/api/status", signed(KEY_A, "GET", "/api/status")), 3850)).toBeNull();
	});
});

describe("startServer behind the proxy", () => {
	it("answers only signed requests, with a proof, and never closes from its page", async () => {
		const server = await startServer(0, "127.0.0.1", { proxyKeyFile: keyFile(KEY_A) });
		try {
			const host = `127.0.0.1:${server.port}`;
			const sign = (method: string, target: string, key = KEY_A) => signed(key, method, target, { host });
			for (const target of ["/api/events", "/api/session/entry?file=x&id=y", "/api/stats/overview", "/"]) {
				const unsigned = await rawRequest(server.port, "GET", target, { Host: host });
				expect(unsigned).toEqual({ status: 403, proof: undefined });
				expect((await rawRequest(server.port, "GET", target, sign("GET", target, KEY_B))).status).toBe(403);
			}
			const forgedHost = signed(KEY_A, "GET", "/api/close", { host: "attacker.example" });
			expect((await rawRequest(server.port, "GET", "/api/close", forgedHost)).status).toBe(403);

			const close = sign("GET", "/api/close");
			const closed = await rawRequest(server.port, "GET", "/api/close", close);
			expect(closed.status).toBe(404);
			expect(closed.proof).toBe(proxyResponseProof(Buffer.from(KEY_A, "hex"), close[STATS_PROXY_NONCE_HEADER]));

			const events = sign("GET", "/api/events");
			const stream = await rawRequest(server.port, "GET", "/api/events", events);
			expect(stream.status).toBe(200);
			expect(stream.proof).toBe(proxyResponseProof(Buffer.from(KEY_A, "hex"), events[STATS_PROXY_NONCE_HEADER]));

			expect(
				(await rawRequest(server.port, "GET", "/api/no-such-route", sign("GET", "/api/no-such-route"))).status,
			).toBe(404);
		} finally {
			server.stop();
		}
	});

	it("binds exactly the requested port or fails", async () => {
		const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("held") });
		try {
			await expect(
				startServer(holder.port as number, "127.0.0.1", { proxyKeyFile: keyFile(KEY_A) }),
			).rejects.toThrow();
		} finally {
			holder.stop(true);
		}
	});
});
