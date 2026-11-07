/**
 * Access gate for a dashboard that is only reached through a local reverse proxy (the omp hub).
 *
 * Both sides hold a 256-bit key from a private file the proxy writes; the key itself never crosses the wire.
 *
 * - Request: the proxy sends {@link STATS_PROXY_TIME_HEADER} (ms since the epoch), a fresh 128-bit
 *   {@link STATS_PROXY_NONCE_HEADER}, and {@link STATS_PROXY_AUTH_HEADER} =
 *   hex HMAC-SHA256(key, "omp-hub-req\n" + method + "\n" + path-and-query + "\n" + time + "\n" + nonce),
 *   with `Host: 127.0.0.1:<port>`. Anything else (a DNS-rebinding page, another local account) gets 403.
 *   A nonce is accepted once; times more than a minute off are refused, so a captured request can't be replayed.
 * - Response: the dashboard answers with {@link STATS_PROXY_PROOF_HEADER} =
 *   hex HMAC-SHA256(key, "omp-stats-resp\n" + nonce). The proxy relays nothing without it, so a process that
 *   took the port while the dashboard was down can't feed the proxy's browser pages or data.
 *
 * The proxy rotates the key when it restarts; a request that fails verification re-reads the file only if the
 * file changed (inode, mtime or size), so no caller can starve the re-read.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const STATS_PROXY_TIME_HEADER = "X-Omp-Hub-Time";
export const STATS_PROXY_NONCE_HEADER = "X-Omp-Hub-Nonce";
export const STATS_PROXY_AUTH_HEADER = "X-Omp-Hub-Auth";
export const STATS_PROXY_PROOF_HEADER = "X-Omp-Stats-Proof";

/** Env var naming the key file; when set, `omp-stats` serves only the proxy. */
export const STATS_PROXY_KEY_ENV = "OMP_STATS_PROXY_KEY_FILE";

/** How far a request's time may be from ours, and how long its nonce is remembered. */
const MAX_SKEW_MS = 60_000;
/** Remembered nonces at most; past that the oldest are dropped (they are older than the skew window by then). */
const MAX_NONCES = 50_000;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const MAC_PATTERN = /^[0-9a-f]{64}$/;

export interface ProxyKey {
	key: Buffer;
	/** Identity of the file the key came from: a change means the proxy wrote a new one. */
	stamp: string;
}

export interface ProxyGate {
	/**
	 * The proof header value for the response when `req`, received on `port`, came from the proxy;
	 * null when it did not (answer 403 without a proof).
	 */
	check(req: Request, port: number): string | null;
}

function fileStamp(st: fs.Stats): string {
	return `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`;
}

/** The key file's identity without reading it, or null when it is gone. */
function currentStamp(file: string): string | null {
	try {
		return fileStamp(fs.lstatSync(file));
	} catch {
		return null;
	}
}

/**
 * The key in `file`, or null when it is missing, malformed, or not private to this account: its directory
 * must be ours with no group/other bits, and the file is opened without following a symlink and checked on the
 * open descriptor (regular file, ours, no group/other bits), so nothing can be swapped in between.
 */
export function readProxyKey(file: string): ProxyKey | null {
	const uid = process.getuid?.();
	const privateToUs = (st: fs.Stats) => (st.mode & 0o077) === 0 && (uid === undefined || st.uid === uid);
	let fd: number | undefined;
	try {
		const dir = fs.lstatSync(path.dirname(file));
		if (!dir.isDirectory() || !privateToUs(dir)) return null;
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const st = fs.fstatSync(fd);
		if (!st.isFile() || !privateToUs(st)) return null;
		const text = fs.readFileSync(fd, "utf8").trim().toLowerCase();
		return KEY_PATTERN.test(text) ? { key: Buffer.from(text, "hex"), stamp: fileStamp(st) } : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** hex HMAC-SHA256 the proxy sends for a request (exported for tests and tools). */
export function proxyRequestMac(key: Buffer, method: string, target: string, time: string, nonce: string): string {
	return createHmac("sha256", key).update(`omp-hub-req\n${method}\n${target}\n${time}\n${nonce}`).digest("hex");
}

/** hex HMAC-SHA256 the dashboard answers with. */
export function proxyResponseProof(key: Buffer, nonce: string): string {
	return createHmac("sha256", key).update(`omp-stats-resp\n${nonce}`).digest("hex");
}

export function createProxyGate(keyFile: string, now: () => number = Date.now): ProxyGate {
	let current = readProxyKey(keyFile);
	/** nonce -> time it may be forgotten; Map keeps insertion order, oldest first. */
	const seen = new Map<string, number>();

	const verifies = (key: ProxyKey | null, method: string, target: string, time: string, nonce: string, mac: Buffer) =>
		key !== null && timingSafeEqual(Buffer.from(proxyRequestMac(key.key, method, target, time, nonce), "hex"), mac);

	const remember = (nonce: string, at: number) => {
		for (const [old, expires] of seen) {
			if (expires > at && seen.size < MAX_NONCES) break;
			seen.delete(old);
		}
		seen.set(nonce, at + 2 * MAX_SKEW_MS);
	};

	return {
		check(req, port) {
			if (req.headers.get("host") !== `127.0.0.1:${port}`) return null;
			const time = req.headers.get(STATS_PROXY_TIME_HEADER) ?? "";
			const nonce = (req.headers.get(STATS_PROXY_NONCE_HEADER) ?? "").toLowerCase();
			const macHex = (req.headers.get(STATS_PROXY_AUTH_HEADER) ?? "").toLowerCase();
			if (!/^\d{1,16}$/.test(time) || !NONCE_PATTERN.test(nonce) || !MAC_PATTERN.test(macHex)) return null;
			const at = now();
			if (Math.abs(at - Number(time)) > MAX_SKEW_MS || seen.has(nonce)) return null;
			const url = new URL(req.url);
			const target = url.pathname + url.search;
			const mac = Buffer.from(macHex, "hex");
			if (!verifies(current, req.method, target, time, nonce, mac)) {
				// The proxy may have restarted with a new key: re-read only when the file changed.
				const stamp = currentStamp(keyFile);
				if (stamp === null || stamp === current?.stamp) return null;
				current = readProxyKey(keyFile);
				if (!verifies(current, req.method, target, time, nonce, mac)) return null;
			}
			remember(nonce, at);
			return current ? proxyResponseProof(current.key, nonce) : null;
		},
	};
}
