import { afterEach, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { CollabFrame } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { COLLAB_PROTO, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { makeHostContext, makeSnapshot, waitFor } from "./helpers/throttled-host";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		uninstallInMemoryRelay();
	}
});

async function setup(tailBytes?: number, snapshot = makeSnapshot()) {
	installInMemoryRelay();
	const ctx = makeHostContext(snapshot, { notices: [], participantCounts: [] });
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test done"));
	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => socket.close());
	const frames: CollabFrame[] = [];
	socket.onFrame = frame => frames.push(frame);
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "viewer", tailBytes });
	socket.connect();
	await waitFor(() => frames.some(frame => frame.t === "snapshot-chunk" && frame.final), "join did not complete");
	return { snapshot, ctx, socket, frames };
}

it("keeps legacy full snapshots and serves bounded tails to read-only guests", async () => {
	const { snapshot, frames } = await setup();
	const welcome = frames.find(frame => frame.t === "welcome");
	if (!welcome || welcome.t !== "welcome") throw new Error("missing welcome");
	expect(welcome.entryCount).toBe(snapshot.entries.length);
	expect(welcome.olderCount).toBeUndefined();
	expect(welcome.readOnly).toBe(true);
});

it("chains bounded older pages in wire order for a read-only guest", async () => {
	const { snapshot, frames, socket } = await setup(1);
	const welcome = frames.find(frame => frame.t === "welcome");
	if (!welcome || welcome.t !== "welcome" || welcome.olderCount === undefined) throw new Error("missing tail welcome");
	const tail = frames.flatMap(frame => (frame.t === "snapshot-chunk" ? frame.entries : []));
	expect(welcome.olderCount).toBeGreaterThan(0);
	expect(tail.map(entry => entry.id)).toEqual(snapshot.entries.slice(welcome.olderCount).map(entry => entry.id));
	expect(welcome.entryCount).toBe(tail.length);
	expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThan(65_536);
	let cursor = tail[0]?.id;
	let expectedEnd = welcome.olderCount;
	let reqId = 0;
	while (expectedEnd > 0) {
		if (!cursor) throw new Error("missing cursor");
		socket.send({ t: "fetch-older", reqId, beforeId: cursor, maxBytes: 1 });
		await waitFor(
			() => frames.some(frame => frame.t === "older-entries" && frame.reqId === reqId && frame.final),
			"page did not complete",
		);
		const chunks = frames.filter(
			(frame): frame is Extract<CollabFrame, { t: "older-entries" }> =>
				frame.t === "older-entries" && frame.reqId === reqId,
		);
		const page = chunks.flatMap(chunk => chunk.entries);
		const start = chunks[0]?.start;
		if (start === undefined || !page.length) throw new Error("empty page");
		expect(page.map(entry => entry.id)).toEqual(snapshot.entries.slice(start, expectedEnd).map(entry => entry.id));
		expect(chunks.every(chunk => !chunk.error)).toBe(true);
		expectedEnd = start;
		cursor = page[0]?.id;
		reqId++;
	}
});

it("returns terminal errors for invalid requests, unknown cursors and transitions", async () => {
	const { ctx, frames, socket } = await setup(65_536);
	const send = async (reqId: number, beforeId: string, maxBytes: number) => {
		socket.send({ t: "fetch-older", reqId, beforeId, maxBytes });
		await waitFor(
			() => frames.some(frame => frame.t === "older-entries" && frame.reqId === reqId && frame.final),
			"missing error",
		);
		const reply = frames.find(frame => frame.t === "older-entries" && frame.reqId === reqId);
		if (!reply || reply.t !== "older-entries") throw new Error("missing reply");
		expect(reply.entries).toEqual([]);
		expect(reply.error).toBeTruthy();
	};
	await send(1, "", 65_536);
	await send(2, "missing", 65_536);
	await send(3, "e0", Number.NaN);
	Object.defineProperty(ctx.session, "isSessionTransitioning", { value: true, configurable: true });
	await send(4, "e0", 65_536);
});

it("splits a large page into bounded frames and returns an empty first page", async () => {
	const { frames, socket } = await setup(65_536);
	socket.send({ t: "fetch-older", reqId: 10, beforeId: "e90", maxBytes: 10_000_000 });
	await waitFor(
		() => frames.some(frame => frame.t === "older-entries" && frame.reqId === 10 && frame.final),
		"page did not complete",
	);
	const chunks = frames.filter(
		(frame): frame is Extract<CollabFrame, { t: "older-entries" }> =>
			frame.t === "older-entries" && frame.reqId === 10,
	);
	expect(chunks.length).toBeGreaterThan(1);
	expect(chunks.every(chunk => Buffer.byteLength(JSON.stringify(chunk)) <= 512 * 1024)).toBe(true);
	const entries = chunks.flatMap(chunk => chunk.entries);
	expect(entries.length).toBeLessThan(90);
	expect(chunks[0]?.start).toBe(90 - entries.length);
	expect(chunks.at(-1)?.final).toBe(true);
	socket.send({ t: "fetch-older", reqId: 11, beforeId: "e0", maxBytes: 65_536 });
	await waitFor(() => frames.some(frame => frame.t === "older-entries" && frame.reqId === 11), "empty page missing");
	expect(frames.find(frame => frame.t === "older-entries" && frame.reqId === 11)).toEqual({
		t: "older-entries",
		reqId: 11,
		start: 0,
		entries: [],
		final: true,
	});
});

it("always includes one oversized entry and excludes non-wire entries", async () => {
	const snapshot = makeSnapshot();
	const large = snapshot.entries[0];
	if (!large || large.type !== "message" || large.message.role !== "user") throw new Error("missing user entry");
	large.message.content = "x".repeat(100_000);
	snapshot.entries = [large, { type: "non-wire", id: "hidden" } as never, { ...large, id: "last" }];
	const { frames, socket } = await setup(1, snapshot);
	const welcome = frames.find(frame => frame.t === "welcome");
	if (!welcome || welcome.t !== "welcome") throw new Error("missing welcome");
	expect(welcome.olderCount).toBe(1);
	expect(welcome.entryCount).toBe(1);
	socket.send({ t: "fetch-older", reqId: 12, beforeId: "last", maxBytes: 1 });
	await waitFor(
		() => frames.some(frame => frame.t === "older-entries" && frame.reqId === 12 && frame.final),
		"page missing",
	);
	const page = frames.find(frame => frame.t === "older-entries" && frame.reqId === 12);
	if (!page || page.t !== "older-entries") throw new Error("missing page");
	expect(page.start).toBe(0);
	expect(page.entries.map(entry => entry.id)).toEqual([large.id]);
});
