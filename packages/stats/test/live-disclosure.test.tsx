import { afterEach, expect, test, vi } from "bun:test";
import { LiveRoute } from "../src/client/routes/LiveRoute";
import { mount, unmount } from "./helpers/memory-dom";

afterEach(unmount);

test("the explanation of live traffic is inside a disclosure", async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		(async () => new Response("error", { status: 500 })) as typeof fetch,
	);
	const h = mount();
	await h.render(<LiveRoute active={false} />);
	const note = h.container.querySelector("details .live-note");
	expect(note?.textContent).toContain("Dots are spawned at each line's average rate");
	expect(note?.textContent).toContain("silent for 15 minutes");
});
