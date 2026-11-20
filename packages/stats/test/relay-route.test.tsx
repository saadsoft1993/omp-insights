import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { loadQuery, releaseQuery } from "../src/client/data/query-store";
import { RelayRoute, relayBuildLabel } from "../src/client/routes/RelayRoute";
import { mount, settle, text, unmount } from "./helpers/memory-dom";

afterEach(unmount);

beforeEach(async () => {
	const key = JSON.stringify(["hub-relay"]);
	const r = loadQuery(key, -1, async () => ({ ok: true, error: null }));
	await r.promise;
	releaseQuery(key, r);
});

describe("relayBuildLabel", () => {
	it("shows the first word of a string build", () => {
		expect(relayBuildLabel("v18.18.3 extra details")).toBe("v18.18.3");
	});

	it("shows the tag and Bun version of an object build", () => {
		expect(relayBuildLabel({ ompTag: "v18.18.3", bun: "1.4.4" })).toBe("v18.18.3 · bun 1.4.4");
	});

	it("shows just the tag without Bun", () => {
		expect(relayBuildLabel({ ompTag: "v18.18.3" })).toBe("v18.18.3");
	});

	it("handles null and unexpected values", () => {
		expect(relayBuildLabel(null)).toBe("–");
		expect(relayBuildLabel(123)).toBe("–");
		expect(relayBuildLabel({ ompTag: 123, bun: 456 })).toBe("–");
		expect(relayBuildLabel({ ompTag: "v18.18.3", bun: 456 })).toBe("v18.18.3");
		const broken = Object.defineProperty({}, "ompTag", {
			get: () => {
				throw new Error("bad getter");
			},
		});
		expect(relayBuildLabel(broken)).toBe("–");
	});
});

describe("Relay page", () => {
	it("renders an object build returned by the relay", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			if (String(input) !== "/api/hub/relay") return Response.json({ error: "unexpected request" }, { status: 500 });
			return Response.json({
				ok: true,
				error: null,
				rooms: 1,
				build: { ompTag: "v18.18.3", bun: "1.4.4" },
			});
		}) as typeof fetch);
		const h = mount();
		await h.render(<RelayRoute active />);
		await settle();
		expect(text(h.container)).toContain("v18.18.3 · bun 1.4.4");
	});
});
