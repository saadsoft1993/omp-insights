import { afterEach, expect, test } from "bun:test";
import { Table } from "../src/client/ui/Table";
import { click, mount, text, type, unmount } from "./helpers/memory-dom";

afterEach(unmount);

test("the default table retains its Models markup", async () => {
	const view = mount();
	await view.render(
		<Table
			columns={[{ key: "name", header: "Name", render: row => row.name }]}
			rows={[{ name: "Opus" }]}
			rowKey={row => row.name}
		/>,
	);
	expect(view.container.innerHTML).toMatchSnapshot();
});

test("standard table sorts descending first and leaves empty values last", async () => {
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: row => row.name ?? "empty", sort: row => row.name }]}
			rows={[{ name: "a" }, { name: null }, { name: "z" }]}
			rowKey={row => row.name ?? "empty"}
		/>,
	);
	await click(view.container.querySelector("th button"));
	expect([...view.container.querySelectorAll("tbody tr")].map(row => text(row))).toEqual(["z", "a", "empty"]);
	expect(view.container.querySelector("th")?.getAttribute("aria-sort")).toBe("descending");
});

test("mobile sort Default restores the original row order", async () => {
	const view = mount();
	await view.render(
		<Table
			variant="std"
			initialSort={{ key: "name", dir: "desc" }}
			columns={[{ key: "name", header: "Name", render: row => row.name, sort: row => row.name }]}
			rows={[{ name: "a" }, { name: "z" }]}
			rowKey={row => row.name}
		/>,
	);
	expect([...view.container.querySelectorAll("tbody tr")].map(row => text(row))).toEqual(["z", "a"]);
	await type(view.container.querySelector(".std-mobile-sort select"), "");
	expect([...view.container.querySelectorAll("tbody tr")].map(row => text(row))).toEqual(["a", "z"]);
});

test("standard paging and pinned rows preserve a stable order", async () => {
	const view = mount();
	const rows = Array.from({ length: 4 }, (_, i) => ({ name: `row ${i}` }));
	await view.render(
		<Table
			variant="std"
			limit={2}
			columns={[{ key: "name", header: "Name", render: row => row.name }]}
			rows={rows}
			rowKey={row => row.name}
			pinned={row => row.name === "row 3"}
		/>,
	);
	expect([...view.container.querySelectorAll("tbody tr")].map(row => text(row))).toEqual(["row 3", "row 0"]);
	await click(view.container.querySelector(".std-paging button"));
	expect(view.container.querySelectorAll("tbody tr")).toHaveLength(4);
	expect(text(view.container.querySelector(".std-paging")!)).toContain("Show fewer");
});

test("standard loading and error states are accessible", async () => {
	const view = mount();
	const columns = [{ key: "name", header: "Name", render: (row: { name: string }) => row.name }];
	await view.render(<Table variant="std" loading columns={columns} rows={[]} rowKey={row => row.name} />);
	expect(view.container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading");
	await view.render(
		<Table
			variant="std"
			error="Could not load rows"
			onRetry={() => {}}
			columns={columns}
			rows={[]}
			rowKey={row => row.name}
		/>,
	);
	expect(text(view.container.querySelector('[role="alert"]')!)).toContain("Try again");
});

test("row keyboard and embedded actions do not conflict", async () => {
	const { vi } = await import("bun:test");
	const { keydown } = await import("./helpers/memory-dom");
	const onRow = vi.fn();
	const action = vi.fn();
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: () => <button onClick={action}>Action</button> }]}
			rows={[{ name: "a" }]}
			rowKey={row => row.name}
			onRowClick={onRow}
			expanded={() => null}
		/>,
	);
	await click(view.container.querySelector("td button[aria-expanded]"));
	expect(onRow).toHaveBeenCalledTimes(1);
	await click([...view.container.querySelectorAll("td button")].find(button => button.textContent === "Action"));
	expect(action).toHaveBeenCalledTimes(1);
	expect(onRow).toHaveBeenCalledTimes(1);
	await keydown(view.container.querySelector("tbody tr")!, "Enter");
	expect(onRow).toHaveBeenCalledTimes(2);
});

test("compact duration handles minutes, hours, and days", async () => {
	const { formatCompactDuration } = await import("../src/client/ui/Table");
	expect(formatCompactDuration(10)).toBe("<1m");
	expect(formatCompactDuration(14 * 60_000)).toBe("14m");
	expect(formatCompactDuration((2 * 60 + 36) * 60_000)).toBe("2h 36m");
	expect(formatCompactDuration(37 * 3600_000)).toBe("1d 13h");
});

test("duplicate groups keep independent radio choices when sorted", async () => {
	const view = mount();
	const rows = [
		{ group: "a", name: "z" },
		{ group: "b", name: "y" },
		{ group: "a", name: "x" },
	];
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: row => row.name, sort: row => row.name }]}
			rows={rows}
			rowKey={row => row.name}
			group={row => ({ key: row.group, label: row.group })}
			radioKey={row => row.name === "z" || row.name === "y"}
			onRadioChange={() => {}}
		/>,
	);
	await click(view.container.querySelector("thead button"));
	const groups = [...view.container.querySelectorAll(".std-group")].map(row => text(row));
	expect(groups).toEqual(["a", "b"]);
	const radios = [...view.container.querySelectorAll('input[type="radio"]')];
	expect(radios[0]?.getAttribute("name")).toBe(radios[1]?.getAttribute("name"));
	expect(radios[0]?.getAttribute("name")).not.toBe(radios[2]?.getAttribute("name"));
	expect(radios.filter(radio => (radio as HTMLInputElement).checked)).toHaveLength(2);
});

test("a row can open a drawer while its chevron toggles detail", async () => {
	const { vi } = await import("bun:test");
	const openDrawer = vi.fn();
	const toggle = vi.fn();
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: row => row.name }]}
			rows={[{ name: "session" }]}
			rowKey={row => row.name}
			onRowClick={openDrawer}
			onToggle={toggle}
			expanded={() => null}
		/>,
	);
	await click(view.container.querySelector("button[aria-expanded]"));
	expect(toggle).toHaveBeenCalledTimes(1);
	expect(openDrawer).not.toHaveBeenCalled();
	await click(view.container.querySelector("tbody tr"));
	expect(openDrawer).toHaveBeenCalledTimes(1);
	expect(toggle).toHaveBeenCalledTimes(1);
});

test("a chevron is available when only onToggle is supplied", async () => {
	const { vi } = await import("bun:test");
	const toggle = vi.fn();
	const view = mount();
	await view.render(
		<Table
			variant="std"
			columns={[{ key: "name", header: "Name", render: row => row.name }]}
			rows={[{ name: "session" }]}
			rowKey={row => row.name}
			onToggle={toggle}
			expanded={() => null}
		/>,
	);
	await click(view.container.querySelector("button[aria-expanded]"));
	expect(toggle).toHaveBeenCalledTimes(1);
});

test("standard summary sits between the card head and table and retains controls", async () => {
	const { vi } = await import("bun:test");
	const onFilter = vi.fn();
	const view = mount();
	await view.render(
		<Table
			variant="std"
			title="Model flow"
			summary={
				<>
					<span>3 differences</span>
					<button onClick={onFilter}>Only rows that differ</button>
				</>
			}
			columns={[{ key: "name", header: "Role", render: row => row.name }]}
			rows={[{ name: "plan" }]}
			rowKey={row => row.name}
		/>,
	);
	const section = view.container.querySelector(".table--std")!;
	expect([...section.children].map(child => child.className || child.tagName)).toEqual([
		"std-head",
		"std-summary",
		"TABLE",
	]);
	await click(section.querySelector(".std-summary button"));
	expect(onFilter).toHaveBeenCalledTimes(1);
});

test("standard error retry shows Checking… and waits while busy", async () => {
	const view = mount();
	const columns = [{ key: "name", header: "Name", render: (row: { name: string }) => row.name }];
	let retried = 0;
	await view.render(
		<Table
			variant="std"
			error="Failed"
			onRetry={() => retried++}
			retryBusy
			columns={columns}
			rows={[]}
			rowKey={row => row.name}
		/>,
	);
	const button = view.container.querySelector(".std-state button")!;
	expect(text(button)).toBe("Checking…");
	expect(button.hasAttribute("disabled")).toBe(true);
	await view.render(
		<Table
			variant="std"
			error="Failed"
			onRetry={() => retried++}
			columns={columns}
			rows={[]}
			rowKey={row => row.name}
		/>,
	);
	const idle = view.container.querySelector(".std-state button")!;
	expect(text(idle)).toBe("Try again");
	await click(idle);
	expect(retried).toBe(1);
});
