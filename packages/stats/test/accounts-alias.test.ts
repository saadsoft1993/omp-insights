import { expect, it } from "bun:test";
import { parseHash } from "../src/client/data/useHashRoute";

for (const alias of ["providers", "connections"]) {
	it(`maps ${alias} bookmarks to accounts while preserving range and machine`, () => {
		const route = parseHash(`#/${alias}?range=7d&m=mini`);
		expect(route.section).toBe("accounts");
		expect(route.range).toBe("7d");
		expect(route.machine).toBe("mini");
	});
}
