import { describe, expect, test } from "bun:test";
import { ApiError } from "../api";
import { historyError } from "./history-actions";

describe("resume errors", () => {
	for (const message of [
		"folder no longer exists",
		"folder is outside the project roots",
		"session already running",
		"pane directory not allowed",
		"archived; open the transcript instead",
	]) {
		test(`keeps the hub message: ${message}`, () => {
			expect(historyError(new ApiError(400, "/api/hub/resume", message))).toBe(message);
		});
	}
	test("explains old hubs", () => {
		expect(historyError(new ApiError(404, "/api/hub/resume", "Not found"))).toBe("update this machine's hub");
	});
});
