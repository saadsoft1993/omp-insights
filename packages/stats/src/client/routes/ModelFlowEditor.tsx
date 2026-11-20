import { Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type FlowChoice, type FlowModel, flowLevels } from "../data/hub";
import { usePopoverFit } from "./model-flow-popover";

/** Provider swatch colours, shared with the model chips. */
export const PROVIDER_COLOR: Record<string, string> = {
	anthropic: "#ff7a59",
	"anthropic-2": "#fb7185",
	"openai-codex": "#2dd4bf",
	"amazon-bedrock": "#f5b54a",
	"bedrock-mantle": "#c3e94f",
	gateway: "#5b8cff",
};
export const OTHER_PROVIDER_COLOR = "#6c6c74";
/** Options shown per provider before the list asks for a narrower search. */
const GROUP_LIMIT = 60;

export interface ModelFlowEditorProps {
	label: string;
	heading: string;
	models: readonly FlowModel[];
	model: string;
	thinking: string | null;
	onCancel: () => void;
	onSave: (choice: FlowChoice) => void;
}

/**
 * The model picker for one Model flow cell: a searchable listbox grouped by provider, then the thinking level.
 * The search box drives the list as a combobox (arrows move, Enter picks, Escape closes).
 */
export function ModelFlowEditor({ label, heading, models, model, thinking, onCancel, onSave }: ModelFlowEditorProps) {
	const id = useId();
	const [chosen, setChosen] = useState(model);
	const [level, setLevel] = useState(thinking);
	const [search, setSearch] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverFit(rootRef);
	const levelRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const selectors = useMemo(() => new Set(models.map(item => item.selector)), [models]);
	const selected = models.find(item => item.selector === chosen);
	const levels = flowLevels(selected, selectors);
	const groups = useMemo(() => {
		const query = search.trim().toLowerCase();
		const current = chosen.split("/")[0];
		const rank = (provider: string) =>
			provider === current ? 0 : provider === "anthropic" ? 1 : provider === "openai-codex" ? 2 : 3;
		const byProvider = new Map<string, FlowModel[]>();
		for (const item of models) {
			if (query && !`${item.selector} ${item.name}`.toLowerCase().includes(query)) continue;
			const list = byProvider.get(item.provider) ?? [];
			list.push(item);
			byProvider.set(item.provider, list);
		}
		return [...byProvider.entries()]
			.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
			.map(([provider, list]) => ({
				provider,
				total: list.length,
				shown: list.sort((a, b) => a.name.localeCompare(b.name)).slice(0, GROUP_LIMIT),
			}));
		// The provider order follows the model the editor opened with, so it does not jump while picking.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [models, search]);
	const options = groups.flatMap(group => group.shown);
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			options.findIndex(item => item.selector === model),
		),
	);
	const activeIndex = Math.min(active, options.length - 1);
	const optionId = (index: number) => `${id}-option-${index}`;

	useEffect(() => {
		searchRef.current?.focus();
	}, []);
	useEffect(() => {
		if (activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
		// optionId only depends on the stable id.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeIndex]);

	const pick = (selector: string) => {
		setChosen(selector);
		setLevel(null);
	};
	const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!options.length) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((Math.max(activeIndex, 0) + step + options.length) % options.length);
		} else if (event.key === "Home" || event.key === "End") {
			if (!options.length) return;
			event.preventDefault();
			setActive(event.key === "Home" ? 0 : options.length - 1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const option = options[activeIndex];
			if (option) pick(option.selector);
		}
	};
	const unavailable = level !== null && !levels.includes(level);
	const radios: { value: string | null; label: string }[] = [
		{ value: null, label: "default" },
		...(unavailable ? [{ value: level, label: `${level} (unavailable)` }] : []),
		...levels.map(value => ({ value, label: value })),
	];
	const onLevelKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		const step =
			event.key === "ArrowRight" || event.key === "ArrowDown"
				? 1
				: event.key === "ArrowLeft" || event.key === "ArrowUp"
					? -1
					: 0;
		if (!step) return;
		event.preventDefault();
		const next = (index + step + radios.length) % radios.length;
		setLevel(radios[next].value);
		levelRefs.current[next]?.focus();
	};
	let optionIndex = -1;
	return (
		<div
			ref={rootRef}
			className="mf-editor"
			role="dialog"
			aria-label={label}
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onCancel();
				}
			}}
		>
			<span className="mf-lbl">
				{heading} · {models.length} models
			</span>
			<label className="search mf-search">
				<Search size={14} aria-hidden="true" />
				<input
					ref={searchRef}
					className="input"
					type="search"
					placeholder="Search models"
					aria-label="Search models"
					role="combobox"
					aria-expanded="true"
					aria-controls={`${id}-list`}
					aria-autocomplete="list"
					aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
					value={search}
					onChange={event => {
						setSearch(event.target.value);
						setActive(0);
					}}
					onKeyDown={onSearchKey}
				/>
			</label>
			<div className="mf-mlist" role="listbox" id={`${id}-list`} aria-label="Models">
				{options.length ? (
					groups.map(group => (
						<div role="group" aria-label={group.provider} key={group.provider}>
							<div className="mf-pgroup" aria-hidden="true">
								<span
									className="mf-sw"
									style={{ background: PROVIDER_COLOR[group.provider] ?? OTHER_PROVIDER_COLOR }}
								/>
								{group.provider} <span className="mono">{group.total}</span>
							</div>
							{group.shown.map(item => {
								optionIndex += 1;
								const index = optionIndex;
								return (
									<div
										key={item.selector}
										id={optionId(index)}
										className="mf-mopt"
										role="option"
										data-value={item.selector}
										data-active={index === activeIndex}
										aria-selected={item.selector === chosen}
										onMouseDown={event => event.preventDefault()}
										onClick={() => {
											setActive(index);
											pick(item.selector);
										}}
									>
										<span>{item.name}</span>
										<small>{item.id}</small>
									</div>
								);
							})}
							{group.total > group.shown.length && (
								<div className="hint mf-more">{group.total - group.shown.length} more; type to narrow</div>
							)}
						</div>
					))
				) : (
					<p className="hint mf-more">No model matches.</p>
				)}
			</div>
			<span className="mf-lbl" id={`${id}-levels`}>
				Thinking level
			</span>
			{selected?.thinking?.length || unavailable ? (
				<div className="mf-segmented" role="radiogroup" aria-labelledby={`${id}-levels`}>
					{radios.map((radio, index) => {
						const checked = radio.value === level;
						return (
							<button
								key={radio.label}
								ref={node => {
									levelRefs.current[index] = node;
								}}
								type="button"
								className="mf-seg"
								role="radio"
								data-value={radio.value ?? ""}
								aria-checked={checked}
								tabIndex={checked ? 0 : -1}
								title={radio.value === null ? "Use the model's default thinking level" : undefined}
								onClick={() => setLevel(radio.value)}
								onKeyDown={event => onLevelKey(event, index)}
							>
								{radio.label}
							</button>
						);
					})}
				</div>
			) : (
				<span className="hint">This model has no thinking levels.</span>
			)}
			<div className="mf-foot">
				<button type="button" className="btn" data-size="sm" data-variant="ghost" onClick={onCancel}>
					Cancel
				</button>
				<button
					type="button"
					className="btn"
					data-size="sm"
					data-variant="primary"
					disabled={!selected || unavailable}
					onClick={() => onSave({ model: chosen, thinking: level })}
				>
					Save
				</button>
			</div>
		</div>
	);
}
