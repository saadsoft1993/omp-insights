import { describe, expect, it } from "bun:test";
import type { HubSession } from "../src/client/data/hub";
import {
	herdrPlace,
	killConfirmMatches,
	nameProblem,
	RESTART_FOR_CONTROLS,
	sessionControls,
	sessionDisplayName,
} from "../src/client/data/session-controls";

const base: HubSession = {
	instanceId: "abcd1234",
	sessionId: "01a1b65b-93f3-7000-8000-000000000001",
	pid: 4242,
	cwd: "/Users/me/projects/sms",
	sessionName: "Fix login bug",
	busy: true,
	control: true,
};

describe("session controls", () => {
	it("offers Stop only while a turn runs, and Rename and Kill always", () => {
		expect(sessionControls(base)).toEqual({
			showStop: true,
			stop: { enabled: true, reason: null },
			rename: { enabled: true, reason: null },
			kill: { enabled: true, reason: null },
		});
		expect(sessionControls({ ...base, busy: false }).showStop).toBe(false);
	});

	it("explains the restart when the session has no extension yet, but still allows Kill", () => {
		const c = sessionControls({ ...base, control: false });
		expect(c.stop).toEqual({ enabled: false, reason: RESTART_FOR_CONTROLS });
		expect(c.rename.enabled).toBe(false);
		expect(c.kill.enabled).toBe(true);
	});

	it("turns everything off without a session id, and Kill off without a pid", () => {
		const c = sessionControls({ ...base, sessionId: undefined });
		expect([c.stop.enabled, c.rename.enabled, c.kill.enabled]).toEqual([false, false, false]);
		expect(sessionControls({ ...base, pid: undefined }).kill.enabled).toBe(false);
	});

	it("accepts the exact name or the project folder as Kill confirmation", () => {
		expect(killConfirmMatches(base, "Fix login bug")).toBe(true);
		expect(killConfirmMatches(base, "  sms ")).toBe(true);
		for (const typed of ["", "fix login bug", "Fix", "/Users/me/projects/sms"]) {
			expect(killConfirmMatches(base, typed)).toBe(false);
		}
		expect(killConfirmMatches({ ...base, sessionName: undefined }, "")).toBe(false);
	});

	it("names sessions and says where they run in herdr", () => {
		expect(sessionDisplayName({ ...base, sessionName: undefined })).toBe("sms");
		expect(herdrPlace({ ...base, herdr: { workspace: "sms", tab: "omp", pane: "w1:p2" } })).toBe(
			"in herdr: sms › omp",
		);
		expect(herdrPlace({ ...base, herdr: { workspace: "sms", tab: null, pane: null } })).toBe("in herdr: sms");
		expect(herdrPlace({ ...base, herdr: null })).toBeNull();
	});
});

describe("rename validation", () => {
	it("matches the extension: 1-120 characters, no control or invisible characters", () => {
		expect(nameProblem("Fix  login ")).toBeNull();
		for (const bad of ["", "   ", "x".repeat(121), "a\nb", "prod\u202eved", "a\u200bb", "x\u2066y"]) {
			expect(nameProblem(bad)).not.toBeNull();
		}
	});
});
