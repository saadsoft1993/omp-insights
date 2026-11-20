import { useEffect, useRef, useState } from "react";
import { ALL_MACHINES, selectMachine, useFleet, useFleetListProblem, useSelectedMachine } from "./machine";
import { MachineName } from "./MachineName";

export function MachineSelect() {
	const fleet = useFleet();
	const selected = useSelectedMachine();
	const listProblem = useFleetListProblem();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		root.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus();
		const close = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [open]);
	if (!fleet || !selected) return null;
	const chosen = fleet.find(machine => machine.id === selected);
	const options = [{ id: ALL_MACHINES, name: "All machines" }, ...fleet];
	return (
		<div className="machine-dropdown" ref={root}>
			<button
				ref={trigger}
				type="button"
				className="machine-dropdown-trigger"
				aria-label="Machine"
				title={`${
					chosen
						? `${chosen.name}: ${!chosen.ok ? "unreachable" : chosen.stale ? "last known, reconnecting" : "reachable"}`
						: `${fleet.filter(machine => !machine.ok).length} unreachable`
				}${listProblem ? `. Showing the last known machines: ${listProblem}` : ""}`}
				data-list-problem={listProblem ? "true" : undefined}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				onKeyDown={event => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						setOpen(true);
					}
				}}
			>
				<span className="machine-dropdown-dots" aria-hidden="true">
					{(chosen ? [chosen] : fleet).map(machine => (
						<span key={machine.id} data-ok={machine.ok && !machine.stale} />
					))}
				</span>
				{chosen ? <MachineName name={chosen.name} /> : "All machines"} <span aria-hidden="true">▾</span>
			</button>
			{open && (
				<div
					className="machine-dropdown-menu"
					role="listbox"
					aria-label="Choose machine"
					onKeyDown={event => {
						if (event.key === "Escape") {
							event.preventDefault();
							setOpen(false);
							trigger.current?.focus();
							return;
						}
						if (
							event.key !== "ArrowDown" &&
							event.key !== "ArrowUp" &&
							event.key !== "Home" &&
							event.key !== "End"
						)
							return;
						event.preventDefault();
						const buttons = Array.from(
							root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
						);
						const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
						const next =
							event.key === "Home"
								? 0
								: event.key === "End"
									? buttons.length - 1
									: (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
						buttons[next]?.focus();
					}}
				>
					{options.map(option => {
						const machine = fleet.find(item => item.id === option.id);
						return (
							<button
								key={option.id}
								type="button"
								role="option"
								aria-selected={selected === option.id}
								onClick={() => {
									selectMachine(option.id);
									setOpen(false);
									trigger.current?.focus();
								}}
							>
								<span className="machine-dropdown-dots" aria-hidden="true">
									{(machine ? [machine] : fleet).map(item => (
										<span key={item.id} data-ok={item.ok && !item.stale} />
									))}
								</span>
								<span className="machine-dropdown-text">
									<strong>{option.name}</strong>
									{machine && (
										<small>
											{!machine.ok
												? "Unreachable"
												: machine.stale
													? `Last known${machine.staleSince ? ` as of ${new Date(machine.staleSince).toLocaleTimeString()}` : ""} · reconnecting`
													: "Reachable"}
											{machine.latencyMs != null ? ` · ${machine.latencyMs} ms` : ""}
											{machine.version ? ` · ${machine.version}` : ""}
											{machine.lastOkAt ? ` · last seen ${new Date(machine.lastOkAt).toLocaleString()}` : ""}
										</small>
									)}
								</span>
								<span className="machine-dropdown-check" aria-hidden="true">
									{selected === option.id ? "✓" : ""}
								</span>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
