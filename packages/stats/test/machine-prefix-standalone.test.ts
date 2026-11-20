import { afterEach, expect, test } from "bun:test";
import { parseMachines, resetFleetForTests, setFleet, shortMachineName } from "../src/client/app/machine";

afterEach(resetFleetForTests);

test("machine names lose a prefix only when all fleet names share it", () => {
	setFleet(parseMachines([{ id: "one", name: "Ada MacBook", self: true }]));
	expect(shortMachineName("Ada MacBook")).toBe("Ada MacBook");
	setFleet(
		parseMachines([
			{ id: "one", name: "Ada MacBook", self: true },
			{ id: "two", name: "Ada" },
		]),
	);
	expect(shortMachineName("Ada MacBook")).toBe("Ada MacBook");
	setFleet(
		parseMachines([
			{ id: "one", name: "Ada MacBook", self: true },
			{ id: "two", name: "Grace Server" },
		]),
	);
	expect(shortMachineName("Ada MacBook")).toBe("Ada MacBook");
});
