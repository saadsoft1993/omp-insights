import { afterEach, describe, expect, it, vi } from "bun:test";
import { fetchRetrying } from "../src/client/data/restart-retry";

const originalFetch = globalThis.fetch;
const instantSleep = async () => {};
const options = { sleep: instantSleep };

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockResponses(...statuses: number[]) {
	const fetchMock = vi.fn(async () => new Response(null, { status: statuses.shift() ?? 200 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe("fetchRetrying", () => {
	it("retries with the default sleep when Promise.withResolvers is unavailable", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
		Reflect.deleteProperty(Promise, "withResolvers");
		try {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(
					new Response("bad gateway", { status: 502, headers: { "Content-Type": "text/plain" } }),
				)
				.mockResolvedValueOnce(new Response());
			globalThis.fetch = fetchMock as unknown as typeof fetch;
			expect((await fetchRetrying("/test", undefined, { delaysMs: [1, 1] })).status).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			if (descriptor) Object.defineProperty(Promise, "withResolvers", descriptor);
		}
	});

	it("retries a 502 without content type and returns the successful response", async () => {
		const fetchMock = mockResponses(502, 200);
		expect((await fetchRetrying("/test", undefined, options)).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a plain-text gateway error", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad gateway", { status: 502, headers: { "Content-Type": "text/plain" } }))
			.mockResolvedValueOnce(new Response());
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		expect((await fetchRetrying("/test", undefined, options)).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a JSON hub error", async () => {
		const response = Response.json({ error: "hub unavailable" }, { status: 502 });
		const fetchMock = vi.fn().mockResolvedValue(response);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		expect(await fetchRetrying("/test", undefined, options)).toBe(response);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await response.json()).toEqual({ error: "hub unavailable" });
	});

	it("retries 503 and 504", async () => {
		const fetchMock = mockResponses(503, 504, 200);
		expect((await fetchRetrying("/test", undefined, options)).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("returns the final response after retries are exhausted", async () => {
		const fetchMock = mockResponses(502, 502, 502);
		expect((await fetchRetrying("/test", undefined, options)).status).toBe(502);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry POST", async () => {
		const fetchMock = mockResponses(502, 200);
		expect((await fetchRetrying("/test", { method: "POST" }, options)).status).toBe(502);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries network TypeErrors", async () => {
		const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(new Response());
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		expect((await fetchRetrying("/test", undefined, options)).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("stops when aborted during the default sleep", async () => {
		const fetchMock = mockResponses(502, 200);
		const controller = new AbortController();
		const reason = new Error("cancelled");
		const result = fetchRetrying("/test", { signal: controller.signal });
		await Promise.resolve();
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([404, 500])("does not retry HTTP %i", async status => {
		const fetchMock = mockResponses(status, 200);
		expect((await fetchRetrying("/test", undefined, options)).status).toBe(status);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries HEAD case-insensitively", async () => {
		const fetchMock = mockResponses(502, 200);
		expect((await fetchRetrying("/test", { method: "head" }, options)).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rethrows the final network error", async () => {
		const error = new TypeError("offline");
		const fetchMock = vi.fn().mockRejectedValue(error);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await expect(fetchRetrying("/test", undefined, options)).rejects.toBe(error);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry abort errors", async () => {
		const error = new DOMException("cancelled", "AbortError");
		const fetchMock = vi.fn().mockRejectedValue(error);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await expect(fetchRetrying("/test", undefined, options)).rejects.toBe(error);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cancels discarded response bodies", async () => {
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }), { status: 502 });
		const fetchMock = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(new Response());
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await fetchRetrying("/test", undefined, options);
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});
