import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Table } from "../../src/client/ui/Table";
import "../../src/client/styles.css";

function GeometryFixture() {
	const [open, setOpen] = useState(false);
	const [grouped, setGrouped] = useState(false);
	const [actionCount, setActionCount] = useState(0);
	const rows = [{ name: "Primary session", status: "Running", model: "Model", cost: "$1", started: "Today" }];
	return (
		<main style={{ padding: 24 }}>
			<button type="button" id="toggle-group" onClick={() => setGrouped(value => !value)}>
				Toggle group
			</button>
			<Table
				variant="std"
				title="Sessions with a longer descriptive title"
				subtitle="Session details across the fleet"
				tools={
					<>
						<input aria-label="Search sessions" placeholder="Search sessions" />
						<button type="button">Re-scan</button>
					</>
				}
				columns={[
					{ key: "name", header: "Session", render: row => row.name, sort: row => row.name },
					{ key: "status", header: "Status", width: 100, render: row => row.status },
					{ key: "model", header: "Model", width: 100, priority: 2, render: row => row.model },
					{ key: "cost", header: "Cost", width: 100, priority: 3, render: row => row.cost },
					{ key: "started", header: "Started", width: 100, priority: 3, render: row => row.started },
				]}
				rows={rows}
				rowKey={row => row.name}
				group={
					grouped
						? () => ({
								key: "group",
								label: "A long duplicate group reason describing related memories across multiple projects, with enough detail to wrap across several lines without hiding the action",
								action: (
									<button id="group-action" onClick={() => setActionCount(n => n + 1)}>
										Merge group {actionCount}
									</button>
								),
							})
						: undefined
				}
				onRowClick={() => setOpen(value => !value)}
				expanded={() =>
					open ? (
						<Table
							variant="std"
							columns={["a", "b", "c", "d", "e", "f", "g"].map(key => ({ key, header: key, render: () => key }))}
							rows={[{ id: 1 }]}
							rowKey={row => row.id}
						/>
					) : null
				}
			/>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<GeometryFixture />);
