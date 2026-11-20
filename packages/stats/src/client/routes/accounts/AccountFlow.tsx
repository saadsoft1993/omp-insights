import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import {
	answerLogin,
	cancelLogin,
	fetchProviders,
	LoginError,
	pollLogin,
	setPriority,
	startLogin,
	type LoginProvider,
	type LoginState,
} from "../../data/login-flow";
import "./account-flow.css";

export interface FlowMachine {
	id: string;
	name: string;
	ok: boolean;
}
export type FlowMode =
	| { kind: "add" }
	| { kind: "reconnect"; provider: string; providerLabel: string; identity: string; machines: string[] };
export interface AccountFlowProps {
	mode: FlowMode;
	machines: FlowMachine[];
	defaultMachine?: string;
	fleet: boolean;
	existing: Record<string, { provider: string; identity: string; credentialId?: number; managed?: boolean }[]>;
	onClose(): void;
	onChanged(): void;
}

const popularOrder = [
	"anthropic",
	"openai-codex",
	"kimi-code",
	"zai-coding-plan",
	"google-gemini-cli",
	"github-copilot",
];

const groups: Record<LoginProvider["style"], string> = {
	device: "Code on another device",
	paste: "Sign in and paste back",
	"api-key": "API key",
	questions: "A few questions",
};
const active = (state: LoginState["state"]) => !["done", "failed", "expired", "cancelled"].includes(state);
const time = (ms: number) => {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function AccountFlow({
	mode,
	machines,
	defaultMachine,
	fleet,
	existing,
	onClose,
	onChanged,
}: AccountFlowProps): JSX.Element {
	const [providers, setProviders] = useState<LoginProvider[]>([]);
	const [provider, setProvider] = useState<LoginProvider | null>(
		mode.kind === "reconnect"
			? { id: mode.provider, name: mode.providerLabel, style: "device", popular: false, hint: "" }
			: null,
	);
	const [selected, setSelected] = useState<string[]>(
		mode.kind === "reconnect" ? mode.machines : defaultMachine ? [defaultMachine] : machines.map(m => m.id),
	);
	const [phase, setPhase] = useState<"pick" | "machines" | "run" | "priority" | "result">(
		mode.kind === "add" ? "pick" : "run",
	);
	const [search, setSearch] = useState("");
	const [index, setIndex] = useState(0);
	const [login, setLogin] = useState<LoginState | null>(null);
	const [busyLogin, setBusyLogin] = useState<LoginState | null>(null);
	const [startFailed, setStartFailed] = useState(false);
	const [error, setError] = useState("");
	const [value, setValue] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [copied, setCopied] = useState(false);
	const [choice, setChoice] = useState<"first" | "backup">("backup");
	const [priorityResult, setPriorityResult] = useState<Record<string, string> | null>(null);
	const [results, setResults] = useState<Record<string, string>>({});
	const [remaining, setRemaining] = useState(0);
	const [refreshed, setRefreshed] = useState<Record<string, boolean>>({});
	const existingAtStart = useRef(existing);
	const answers = useRef<Record<string, string>>({});
	const answered = useRef(new Set<string>());
	const resumed = useRef<string | null>(null);
	const lastAnswer = useRef<{ loginId: string; prompt: string; secret: boolean } | null>(null);
	const dialog = useRef<HTMLElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const key = useRef<string | null>(null);
	const live = useRef(true);
	const pending = useRef(false);
	const completed = useRef(new Set<string>());
	const machine = selected[index];
	const target = fleet ? machine : undefined;
	const machineName = (id: string) => machines.find(m => m.id === id)?.name || id;

	useLayoutEffect(() => {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialog.current?.focus();
		live.current = true;
		return () => {
			live.current = false;
			key.current = null;
			opener.current?.focus();
			answers.current = {};
		};
	}, []);
	useLayoutEffect(() => {
		const panel = dialog.current;
		if (!panel) return;
		const firstControl = panel.querySelector<HTMLElement>(
			".account-flow-body input:not([disabled]), .account-flow-body button:not([disabled]), .account-flow-body a[href], .account-flow-body select:not([disabled]), .account-flow-body textarea:not([disabled]), footer button:not([disabled])",
		);
		(firstControl ?? panel).focus();
	}, [phase, index, login?.state, busyLogin?.id, startFailed]);
	useEffect(() => {
		const panel = dialog.current;
		if (phase === "pick" && panel && (document.activeElement === panel || !panel.contains(document.activeElement))) {
			panel.querySelector<HTMLElement>('input[type="search"]')?.focus();
		}
	}, [phase, providers]);
	useEffect(() => {
		if (mode.kind === "add")
			void fetchProviders(fleet ? defaultMachine || machines[0]?.id : undefined)
				.then(setProviders)
				.catch(e => setError(String(e.message || e)));
	}, []);
	const begin = useCallback(async () => {
		if (!provider || !machine) return;
		setError("");
		setStartFailed(false);
		resumed.current = null;
		setLogin(null);
		setBusyLogin(null);
		setValue("");
		setCopied(false);
		try {
			const result = await startLogin(target, provider.id, mode.kind === "reconnect" ? mode.identity : undefined);
			if (live.current) setLogin(result);
			else if (active(result.state)) void cancelLogin(target, result.id).catch(() => {});
		} catch (e) {
			if (!live.current) return;
			if (e instanceof LoginError && e.status === 409 && e.login) setBusyLogin(e.login);
			else {
				setError(`Couldn't reach ${machineName(machine)}.`);
				setStartFailed(true);
			}
		}
	}, [provider, machine, target, mode]);
	useEffect(() => {
		if (phase === "run" && provider && machine) void begin();
	}, [phase, index]);
	useEffect(() => {
		if (phase !== "run" || !login || !active(login.state)) return;
		let stopped = false;
		const timer = setInterval(() => {
			if (pending.current) return;
			void pollLogin(target, login.id)
				.then(next => {
					if (!stopped && !pending.current) setLogin(next);
				})
				.catch(e => {
					if (!stopped) setError(e instanceof Error ? e.message : "Could not check sign-in.");
				});
		}, 1500);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [phase, target, login?.id, login?.state]);
	useEffect(() => {
		if (!login || !active(login.state) || login.remainingMs === undefined) return;
		const end = Date.now() + login.remainingMs;
		setRemaining(login.remainingMs);
		const timer = setInterval(() => {
			const left = Math.max(0, end - Date.now());
			setRemaining(left);
			if (left === 0)
				setLogin(current =>
					current?.id === login.id && active(current.state) ? { ...current, state: "expired" } : current,
				);
		}, 250);
		return () => clearInterval(timer);
	}, [login]);
	const send = useCallback(
		async (answer: string, remember = false) => {
			if (!login || pending.current) return;
			const isKey = login.style === "api-key" || (login.provider === provider?.id && provider.style === "api-key");
			const sameProvider = login.provider === provider?.id;
			if (login.input) {
				answered.current.add(`${machine}:${login.id}:${login.input.prompt}`);
				lastAnswer.current = { loginId: login.id, prompt: login.input.prompt, secret: isKey };
			}
			if (remember && login.input && !isKey && sameProvider) answers.current[login.input.prompt] = answer;
			if (isKey && sameProvider) key.current = answer;
			pending.current = true;
			setSubmitting(true);
			setValue("");
			try {
				const next = await answerLogin(target, login.id, answer);
				if (live.current) setLogin(next);
			} catch (e) {
				if (live.current) setError(e instanceof Error ? e.message : "Could not submit answer.");
			} finally {
				pending.current = false;
				if (live.current) setSubmitting(false);
			}
		},
		[login, provider, target, machine],
	);
	useEffect(() => {
		if (login?.state !== "failed" || lastAnswer.current?.loginId !== login.id) return;
		if (lastAnswer.current.secret) key.current = null;
		else delete answers.current[lastAnswer.current.prompt];
		lastAnswer.current = null;
	}, [login]);
	useEffect(() => {
		if (phase !== "run" || login?.state !== "needs-input" || !login.input || login.riskConsent || pending.current)
			return;
		if (login.provider !== provider?.id || (resumed.current === login.id && login.input.secret)) return;
		if (answered.current.has(`${machine}:${login.id}:${login.input.prompt}`)) return;
		const saved =
			login.style === "api-key" || provider?.style === "api-key" ? key.current : answers.current[login.input.prompt];
		if (saved !== undefined && saved !== null) void send(saved);
	}, [login, phase, provider, send]);
	const next = useCallback(
		(result: string) => {
			setResults(old => ({ ...old, [machine]: result }));
			if (index + 1 < selected.length) {
				setLogin(null);
				setIndex(index + 1);
				setPhase("run");
			} else {
				key.current = null;
				answers.current = {};
				setValue("");
				setPhase("result");
			}
		},
		[machine, index, selected.length],
	);
	useEffect(() => {
		if (phase !== "run" || login?.state !== "done" || completed.current.has(`${machine}:${login.id}`)) return;
		completed.current.add(`${machine}:${login.id}`);
		onChanged();
		const matched = existingAtStart.current[machine]?.some(
			a =>
				!a.managed &&
				(login.credentialId !== undefined
					? a.credentialId === login.credentialId
					: !!login.identity && a.provider === login.provider && a.identity === login.identity),
		);
		setRefreshed(old => ({ ...old, [machine]: !!matched }));
		if (login.needsPriority && login.credentialId !== undefined) setPhase("priority");
		else next("ok");
	}, [phase, login, machine, existing, next, onChanged]);
	const close = useCallback(() => {
		live.current = false;
		key.current = null;
		answers.current = {};
		setValue("");
		if (login && active(login.state)) void cancelLogin(target, login.id).catch(() => {});
		onClose();
	}, [login, target, onClose]);
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
			if (e.key === "Tab" && dialog.current) {
				const controls = [
					...dialog.current.querySelectorAll<HTMLElement>(
						'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
					),
				];
				if (!controls.length) {
					e.preventDefault();
					return;
				}
				const first = controls[0],
					last = controls[controls.length - 1];
				if (e.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
					e.preventDefault();
					last.focus();
				} else if (
					!e.shiftKey &&
					(document.activeElement === last || !dialog.current.contains(document.activeElement))
				) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [close]);
	const applyPriority = async () => {
		if (!login || login.credentialId === undefined) return;
		setSubmitting(true);
		setError("");
		try {
			const result = await setPriority({ machine: target, credentialId: login.credentialId, choice, fleet });
			onChanged();
			if (result.applied && Object.values(result.applied).some(v => v !== "ok")) setPriorityResult(result.applied);
			else next("ok");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not set priority.");
		} finally {
			setSubmitting(false);
		}
	};
	const filtered = providers.filter(p =>
		`${p.displayName ?? p.name} ${p.name} ${p.subtitle ?? ""} ${p.id} ${p.hint} ${groups[p.style]}`
			.toLowerCase()
			.includes(search.toLowerCase().trim()),
	);
	const inputLines = login?.input?.text.trimEnd().split("\n") ?? [];
	if (
		login?.input &&
		inputLines.at(-1)?.trim().replace(/:$/, "").trim() === login.input.prompt.trim().replace(/:$/, "").trim()
	)
		inputLines.pop();
	const inputText = inputLines.join("\n").trim();
	const title =
		phase === "pick"
			? "Add account"
			: `${mode.kind === "add" ? "Add" : "Reconnect"} ${provider?.displayName ?? provider?.name ?? "account"}${phase === "run" || phase === "priority" ? ` on ${selected.length > 1 ? "selected machines" : machineName(machine)}` : ""}`;
	return (
		<div className="account-flow-overlay">
			<section
				ref={dialog}
				tabIndex={-1}
				className={`account-flow ${phase === "pick" ? "account-flow-wide" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby="account-flow-title"
			>
				<header>
					<h2 id="account-flow-title">{title}</h2>
					<button type="button" aria-label="Close" onClick={close}>
						×
					</button>
				</header>
				<div className={`account-flow-body${phase === "pick" ? " account-flow-picker" : ""}`}>
					{phase === "pick" && (
						<>
							<input
								aria-label="Search providers"
								type="search"
								placeholder="Search providers"
								value={search}
								onChange={e => setSearch(e.target.value)}
							/>
							<div className="account-flow-provider-list">
								{!search && (
									<>
										<h3>Popular</h3>
										<div className="account-flow-tiles">
											{providers
												.filter(p => p.popular)
												.sort((a, b) => {
													const ai = popularOrder.indexOf(a.id);
													const bi = popularOrder.indexOf(b.id);
													return (ai < 0 ? popularOrder.length : ai) - (bi < 0 ? popularOrder.length : bi);
												})
												.map(p => (
													<button
														key={p.id}
														onClick={() => {
															setProvider(p);
															setPhase("machines");
														}}
													>
														<b>{p.displayName ?? p.name}</b>
														{p.subtitle && <small>{p.subtitle}</small>}
														<small>{p.hint}</small>
													</button>
												))}
										</div>
										<h3>All providers</h3>
									</>
								)}
								{(Object.keys(groups) as LoginProvider["style"][]).map(style => {
									const rows = filtered.filter(p => p.style === style);
									return rows.length ? (
										<div key={style}>
											<h3>{groups[style]}</h3>
											{rows.map(p => (
												<button
													className="account-flow-provider"
													key={p.id}
													onClick={() => {
														setProvider(p);
														setPhase("machines");
													}}
												>
													<span>
														<b>{p.displayName ?? p.name}</b>
														{p.subtitle && <small>{p.subtitle}</small>}
													</span>
												</button>
											))}
										</div>
									) : null;
								})}
								{!filtered.length && <p>No provider matches “{search}”.</p>}
								<small>
									Gemini API keys aren't listed: omp reads them from GEMINI_API_KEY or models.yml, not from a
									login.
								</small>
							</div>
						</>
					)}
					{phase === "machines" && (
						<>
							<p>Which machines should have {provider?.displayName ?? provider?.name}?</p>
							<label>
								<input
									type="checkbox"
									checked={selected.length === machines.length}
									onChange={e => setSelected(e.target.checked ? machines.map(m => m.id) : [])}
								/>{" "}
								All machines
							</label>
							{machines.map(m => (
								<label key={m.id}>
									<input
										type="checkbox"
										checked={selected.includes(m.id)}
										onChange={e =>
											setSelected(
												e.target.checked
													? machines.filter(x => selected.includes(x.id) || x.id === m.id).map(x => x.id)
													: selected.filter(id => id !== m.id),
											)
										}
									/>{" "}
									{m.name}
									{!m.ok && " (unreachable)"}
								</label>
							))}
							<small>
								{provider?.style === "api-key"
									? "You type the key once; it's saved on every machine you pick."
									: "You'll sign in once per machine, one after the other."}
							</small>
						</>
					)}
					{(phase === "run" || phase === "priority" || phase === "result") && selected.length > 1 && (
						<div className="account-flow-progress" aria-label="Progress">
							{selected.map((id, i) => (
								<span key={id}>
									{machineName(id)}{" "}
									{results[id] === "ok"
										? "✓"
										: results[id]
											? "✕"
											: i === index && phase !== "result"
												? "(now)"
												: ""}
								</span>
							))}
						</div>
					)}
					{error && (
						<div role="alert" className="account-flow-error">
							{error}
						</div>
					)}
					{phase === "run" && (
						<>
							{busyLogin ? (
								<div>
									<p>A sign-in is already running on {machineName(machine)}.</p>
									<button
										onClick={() => {
											resumed.current = busyLogin.id;
											setValue("");
											setLogin(busyLogin);
											setBusyLogin(null);
										}}
									>
										Resume
									</button>{" "}
									<button
										onClick={() => {
											void cancelLogin(target, busyLogin.id)
												.then(() => {
													setBusyLogin(null);
													void begin();
												})
												.catch(e => setError(e.message));
										}}
									>
										Cancel
									</button>
								</div>
							) : !login ? (
								!startFailed && <p>Getting a sign-in link for {machineName(machine)}…</p>
							) : (
								<>
									{provider?.notes && <p>{provider.notes}</p>}
									{login.warning && <p role="status">{login.warning}</p>}
									{(login.state === "starting" || login.state === "checking") && (
										<p>
											{login.style === "api-key"
												? `Checking the key on ${machineName(machine)}…`
												: "Waiting for sign-in…"}
										</p>
									)}
									{login.state === "needs-device-confirm" && (
										<ol>
											<li>
												<a href={login.verificationUrl} target="_blank" rel="noreferrer">
													Open the sign-in page ↗
												</a>
											</li>
											{login.deviceCode && (
												<li>
													Enter this code <div className="account-flow-code">{login.deviceCode}</div>
													<button
														onClick={() => {
															void navigator.clipboard.writeText(login.deviceCode || "");
															setCopied(true);
														}}
													>
														{copied ? "Copied ✓" : "Copy"}
													</button>
												</li>
											)}
											<li>Waiting for you… {time(remaining)} left</li>
										</ol>
									)}
									{login.state === "needs-code" && (
										<>
											<ol>
												<li>
													<a href={login.authUrl} target="_blank" rel="noreferrer">
														Open the {provider?.name} sign-in page ↗
													</a>
												</li>
												<li>
													<label>
														Paste the code or the full address you end up on
														<input
															type="text"
															value={value}
															onChange={e => setValue(e.target.value)}
															autoComplete="off"
														/>
													</label>
												</li>
											</ol>
											<p className="account-flow-time">Time left: {time(remaining)}</p>
										</>
									)}
									{login.state === "needs-input" &&
										login.input &&
										(login.riskConsent ? (
											<>
												<pre className="account-flow-warning">{login.input.text}</pre>
												<button disabled={submitting} onClick={() => void send("yes", true)}>
													I understand, continue
												</button>
											</>
										) : (
											<>
												{inputText && <p className="account-flow-warning">{inputText}</p>}
												<label htmlFor="account-flow-input">{login.input.prompt}</label>
												<div className="account-flow-input-wrap">
													<input
														id="account-flow-input"
														type={login.input.secret && !showKey ? "password" : "text"}
														placeholder={login.input.placeholder}
														value={value}
														onChange={e => setValue(e.target.value)}
														autoComplete="off"
													/>
													{login.input.secret && (
														<button
															type="button"
															className="account-flow-toggle"
															onClick={() => setShowKey(!showKey)}
														>
															{showKey ? "Hide" : "Show"}
														</button>
													)}
												</div>
												{(login.style === "api-key" || provider?.style === "api-key") && (
													<small>
														Sent only to the machines you picked and stored in their omp login store. It
														isn't shown again.
													</small>
												)}
												<p className="account-flow-time">Time left: {time(remaining)}</p>
											</>
										))}
									{login.state === "expired" && <p role="alert">The code expired. Try again.</p>}
									{login.state === "failed" && (
										<p role="alert">{login.message || "That didn't work. Try again."}</p>
									)}
									{login.state === "cancelled" && <p>Cancelled. Nothing changed on {machineName(machine)}.</p>}
								</>
							)}
						</>
					)}
					{phase === "priority" && (
						<>
							{priorityResult ? (
								<>
									<p>Priority updated.</p>
									{Object.entries(priorityResult)
										.filter(([, status]) => status !== "ok")
										.map(([id, status]) => (
											<p key={id}>
												{status === "pending"
													? `Will be applied when ${machineName(id)} is back.`
													: `${machineName(id)}: ${status}`}
											</p>
										))}
									<button
										onClick={() => {
											setPriorityResult(null);
											next("ok");
										}}
									>
										Continue
									</button>
								</>
							) : (
								<>
									<p>Use this account first, or as a backup?</p>
									<label>
										<input
											type="radio"
											name="account-priority"
											checked={choice === "first"}
											onChange={() => setChoice("first")}
										/>{" "}
										First
									</label>
									<label>
										<input
											type="radio"
											name="account-priority"
											checked={choice === "backup"}
											onChange={() => setChoice("backup")}
										/>{" "}
										Backup
									</label>
									<button disabled={submitting} onClick={() => void applyPriority()}>
										Continue
									</button>
								</>
							)}
						</>
					)}
					{phase === "result" && (
						<div role="status">
							<p>Connected{login?.identity ? ` as ${login.identity}` : ""} ✓</p>
							<small>
								{selected
									.filter(id => results[id] === "ok")
									.map(id =>
										refreshed[id]
											? `${machineName(id)}: This account was already here. Its login was refreshed.`
											: `Added on ${machineName(id)}.`,
									)
									.join(" ")}
							</small>
						</div>
					)}
				</div>
				<footer>
					{phase === "pick" && <button onClick={close}>Cancel</button>}
					{phase === "machines" && (
						<>
							<button onClick={() => setPhase("pick")}>Back</button>
							<button disabled={!selected.length} onClick={() => setPhase("run")}>
								Continue
							</button>
						</>
					)}
					{phase === "run" && !busyLogin && (
						<>
							<button className="account-flow-cancel" onClick={close}>
								Cancel
							</button>
							{login?.state === "needs-code" && (
								<button
									className="account-flow-primary"
									disabled={!value.trim() || submitting}
									onClick={() => void send(value)}
								>
									{submitting ? "Checking…" : "Connect"}
								</button>
							)}
							{login?.state === "needs-input" && login.input && !login.riskConsent && (
								<button
									className="account-flow-primary"
									disabled={
										submitting ||
										((login.style === "api-key" || provider?.style === "api-key") && !value.trim())
									}
									onClick={() => void send(value, true)}
								>
									{submitting
										? "Checking…"
										: login.style === "api-key" || provider?.style === "api-key"
											? "Save"
											: "Continue"}
								</button>
							)}
							{(startFailed || (login && ["expired", "failed", "cancelled"].includes(login.state))) && (
								<>
									<button onClick={() => void begin()}>Try again</button>
									{index + 1 < selected.length && (
										<button onClick={() => next("failed")}>Skip {machineName(machine)}</button>
									)}
								</>
							)}
						</>
					)}
					{phase === "result" && <button onClick={close}>Close</button>}
				</footer>
			</section>
		</div>
	);
}
