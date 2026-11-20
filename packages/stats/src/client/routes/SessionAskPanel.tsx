import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { HubSession } from "../data/hub";
import {
	deliver,
	getMessageStatus,
	deliveryText,
	answerProblems,
	answerSessionAsk,
	askFailure,
	type AskField,
	type AskOthers,
	type AskValues,
	getSessionAsk,
	type HubAsk,
	initialValues,
	MAX_OTHER_CHARS,
	newMessageId,
	QUESTION_TOO_LARGE_TEXT,
	QUESTION_UNSUPPORTED_TEXT,
	toAnswers,
	UNKNOWN_MODE_TEXT,
	WAIT_MODE_TEXT,
} from "../data/session-ask";
import { type CapabilityState, isPluginTooOld, updateHubHint, updatePluginHint } from "../data/session-capabilities";
import { CapabilityChecking } from "./CapabilityChecking";

export interface AskPanelProps {
	session: HubSession;
	machineName: string;
	/** The hub's `askAnswer` capability on the session's machine. */
	capability: CapabilityState;
	/** From the session's `session-info`; undefined while it loads. */
	interruptMode: "immediate" | "wait" | null | undefined;
	/** Why every control is off (machine unreachable), or null. */
	locked: string | null;
	waitingText: string;
	onOpen: () => void;
	onChanged: () => void;
}

type Result = { tone: "ok" | "bad" | "warn"; text: string } | null;

/**
 * The question the session asks, as typed fields drawn with our own controls (never the question's HTML).
 * One answer per press, never retried: the session checks the question is still the same one before taking it.
 */
export function SessionAskPanel({
	session,
	machineName,
	capability,
	interruptMode,
	locked,
	waitingText,
	onOpen,
	onChanged,
}: AskPanelProps) {
	const sessionId = session.sessionId ?? "";
	const machine = session.machine;
	const [ask, setAsk] = useState<HubAsk | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [pluginOld, setPluginOld] = useState(false);
	const [loading, setLoading] = useState(false);
	const [values, setValues] = useState<AskValues>({});
	const [others, setOthers] = useState<AskOthers>({});
	const [touched, setTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<Result>(null);
	/** The question was answered (by this page or elsewhere): the form stays off until a new question loads. */
	const [done, setDone] = useState(false);
	const busyRef = useRef(false);
	const seq = useRef(0);

	const load = useCallback(
		async (keepResult = false) => {
			const mine = ++seq.current;
			setLoading(true);
			try {
				const next = await getSessionAsk(sessionId, machine);
				if (mine !== seq.current) return;
				setAsk(next);
				setLoadError(null);
				setPluginOld(false);
				setTouched(false);
				setDone(false);
				if (!keepResult) setResult(null);
				setValues(next.open && "fields" in next ? initialValues(next.fields) : {});
				setOthers({});
			} catch (error) {
				if (mine !== seq.current) return;
				if (isPluginTooOld(error)) setPluginOld(true);
				else setLoadError(error instanceof Error ? error.message : String(error));
			} finally {
				if (mine === seq.current) setLoading(false);
			}
		},
		[sessionId, machine],
	);

	useEffect(() => {
		if (capability === "on" && sessionId && !locked) void load();
		return () => {
			seq.current++;
		};
	}, [capability, sessionId, locked, load]);

	const form = ask?.open && "fields" in ask ? ask : null;
	const problems = form ? answerProblems(form.fields, values, others) : {};
	const modeProblem =
		interruptMode === undefined
			? "Reading how this session takes messages…"
			: interruptMode === "wait"
				? WAIT_MODE_TEXT
				: interruptMode === null
					? UNKNOWN_MODE_TEXT
					: null;
	const blocked = locked ?? modeProblem;

	const submit = async () => {
		if (busyRef.current || !form || done) return;
		setTouched(true);
		if (Object.keys(problems).length > 0 || blocked) return;
		busyRef.current = true;
		setBusy(true);
		setResult(null);
		try {
			const body = {
				askId: form.askId,
				answers: toAnswers(form.fields, values, others),
				messageId: newMessageId("ask"),
			};
			setResult({ tone: "warn", text: "Sending…" });
			const delivered = await deliver(
				() => answerSessionAsk(sessionId, body, machine),
				() => getMessageStatus(sessionId, body.messageId, machine),
			);
			if (delivered.state !== "failed") setDone(true);
			setResult({
				tone: delivered.state === "delivered" ? "ok" : delivered.state === "failed" ? "bad" : "warn",
				text: deliveryText(delivered, "answer"),
			});
		} catch (error) {
			const failure = askFailure(error);
			if (failure.kind === "closed") {
				setDone(true);
				setResult({ tone: "warn", text: failure.text });
			} else if (failure.kind === "changed") {
				setResult({ tone: "warn", text: failure.text });
				void load(true);
			} else {
				setResult({ tone: failure.kind === "uncertain" ? "warn" : "bad", text: failure.text });
			}
		} finally {
			busyRef.current = false;
			setBusy(false);
			onChanged();
		}
	};

	const openLink = (
		<button
			type="button"
			className="btn"
			data-size="sm"
			data-variant="ghost"
			disabled={locked !== null}
			onClick={onOpen}
		>
			Answer in Open &amp; control
		</button>
	);

	return (
		<div className="sd-callout" data-tone="accent" role="region" aria-label="Question">
			<div>
				<b>Needs you</b> · {waitingText}
			</div>
			{capability === "off" && <p className="sd-hint">{updateHubHint(machineName, "askAnswer")}</p>}
			{capability === "unknown" && !locked && <CapabilityChecking machineName={machineName} />}
			{pluginOld && <p className="sd-hint">{updatePluginHint(machineName, "answer questions from here")}</p>}
			{capability === "on" && !pluginOld && !locked && (
				<>
					{loading && !ask && <p className="sd-hint">Loading the question…</p>}
					{loadError && (
						<div className="sd-row">
							<p className="sd-hint" data-tone="bad" role="alert">
								Could not read the question: {loadError}
							</p>
							<button
								type="button"
								className="btn"
								data-size="sm"
								disabled={loading}
								onClick={() => void load()}
							>
								Try again
							</button>
						</div>
					)}
					{ask?.open === false && !done && (
						<p className="sd-hint">
							The session reports no open question right now. It may be waiting in its terminal instead.
						</p>
					)}
					{ask?.open && "tooLarge" in ask && ask.tooLarge && <p className="sd-hint">{QUESTION_TOO_LARGE_TEXT}</p>}
					{ask?.open && "unsupported" in ask && (
						<>
							{ask.text && <p className="sd-qtext">{ask.text}</p>}
							<p className="sd-hint">
								{QUESTION_UNSUPPORTED_TEXT}
								{ask.reason ? ` (${ask.reason})` : ""}
							</p>
						</>
					)}
					{form && (
						<form
							className="sd-ask"
							onSubmit={event => {
								event.preventDefault();
								void submit();
							}}
						>
							{form.fields.map(field => (
								<AskFieldInput
									key={field.name}
									field={field}
									value={values[field.name]}
									other={others[field.name] ?? { on: false, text: "" }}
									onOther={other => setOthers(current => ({ ...current, [field.name]: other }))}
									disabled={busy || done || blocked !== null}
									problem={touched ? (problems[field.name] ?? null) : null}
									onChange={value => setValues(current => ({ ...current, [field.name]: value }))}
								/>
							))}
							{blocked && <p className="sd-hint">{blocked}</p>}
							<div className="sd-row">
								<button
									type="submit"
									className="btn"
									data-size="sm"
									data-variant="primary"
									disabled={busy || done || blocked !== null}
									title={blocked ?? undefined}
								>
									{busy ? "Sending…" : "Send answer"}
								</button>
								{openLink}
							</div>
						</form>
					)}
				</>
			)}
			{(!form || capability !== "on" || pluginOld) && <div className="sd-row">{openLink}</div>}
			{result && (
				<p className="sd-result" data-tone={result.tone} role={result.tone === "bad" ? "alert" : "status"}>
					{result.text}
				</p>
			)}
		</div>
	);
}

function AskFieldInput({
	field,
	value,
	other,
	onOther,
	disabled,
	problem,
	onChange,
}: {
	field: AskField;
	value: string | string[] | undefined;
	other: { on: boolean; text: string };
	onOther: (other: { on: boolean; text: string }) => void;
	disabled: boolean;
	problem: string | null;
	onChange: (value: string | string[]) => void;
}) {
	const id = useId();
	const label = (
		<>
			{field.label || field.name}
			{field.required && (
				<span className="sd-required" aria-label="required">
					{" "}
					*
				</span>
			)}
		</>
	);
	const error = problem && (
		<span className="sd-hint" data-tone="bad" id={`${id}-err`}>
			{problem}
		</span>
	);
	const described = problem ? `${id}-err` : undefined;
	if (field.type === "radio" || field.type === "checkbox") {
		const list = Array.isArray(value) ? value : [];
		return (
			<fieldset className="sd-field" aria-invalid={problem ? true : undefined} aria-describedby={described}>
				<legend>{label}</legend>
				<div className="sd-qopts" role={field.type === "radio" ? "radiogroup" : "group"}>
					{field.options.map(option => {
						const on = field.type === "radio" ? !other.on && value === option.value : list.includes(option.value);
						return (
							<label
								key={option.value}
								className="sd-qopt"
								data-on={on}
								data-disabled={option.disabled || disabled}
							>
								<input
									type={field.type}
									name={`${id}-${field.name}`}
									value={option.value}
									checked={on}
									disabled={disabled || option.disabled}
									onChange={event => {
										if (field.type === "radio") {
											onOther({ ...other, on: false });
											onChange(option.value);
										} else
											onChange(
												event.target.checked
													? [...list, option.value]
													: list.filter(item => item !== option.value),
											);
									}}
								/>
								<span>{option.label}</span>
							</label>
						);
					})}
					{field.allowOther && (
						<label className="sd-qopt" data-on={other.on} data-disabled={disabled}>
							<input
								type={field.type}
								name={`${id}-${field.name}`}
								value=""
								checked={other.on}
								disabled={disabled}
								onChange={() => {
									if (field.type === "radio") {
										onChange("");
										onOther({ ...other, on: true });
									} else onOther({ ...other, on: !other.on });
								}}
							/>
							<span className="sd-other">
								Other…
								{other.on && (
									<input
										type="text"
										className="input"
										aria-label={`Your answer for ${field.label || field.name}`}
										placeholder="Type your answer"
										value={other.text}
										disabled={disabled}
										onChange={event => onOther({ on: true, text: event.target.value })}
									/>
								)}
								{other.on && (
									<span className="sd-hint">
										{other.text.length}/{MAX_OTHER_CHARS}
									</span>
								)}
							</span>
						</label>
					)}
				</div>
				{error}
			</fieldset>
		);
	}
	return (
		<div className="sd-field">
			<label htmlFor={id}>{label}</label>
			{field.type === "select" ? (
				<select
					id={id}
					className="input"
					multiple={field.multiple}
					value={field.multiple ? (Array.isArray(value) ? value : []) : typeof value === "string" ? value : ""}
					disabled={disabled}
					aria-invalid={problem ? true : undefined}
					aria-describedby={described}
					onChange={event =>
						onChange(
							field.multiple
								? Array.from(event.target.selectedOptions ?? [], option => option.value)
								: event.target.value,
						)
					}
				>
					{!field.multiple && <option value="">Choose…</option>}
					{field.options.map(option => (
						<option key={option.value} value={option.value} disabled={option.disabled}>
							{option.label}
						</option>
					))}
				</select>
			) : field.type === "textarea" ? (
				<textarea
					id={id}
					className="input"
					rows={3}
					value={typeof value === "string" ? value : ""}
					disabled={disabled}
					aria-invalid={problem ? true : undefined}
					aria-describedby={described}
					onChange={event => onChange(event.target.value)}
				/>
			) : (
				<input
					id={id}
					className="input"
					type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
					inputMode={field.type === "number" ? "decimal" : undefined}
					value={typeof value === "string" ? value : ""}
					disabled={disabled}
					aria-invalid={problem ? true : undefined}
					aria-describedby={described}
					onChange={event => onChange(event.target.value)}
				/>
			)}
			{error}
		</div>
	);
}
