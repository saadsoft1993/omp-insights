import { useCallback, useEffect, useState } from "react";
import { selectMachine, selection, useSelectedMachine } from "../app/machine";
import { type DashboardSection, SECTION_IDS } from "../app/nav";
import type { TimeRange } from "../types";
import { TIME_RANGES } from "./range";

export interface HashRoute {
	section: DashboardSection;
	range: TimeRange;
	/** Deep-linked trace session file (traces only). */
	session: string | null;
	/** Selected hub session (`#/sessions/<sessionId>`), sessions page only. */
	hubSession: string | null;
	sub: string | null;
	params: Record<string, string>;
	machine?: string | null;
	traceMachine?: string | null;
}

export function parseHash(hash: string): HashRoute {
	const [fullPath, queryPart] = hash.replace(/^#\/?/, "").split("?");
	const [pathPart, ...rest] = fullPath.split("/");
	const section =
		pathPart === "providers" || pathPart === "connections"
			? "accounts"
			: (SECTION_IDS as readonly string[]).includes(pathPart)
				? (pathPart as DashboardSection)
				: "overview";
	let hubSession: string | null = null;
	if (section === "sessions" && rest.length > 0 && rest.join("/") !== "") {
		const raw = rest.join("/");
		try {
			hubSession = decodeURIComponent(raw);
		} catch {
			hubSession = raw;
		}
	}
	const control = ["delivery", "aws", "sms"].includes(section);
	let sub: string | null = null;
	if (control && rest.join("/")) {
		try {
			sub = decodeURIComponent(rest.join("/"));
		} catch {
			sub = rest.join("/");
		}
	}
	const params = new URLSearchParams(queryPart ?? "");
	const rangeParam = params.get("range");
	const range = (TIME_RANGES as readonly string[]).includes(rangeParam ?? "") ? (rangeParam as TimeRange) : "24h";
	const machine = params.get("m");
	const traceMachine = params.get("tm");
	const extra: Record<string, string> = {};
	if (control)
		params.forEach((value, key) => {
			if (!["range", "s", "m", "tm"].includes(key)) extra[key] = value;
		});
	return {
		section,
		range,
		session: params.get("s"),
		sub,
		params: extra,
		hubSession,
		...(machine ? { machine } : {}),
		...(traceMachine ? { traceMachine } : {}),
	};
}

export function buildHash({
	section,
	range,
	session,
	hubSession,
	sub,
	params,
	machine,
	traceMachine,
}: HashRoute): string {
	const sessionPart = session ? `&s=${encodeURIComponent(session)}` : "";
	const selected = section === "sessions" && hubSession ? `/${encodeURIComponent(hubSession)}` : "";
	const control = ["delivery", "aws", "sms"].includes(section);
	const subPart = control && sub ? `/${encodeURIComponent(sub)}` : "";
	const machinePart = machine ? `&m=${encodeURIComponent(machine)}` : "";
	const traceMachinePart = traceMachine && session ? `&tm=${encodeURIComponent(traceMachine)}` : "";
	const extra = new URLSearchParams();
	if (control)
		for (const [key, value] of Object.entries(params)) {
			if (!["range", "s", "m", "tm"].includes(key)) extra.set(key, value);
		}
	const suffix = extra.toString();
	return `#/${section}${selected}${subPart}?range=${range}${sessionPart}${machinePart}${traceMachinePart}${suffix ? `&${suffix}` : ""}`;
}

export function applyControl(
	route: HashRoute,
	{ sub, params: patch }: { sub: string | null; params: Record<string, string | null> },
): HashRoute {
	const params = { ...route.params };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete params[key];
		else params[key] = value;
	}
	return { ...route, sub, params };
}

/**
 * Dashboard location in the URL hash (`#/models?range=7d`). Setters update
 * state synchronously and push a history entry, so the UI never waits on the
 * `hashchange` round trip.
 */
export function useHashRoute() {
	const [route, setRoute] = useState(() => {
		const initial = parseHash(window.location.hash);
		if (initial.machine) selectMachine(initial.machine);
		return initial;
	});
	const selected = useSelectedMachine();

	useEffect(() => {
		const onHashChange = () => {
			const next = parseHash(window.location.hash);
			if (next.machine) selectMachine(next.machine);
			setRoute(next);
		};
		window.addEventListener("hashchange", onHashChange);
		window.addEventListener("popstate", onHashChange);
		// Canonicalize a missing/partial hash without adding a history entry.
		const canonical = buildHash(parseHash(window.location.hash));
		if (window.location.hash !== canonical) history.replaceState(null, "", canonical);
		return () => {
			window.removeEventListener("hashchange", onHashChange);
			window.removeEventListener("popstate", onHashChange);
		};
	}, []);
	useEffect(() => {
		if (!selected) return;
		setRoute(current => {
			if (current.machine === selected) return current;
			const next = { ...current, machine: selected };
			history.replaceState(null, "", buildHash(next));
			return next;
		});
	}, [selected]);

	const navigate = useCallback((next: HashRoute) => {
		const current = { ...next, machine: selection() ?? next.machine };
		setRoute(current);
		const hash = buildHash(current);
		if (window.location.hash !== hash) history.pushState(null, "", hash);
	}, []);

	const setSection = useCallback(
		(section: DashboardSection) =>
			// The deep-linked session only applies to the traces view.
			navigate({
				...route,
				section,
				session: section === "traces" ? route.session : null,
				hubSession: null,
				sub: null,
				params: {},
			}),
		[route, navigate],
	);
	const setRange = useCallback((range: TimeRange) => navigate({ ...route, range }), [route, navigate]);
	const setSession = useCallback(
		(session: string | null, traceMachine?: string) =>
			navigate({ ...route, session, traceMachine: session ? traceMachine : undefined }),
		[route, navigate],
	);
	const openTranscript = useCallback(
		(session: string, traceMachine?: string) =>
			navigate({ ...route, section: "traces", session, traceMachine, hubSession: null }),
		[route, navigate],
	);

	const setHubSession = useCallback(
		(hubSession: string | null) => navigate({ ...route, section: "sessions", session: null, hubSession }),
		[route, navigate],
	);

	const replace = useCallback((next: HashRoute) => {
		const current = { ...next, machine: selection() ?? next.machine };
		setRoute(current);
		history.replaceState(null, "", buildHash(current));
	}, []);
	const setSub = useCallback((sub: string | null) => replace({ ...route, sub }), [route, replace]);
	const setControl = useCallback(
		(update: { sub: string | null; params: Record<string, string | null> }) => replace(applyControl(route, update)),
		[route, replace],
	);
	const setParams = useCallback(
		(patch: Record<string, string | null>) => {
			const params = { ...route.params };
			for (const [key, value] of Object.entries(patch)) {
				if (value === null) delete params[key];
				else params[key] = value;
			}
			replace({ ...route, params });
		},
		[route, replace],
	);

	return { ...route, setSection, setRange, setSession, setHubSession, setSub, setParams, setControl, openTranscript };
}
