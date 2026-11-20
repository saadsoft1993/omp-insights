import { afterEach, expect, test } from "bun:test";
import { parseMachines, resetFleetForTests, selectMachine, setFleet } from "../src/client/app/machine";
import { QueryView } from "../src/client/ui/States";
import { mount, text, unmount } from "./helpers/memory-dom";

afterEach(unmount);

const PROOF = "the stats port answered without the dashboard's proof; nothing was passed on";

/** One row per failure group: a real reason, and the sentence with and without a machine name. */
const ROWS = [
	[
		"version",
		PROOF,
		"Ada Server's stats server is a different version; numbers may be missing until it's updated.",
		"The stats server is a different version; numbers may be missing until it's updated.",
	],
	[
		"unexpected",
		"the stats dashboard answered something other than data",
		"Ada Server's stats sent an unexpected answer; numbers may be missing.",
		"The stats sent an unexpected answer; numbers may be missing.",
	],
	[
		"clock",
		"request predates this process",
		"Ada Server's stats: clocks are out of sync or the hub restarted; try again.",
		"The stats: clocks are out of sync or the hub restarted; try again.",
	],
	[
		"timeout",
		"no answer in time",
		"Ada Server's stats didn't answer in time; numbers may be missing.",
		"The stats didn't answer in time; numbers may be missing.",
	],
	[
		"down",
		"the stats dashboard is not answering; see launchd/logs/omp_stats.error.log",
		"Ada Server's stats server isn't answering; numbers may be missing.",
		"The stats server isn't answering; numbers may be missing.",
	],
	[
		"loading",
		"stats status is still loading",
		"Ada Server's stats are still loading; numbers may be missing.",
		"The stats are still loading; numbers may be missing.",
	],
	["busy", "busy", "Ada Server's stats are busy; try again.", "The stats are busy; try again."],
	[
		"setup",
		"machine key missing",
		"The hub isn't set up to read Ada Server's stats yet; numbers may be missing.",
		"The hub isn't set up to read these stats yet; numbers may be missing.",
	],
	[
		"unknown",
		"HTTP error 500 on /api/stats/overview",
		"Ada Server's stats didn't answer; numbers may be missing.",
		"The stats didn't answer; numbers may be missing.",
	],
] as const;

function query(reason: string, data: string | null = null) {
	return { data, error: new Error(reason), loading: false, refetch: () => {} };
}

for (const [group, reason, withMachine, without] of ROWS)
	test(`QueryView words a ${group} failure plainly and keeps the raw reason in the tooltip`, async () => {
		const view = mount();
		await view.render(
			<QueryView query={query(reason)} machine="Ada Server" skeleton={<p>loading</p>}>
				{data => <p>{data}</p>}
			</QueryView>,
		);
		const message = view.container.querySelector(".error-state-message")!;
		expect(text(message)).toBe(withMachine);
		expect(message.getAttribute("title")).toBe(`Details: ${reason}`);
		// The raw text never shows ("busy" is also a plain word, so only longer reasons are checked).
		if (reason.length > 8) expect(text(view.container)).not.toContain(reason);
		await view.render(
			<QueryView query={query(reason)} skeleton={<p>loading</p>}>
				{data => <p>{data}</p>}
			</QueryView>,
		);
		expect(text(view.container.querySelector(".error-state-message")!)).toBe(without);
	});

test("an error over data already shown keeps the data and the plain wording", async () => {
	const view = mount();
	await view.render(
		<QueryView query={query(PROOF, "old numbers")} machine="Ada Server" skeleton={<p>loading</p>}>
			{data => <p>{data}</p>}
		</QueryView>,
	);
	expect(text(view.container)).toContain("old numbers");
	expect(text(view.container)).toContain("Ada Server's stats server is a different version");
	expect(text(view.container)).not.toContain("proof");
	expect(view.container.querySelector("button")).not.toBeNull();
});

test("a caller's page-specific message wins, with the raw reason still in the tooltip", async () => {
	const view = mount();
	await view.render(
		<QueryView
			query={query("session not found")}
			skeleton={<p>loading</p>}
			errorMessage={reason => (reason === "session not found" ? "This session's file is gone." : "other")}
		>
			{data => <p>{data}</p>}
		</QueryView>,
	);
	const message = view.container.querySelector(".error-state-message")!;
	expect(text(message)).toBe("This session's file is gone.");
	expect(message.getAttribute("title")).toBe("Details: session not found");
	await view.render(
		<QueryView query={query(PROOF)} skeleton={<p>loading</p>} errorMessage="Could not load the chart.">
			{data => <p>{data}</p>}
		</QueryView>,
	);
	expect(text(view.container.querySelector(".error-state-message")!)).toBe("Could not load the chart.");
});

test("one failed query shows one line however many areas use it", async () => {
	const view = mount();
	const failed = query(PROOF);
	await view.render(
		<>
			<QueryView query={failed} skeleton={<p>loading</p>}>
				{data => <p>{data}</p>}
			</QueryView>
			<QueryView hideError query={failed} skeleton={<p>loading</p>}>
				{data => <p>{data}</p>}
			</QueryView>
			<QueryView hideError query={failed} skeleton={<p>loading</p>}>
				{data => <p>{data}</p>}
			</QueryView>
		</>,
	);
	expect(view.container.querySelectorAll(".error-state")).toHaveLength(1);
	expect(text(view.container)).not.toContain("loading");
	// With data on screen, a hidden error leaves just the data.
	await view.render(
		<QueryView hideError query={query(PROOF, "old numbers")} skeleton={<p>loading</p>}>
			{data => <p>{data}</p>}
		</QueryView>,
	);
	expect(text(view.container)).toBe("old numbers");
});

test("with one machine picked, the sentence names it", async () => {
	setFleet(
		parseMachines([
			{ id: "server", name: "Ada Server", self: true, ok: true },
			{ id: "macbook", name: "Ada MacBook", ok: true },
		]),
	);
	selectMachine("server");
	try {
		const view = mount();
		await view.render(
			<QueryView query={query(PROOF)} skeleton={<p>loading</p>}>
				{data => <p>{data}</p>}
			</QueryView>,
		);
		expect(text(view.container.querySelector(".error-state-message")!)).toBe(
			"Ada Server's stats server is a different version; numbers may be missing until it's updated.",
		);
	} finally {
		resetFleetForTests();
	}
});

test("a manual query that is busy never says retrying and offers Try again", async () => {
	const view = mount();
	let asked = 0;
	await view.render(
		<QueryView
			query={{ data: null, error: new Error("busy"), loading: false, refetch: () => asked++, polling: false }}
			machine="Ada Server"
			skeleton={<p>loading</p>}
		>
			{data => <p>{data}</p>}
		</QueryView>,
	);
	expect(text(view.container.querySelector(".error-state-message")!)).toBe("Ada Server's stats are busy; try again.");
	expect(text(view.container)).not.toContain("retrying");
	const button = view.container.querySelector(".error-state button")!;
	expect(text(button)).toBe("Try again");
	(button as unknown as HTMLButtonElement).click();
	expect(asked).toBe(1);
});

test("a polling query that is busy says retrying", async () => {
	const view = mount();
	await view.render(
		<QueryView
			query={{ data: null, error: new Error("busy"), loading: false, refetch: () => {}, polling: true }}
			machine="Ada Server"
			skeleton={<p>loading</p>}
		>
			{data => <p>{data}</p>}
		</QueryView>,
	);
	expect(text(view.container.querySelector(".error-state-message")!)).toBe("Ada Server's stats are busy; retrying.");
	await view.render(
		<QueryView
			query={{ data: null, error: new Error("request too old"), loading: false, refetch: () => {}, polling: true }}
			skeleton={<p>loading</p>}
		>
			{data => <p>{data}</p>}
		</QueryView>,
	);
	expect(text(view.container.querySelector(".error-state-message")!)).toBe(
		"The stats: clocks are out of sync or the hub restarted; retrying.",
	);
});
