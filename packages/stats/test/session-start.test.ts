import { describe, expect, test } from "bun:test";
import { createAndStartProject, sessionOpenUrl, validProjectName } from "../src/client/data/session-start";

describe("starting sessions", () => {
	test("validates folder names", () => {
		for (const name of ["project", "A-1._", "a".repeat(64)]) expect(validProjectName(name)).toBe(true);
		for (const name of ["", ".hidden", "../escape", "a/b", "a".repeat(65)])
			expect(validProjectName(name)).toBe(false);
	});
	test("prefers a pairing link when opening a session", () => {
		expect(sessionOpenUrl({ url: "relay", pairUrl: "pair" })).toBe("pair");
		expect(sessionOpenUrl({ url: "relay" })).toBe("relay");
	});
});
test("creates before starting in the returned folder", async () => {
	const calls: string[] = [];
	await createAndStartProject(
		async () => {
			calls.push("create");
			return { path: "/projects/new" };
		},
		async path => {
			calls.push(`start:${path}`);
		},
	);
	expect(calls).toEqual(["create", "start:/projects/new"]);
});
test("does not start when folder creation fails", async () => {
	let started = false;
	await expect(
		createAndStartProject(
			async () => {
				throw new Error("already exists");
			},
			async () => {
				started = true;
			},
		),
	).rejects.toThrow("already exists");
	expect(started).toBe(false);
});
