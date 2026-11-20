import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { acceptsGzip, compressApiResponse, handleApi, startServer } from "@oh-my-pi/omp-stats/server";
import { buildSessionTrace, traceMemoKeysForTests } from "@oh-my-pi/omp-stats/trace";
import type { SessionTrace, SessionTraceTrackResponse } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-trace-route-");
const T = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function transcript(count: number): string {
	const entries: unknown[] = [{ type: "session", version: 3, id: "session", timestamp: iso(T), cwd: "/tmp/proj" }];
	for (let i = 0; i < count; i++) {
		entries.push({
			type: "message",
			id: `a${i}`,
			parentId: i ? `a${i - 1}` : null,
			timestamp: iso(T + i + 1),
			message: {
				role: "assistant",
				timestamp: T + i,
				completedAt: T + i + 1,
				content: [{ type: "text", text: "done" }],
			},
		});
	}
	return entries.map(entry => JSON.stringify(entry)).join("\n");
}

async function fixture(name: string, children: Record<string, number> = {}, rootSpans = 1): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--proj--");
	const file = path.join(dir, `${name}.jsonl`);
	await fs.mkdir(path.join(dir, name), { recursive: true });
	await Bun.write(file, transcript(rootSpans));
	await Promise.all(
		Object.entries(children).map(([child, count]) =>
			Bun.write(path.join(dir, name, `${child}.jsonl`), transcript(count)),
		),
	);
	return file;
}

function request(file: string, route = "trace", params = "", headers?: HeadersInit): Promise<Response> {
	return handleApi(
		new Request(`http://localhost/api/session/${route}?file=${encodeURIComponent(file)}${params}`, { headers }),
	);
}

describe("trace routes", () => {
	it("uses a short conditional ETag even with 450 long child names", async () => {
		const children = Object.fromEntries(
			Array.from({ length: 450 }, (_, i) => [`child${String(i).padStart(35, "0")}`, 0]),
		);
		const file = await fixture("etag", children);
		const response = await request(file);
		const etag = response.headers.get("etag")!;
		expect(etag).toMatch(/^"6:[\d.]+:\d+:[0-9a-f]{64}"$/);
		expect((await request(file, "trace", "", { "If-None-Match": etag })).status).toBe(304);
	}, 30_000);

	it("compacts large child tracks and serves a conditional full track", async () => {
		const file = await fixture("large", { Scout1: 2500, Scout2: 2501, Empty: 0 });
		const full = await buildSessionTrace(file);
		const response = await request(file);
		const trace = (await response.json()) as SessionTrace;
		expect(trace.summary).toEqual(full.summary);
		expect(trace.tracks[0]).toEqual(full.tracks[0]);
		expect(full.tracks.find(t => t.id === "Scout1")!.spans).toHaveLength(2500);
		expect(full.tracks.find(t => t.id === "Scout2")!.spans).toHaveLength(2501);
		for (const id of ["Scout1", "Scout2"]) {
			const child = trace.tracks.find(t => t.id === id)!;
			expect(child.spans).toEqual([]);
			expect(child.omittedSpans).toBe(full.tracks.find(t => t.id === id)!.spans.length);
		}
		expect(trace.tracks.find(t => t.id === "Empty")!.omittedSpans).toBeUndefined();
		const trackResponse = await request(file, "trace-track", "&track=Scout1");
		expect(trackResponse.status).toBe(200);
		expect(((await trackResponse.json()) as SessionTraceTrackResponse).track).toEqual(
			full.tracks.find(t => t.id === "Scout1"),
		);
		expect(
			(await request(file, "trace-track", "&track=Scout1", { "If-None-Match": trackResponse.headers.get("etag")! }))
				.status,
		).toBe(304);
		expect((await request(file, "trace-track", "&track=missing")).status).toBe(404);
		expect((await request(file, "trace-track")).status).toBe(400);
	}, 30_000);

	it("leaves smaller traces inline", async () => {
		const file = await fixture("small", { Scout1: 3 });
		const full = await buildSessionTrace(file);
		expect(((await (await request(file)).json()) as SessionTrace).tracks).toEqual(full.tracks);
	});

	it("shares concurrent cold builds and reads each transcript once", async () => {
		const file = await fixture("single-flight", { Scout1: 3 });
		const spy = spyOn(Bun, "file");
		try {
			const [a, b] = await Promise.all([buildSessionTrace(file), buildSessionTrace(file)]);
			expect(a).toBe(b);
			for (const transcriptPath of [file, path.join(file.slice(0, -6), "Scout1.jsonl")]) {
				expect(spy.mock.calls.filter(call => call[0] === transcriptPath)).toHaveLength(1);
			}
		} finally {
			spy.mockRestore();
		}
	});

	it("evicts least recently used traces", async () => {
		const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map(name => fixture(name)));
		await buildSessionTrace(a);
		await buildSessionTrace(b);
		await buildSessionTrace(c);
		await buildSessionTrace(a);
		expect(traceMemoKeysForTests()).toEqual([b, c, a]);
		await buildSessionTrace(d);
		expect(traceMemoKeysForTests()).toEqual([c, a, d]);
	});
});

describe("API compression", () => {
	it("compresses large JSON only when gzip is accepted", async () => {
		const body = JSON.stringify({ text: "x".repeat(20_000) });
		const req = (encoding: string) =>
			new Request("http://localhost/api/test", { headers: { "accept-encoding": encoding } });
		const response = await compressApiResponse(
			req("gzip, br"),
			new Response(body, { headers: { "content-type": "application/json" } }),
		);
		expect(response.headers.get("content-encoding")).toBe("gzip");
		expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())))).toBe(body);
		for (const [encoding, text] of [
			["gzip", "x".repeat(1000)],
			["identity", body],
		]) {
			const plain = await compressApiResponse(
				req(encoding),
				new Response(text, { headers: { "content-type": "application/json" } }),
			);
			expect(plain.headers.get("content-encoding")).toBeNull();
		}
		expect(acceptsGzip("gzip;q=0")).toBe(false);
		expect(acceptsGzip("*;q=0.5")).toBe(true);
		expect(acceptsGzip("gzip;q=0, *;q=1")).toBe(false);
		expect(acceptsGzip("gzip ;q=1")).toBe(true);
		expect(acceptsGzip("gzip;q=2")).toBe(false);
		expect(acceptsGzip("gzip;q=abc")).toBe(false);
	});

	it("says Vary: Accept-Encoding on every negotiable response, merged into the handler's own Vary", async () => {
		const large = JSON.stringify({ text: "x".repeat(20_000) });
		const req = (encoding: string | null) =>
			new Request("http://localhost/api/test", {
				headers: encoding === null ? {} : { "accept-encoding": encoding },
			});
		const json = (text: string, vary?: string) =>
			new Response(text, {
				headers: { "content-type": "application/json", ...(vary ? { Vary: vary } : {}) },
			});
		// Compressed, identity by choice, identity because small, and no Accept-Encoding at all: all say Vary.
		for (const [encoding, text] of [
			["gzip", large],
			["identity", large],
			["gzip", "{}"],
			[null, large],
		] as const) {
			const response = await compressApiResponse(req(encoding), json(text));
			expect(response.headers.get("vary")).toBe("Accept-Encoding");
		}
		// An existing Vary keeps its tokens; Accept-Encoding is added once, never duplicated.
		const merged = await compressApiResponse(req("gzip"), json(large, "Origin, X-Omp-Machine"));
		expect(merged.headers.get("content-encoding")).toBe("gzip");
		expect(merged.headers.get("vary")).toBe("Origin, X-Omp-Machine, Accept-Encoding");
		const already = await compressApiResponse(req("gzip"), json(large, "accept-encoding, Origin"));
		expect(already.headers.get("vary")).toBe("accept-encoding, Origin");
		// A 304 revalidation of a negotiable response varies too; non-JSON and errors are left alone.
		const notModified = await compressApiResponse(
			req("gzip"),
			new Response(null, { status: 304, headers: { ETag: '"a"' } }),
		);
		expect(notModified.headers.get("vary")).toBe("Accept-Encoding");
		expect(notModified.headers.get("etag")).toBe('"a"');
		const error = await compressApiResponse(
			req("gzip"),
			Response.json({ error: "x".repeat(20_000) }, { status: 500 }),
		);
		expect(error.headers.get("vary")).toBeNull();
	});

	it("sends a known content length on the wire", async () => {
		const file = await fixture("wire", { Scout1: 500 });
		const server = await startServer(0, "127.0.0.1");
		try {
			const response = await fetch(
				`http://127.0.0.1:${server.port}/api/session/trace?file=${encodeURIComponent(file)}`,
				{ headers: { "accept-encoding": "gzip" }, decompress: false },
			);
			const bytes = await response.arrayBuffer();
			expect(response.headers.get("content-encoding")).toBe("gzip");
			expect(Number(response.headers.get("content-length"))).toBe(bytes.byteLength);
		} finally {
			server.stop();
		}
	}, 30_000);
});
