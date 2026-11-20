import { Copy, Link2, Plus, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { getMachineDevices, revokeFleetLinks, revokeMachineDevice, type FleetDevice } from "../data/devices";
import {
	createHubPairLink,
	getHubDevices,
	type HubPairLink,
	revokeHubAutoDevices,
	revokeOtherHubDevices,
} from "../data/hub";
import { useQuery } from "../data/query";
import { type Column, EmptyState, Modal, PageHeader, Table } from "../ui";
import { Help, type Notice, NoticeLine } from "./hub-common";
import {
	browserName,
	machineOffline,
	unavailableGroups,
	MachineGroupLabel,
	MachineProblems,
	type OpsMachine,
	OpsMachineCell,
	UpdateHubHint,
	useCapabilities,
	useOpsMachines,
	usePerMachine,
	When,
} from "./ops-common";

export interface DevicesRouteProps {
	active: boolean;
}

interface DeviceRow extends FleetDevice {
	machine: OpsMachine;
	stale: boolean;
	key: string;
}

type Confirm =
	| { kind: "one"; device: DeviceRow }
	| { kind: "fleet"; machine: OpsMachine }
	| { kind: "auto"; machine: OpsMachine }
	| { kind: "others"; machine: OpsMachine }
	| null;

const AUTO_PAIR_WARNING =
	"Auto-pair is on: any of your Tailscale devices that opens the app again is paired again, this one included. To lock a device out, remove it from your Tailscale network.";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function countdown(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How the browser got paired, as the Kind pill shows it. */
export function deviceKind(d: FleetDevice): { label: string; tone: "accent" | "ok" | "neutral" } {
	if (d.source === "fleet-link") return { label: "Fleet link", tone: "accent" };
	if (d.scope === "local") return { label: "Local link", tone: "neutral" };
	if (d.auto) return { label: "Auto-paired", tone: "ok" };
	return { label: "Paired by code", tone: "neutral" };
}

/** The link as a QR code: black on white whatever the theme, so a phone camera can read it. */
export function PairQr({ text }: { text: string }) {
	const qr = useMemo(() => {
		const { data } = encode(text, { ecc: "M", border: 0 });
		const n = data.length;
		let d = "";
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
			}
		}
		return { n, d };
	}, [text]);
	return (
		<svg
			className="pair-qr"
			viewBox={`-4 -4 ${qr.n + 8} ${qr.n + 8}`}
			role="img"
			aria-label="QR code of the pairing link"
			shapeRendering="crispEdges"
		>
			<rect x={-4} y={-4} width={qr.n + 8} height={qr.n + 8} fill="#fff" />
			<path fill="#000" d={qr.d} />
		</svg>
	);
}

export function DevicesRoute({ active }: DevicesRouteProps) {
	const { machines, everyMachine, all, fleet } = useOpsMachines();
	const devices = usePerMachine("devices", machines, (id, signal) => getMachineDevices(id || undefined, signal), {
		active,
		pollMs: 30_000,
	});
	const capabilities = useCapabilities(machines, active);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [confirm, setConfirm] = useState<Confirm>(null);
	const [alsoNodes, setAlsoNodes] = useState(false);
	const [busy, setBusy] = useState(false);
	const [pairing, setPairing] = useState(false);

	const rows: DeviceRow[] = devices.answers.flatMap(answer =>
		(answer.data?.devices ?? []).map(d => ({
			...d,
			machine: answer.machine,
			stale: answer.stale || !answer.machine.reachable,
			key: `${answer.machine.id}:${d.scope}:${d.id}`,
		})),
	);
	const self = machines.find(m => m.self) ?? null;
	const selfData = self ? (devices.answers.find(a => a.machine.id === self.id)?.data ?? null) : null;
	/** Every configured node, whatever the header shows: the cleanup must reach them all. */
	const nodes = everyMachine.filter(m => !m.self);
	const autoCount = selfData?.devices.filter(d => d.auto).length ?? 0;
	const lacksLastSeen = (machine: OpsMachine) => {
		const caps = capabilities(machine.id);
		return caps !== null && caps.devicesLastSeen !== true;
	};
	/** Fleet-link pairings on the nodes that a self browser created (Unpair can remove them too). */
	const linkedOnNodes = (device: DeviceRow) =>
		rows.filter(r => !r.machine.self && r.originDevice === device.id && r.source === "fleet-link");

	const ask = (next: Confirm) => {
		setAlsoNodes(false);
		setConfirm(next);
	};
	const run = async () => {
		if (!confirm) return;
		setBusy(true);
		try {
			let remote = 0;
			if (confirm.kind === "one" && alsoNodes) {
				const results = await Promise.allSettled(nodes.map(node => revokeFleetLinks(node.id, confirm.device.id)));
				const failures = results.flatMap((result, index) =>
					result.status === "rejected" ? [`${nodes[index].name}: ${errorText(result.reason)}`] : [],
				);
				remote = results.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value.revoked : 0), 0);
				if (failures.length)
					throw new Error(
						`unpaired ${remote} fleet ${remote === 1 ? "link" : "links"} on the other machines, but kept this one so you can retry. ${failures.join("; ")}`,
					);
			}
			const result =
				confirm.kind === "one"
					? await revokeMachineDevice(confirm.device.machine.id || undefined, confirm.device.id)
					: confirm.kind === "fleet"
						? await revokeFleetLinks(confirm.machine.id)
						: confirm.kind === "auto"
							? await revokeHubAutoDevices()
							: await revokeOtherHubDevices();
			const total = result.revoked + remote;
			const where = confirm.kind === "one" ? confirm.device.machine.name : confirm.machine.name;
			const selfHit = confirm.kind === "one" ? confirm.device.machine.self : confirm.machine.self;
			setConfirm(null);
			setNotice({ tone: "ok", text: `Unpaired ${total} ${total === 1 ? "browser" : "browsers"} on ${where}.` });
			if (selfHit && "self" in result && result.self) window.location.reload();
		} catch (error) {
			setConfirm(null);
			setNotice({ tone: "bad", text: `Could not unpair: ${errorText(error)}` });
		} finally {
			setBusy(false);
			devices.refetch();
		}
	};

	const columns: Column<DeviceRow>[] = [
		{
			key: "device",
			header: "Device",
			sort: d => browserName(d.label),
			render: d => (
				<span className="ops-pc-text" title={d.label}>
					<span className="ops-pc-title">
						{browserName(d.label)}
						{d.current && (
							<span className="badge ops-this" data-tone="accent">
								this browser
							</span>
						)}
					</span>
					<span className="ops-pc-sub ops-mono">
						{d.id}
						{d.originDevice ? ` · linked from ${d.originDevice}` : ""}
					</span>
				</span>
			),
		},
		{
			key: "kind",
			header: "Kind",
			kind: "status",
			width: 130,
			sort: d => deviceKind(d).label,
			render: d => {
				const k = deviceKind(d);
				return (
					<span className="badge" data-tone={k.tone}>
						{k.label}
					</span>
				);
			},
		},
		{
			key: "machine",
			header: "Machine",
			kind: "machine",
			width: 110,
			priority: 2,
			sort: d => d.machine.short,
			render: d => <OpsMachineCell machine={d.machine} />,
		},
		{
			key: "paired",
			header: "Paired",
			kind: "date",
			width: 96,
			sort: d => d.pairedAt,
			render: d => <When at={d.pairedAt} />,
		},
		{
			key: "expires",
			header: "Expires",
			kind: "date",
			width: 96,
			priority: 2,
			sort: d => d.expiresAt ?? Number.MAX_SAFE_INTEGER,
			render: d => <When at={d.expiresAt} empty="never" />,
		},
		{
			key: "lastSeen",
			header: "Last seen",
			kind: "date",
			width: 96,
			priority: 3,
			sort: d => (d.current ? Date.now() : d.lastSeen),
			render: d =>
				d.current ? (
					"now"
				) : lacksLastSeen(d.machine) ? (
					<span className="ops-dim" title={`Update the hub on ${d.machine.name} to see this`}>
						–
					</span>
				) : (
					<When at={d.lastSeen} />
				),
		},
		{
			key: "actions",
			header: "",
			kind: "actions",
			width: 112,
			render: d => (
				<button
					type="button"
					className="btn"
					data-size="sm"
					data-variant={d.current ? "danger" : undefined}
					disabled={machineOffline(d.machine) !== null}
					title={machineOffline(d.machine) ?? undefined}
					aria-label={`Unpair ${d.id} on ${d.machine.name}`}
					onClick={() => ask({ kind: "one", device: d })}
				>
					{d.current ? "Unpair…" : "Unpair"}
				</button>
			),
		},
	];

	const single = machines.length === 1 ? machines[0] : null;
	const singleNode = single && !single.self ? single : null;
	const fleetLinkButton = (machine: OpsMachine) => (
		<button
			type="button"
			className="btn"
			data-size="sm"
			data-variant="ghost"
			disabled={
				machineOffline(machine) !== null ||
				!rows.some(r => r.machine.id === machine.id && r.source === "fleet-link")
			}
			title={machineOffline(machine) ?? undefined}
			onClick={() => ask({ kind: "fleet", machine })}
		>
			Unpair fleet links…
		</button>
	);
	// A bulk action with nothing to act on is hidden, not shown as "(0)".
	const tools = (
		<>
			{self && selfData && autoCount > 0 && (
				<button
					type="button"
					className="btn"
					data-size="sm"
					data-variant="ghost"
					onClick={() => ask({ kind: "auto", machine: self })}
				>
					Unpair all auto-paired{all ? ` on ${self.short}` : ""} ({autoCount})…
				</button>
			)}
			{self && selfData && selfData.devices.length > 1 && (
				<button
					type="button"
					className="btn"
					data-size="sm"
					data-variant="ghost"
					onClick={() => ask({ kind: "others", machine: self })}
				>
					Unpair every other browser{all ? ` on ${self.short}` : ""}…
				</button>
			)}
			{singleNode && fleetLinkButton(singleNode)}
		</>
	);
	const lastSeenHints = machines.filter(lacksLastSeen);
	const confirmMachine = confirm ? (confirm.kind === "one" ? confirm.device.machine : confirm.machine) : null;
	const confirmAuto = confirmMachine
		? (devices.answers.find(a => a.machine.id === confirmMachine.id)?.data?.autoPair ?? false)
		: false;
	const touchesTailnet = confirm !== null && (confirm.kind !== "one" || confirm.device.scope === "tailnet");
	/** Unpairing this one browser won't keep it out: auto-pair pairs it again on its next visit. */
	const reArmed = confirm?.kind === "one" && confirmAuto && confirm.device.scope === "tailnet";
	const confirmLinked = confirm?.kind === "one" && confirm.device.machine.self ? linkedOnNodes(confirm.device) : [];

	return (
		<div className="page ops-page">
			<PageHeader
				title="Devices"
				description={`Browsers paired with ${all || !single ? "each machine's hub" : `${single.name}'s hub`}.`}
				actions={
					<button type="button" className="btn" data-variant="primary" onClick={() => setPairing(true)}>
						<Plus size={14} /> Pair a new browser
					</button>
				}
			/>
			<section className="ops-strip" aria-label="Pairing policy per machine">
				{devices.answers.map(answer => (
					<div key={answer.machine.id || "local"}>
						<small>{answer.machine.id ? answer.machine.name : answer.machine.short}</small>
						{answer.error ? (
							// A failed refresh wins over the last answer, which stays greyed in the table.
							<b className="ops-warn" title={answer.error}>
								Didn't answer
							</b>
						) : answer.data ? (
							<>
								<b>{answer.data.autoPair ? "Auto-pair on" : "Auto-pair off"}</b>
								<span className="ops-dim"> · {answer.data.devices.length} paired</span>
							</>
						) : (
							<span className="ops-dim">Loading…</span>
						)}
					</div>
				))}
			</section>
			<MachineProblems
				answers={devices.answers}
				what="its paired browsers"
				onRetry={devices.refetch}
				polling={devices.polling}
			/>
			<NoticeLine notice={notice} />
			<Table
				variant="std"
				dense
				title="Paired browsers"
				subtitle={
					<>
						{rows.length} {rows.length === 1 ? "browser" : "browsers"} · this browser first
						{lastSeenHints.map(m => (
							<span key={m.id}>
								{" "}
								· <UpdateHubHint machine={m}>to see when its browsers were last seen.</UpdateHubHint>
							</span>
						))}
					</>
				}
				tools={tools}
				columns={columns}
				rows={rows}
				rowKey={d => d.key}
				loading={devices.loading}
				initialSort={{ key: "paired", dir: "desc" }}
				pinned={d => d.current}
				emptyGroups={
					all
						? unavailableGroups(devices.answers, id => rows.some(r => r.machine.id === id), "paired browsers")
						: undefined
				}
				stale={d => d.stale}
				group={
					all
						? d => ({
								key: d.machine.id,
								label: (
									<MachineGroupLabel
										machine={d.machine}
										count={`${rows.filter(r => r.machine.id === d.machine.id).length} paired`}
									/>
								),
								action: d.machine.self ? undefined : fleetLinkButton(d.machine),
							})
						: undefined
				}
				empty={<EmptyState title="No paired browsers" hint="Pair one with a link from Pair a new browser." />}
			/>
			<Modal
				open={confirm !== null}
				title={
					confirm?.kind === "one"
						? confirm.device.current
							? "Unpair this browser?"
							: `Unpair ${browserName(confirm.device.label)} on ${confirm.device.machine.name}?`
						: confirm?.kind === "fleet"
							? `Unpair all fleet links on ${confirm.machine.name}?`
							: confirm?.kind === "auto"
								? `Unpair all auto-paired browsers on ${confirm.machine.name}?`
								: confirm
									? `Unpair every other browser on ${confirm.machine.name}?`
									: ""
				}
				onClose={() => (busy ? undefined : setConfirm(null))}
				primaryAction={{
					label: busy ? "Unpairing…" : reArmed ? "Unpair anyway" : "Unpair",
					onClick: run,
					disabled: busy,
				}}
			>
				<div className="ops-confirm">
					{confirm?.kind === "one" && (
						<>
							<p>
								{browserName(confirm.device.label)} ({confirm.device.id},{" "}
								{confirm.device.scope === "tailnet" ? "tailnet" : "this Mac"}) loses access to{" "}
								{confirm.device.machine.name}.
							</p>
							{confirm.device.current && !(confirmAuto && confirm.device.scope === "tailnet") && (
								<p>This is the browser you are using: it goes back to the Pair screen.</p>
							)}
							{confirmAuto &&
								confirm.device.scope === "tailnet" && (
									// The hub pairs any of the owner's Tailscale browsers that opens it without a cookie, so
									// unpairing one only lasts until its next visit (for this browser: the reload right after).
									<div className="ops-auto-pair" role="note">
										<p>
											Auto-pair is on for {confirm.device.machine.name}, so{" "}
											{confirm.device.current
												? "this browser is paired again straight away when the page reloads after unpairing, with a new device id."
												: `${browserName(confirm.device.label)} is paired again automatically the next time it opens ${confirm.device.machine.name}'s dashboard.`}{" "}
											Unpairing alone doesn&apos;t keep it out.
										</p>
										<p>
											To keep it out, first turn auto-pair off on {confirm.device.machine.name}: remove{" "}
											<code>OMP_HUB_AUTO_PAIR=1</code> from the hub's <code>.env</code> there and restart its
											hub. Or remove the device from your Tailscale network.
										</p>
									</div>
								)}
							{confirm.device.machine.self && confirm.device.scope === "tailnet" && nodes.length > 0 && (
								<label className="ops-check">
									<input type="checkbox" checked={alsoNodes} onChange={() => setAlsoNodes(value => !value)} />
									<span>
										Also unpair the fleet links it made on {nodes.map(m => m.name).join(" and ")}
										{confirmLinked.length ? ` (${confirmLinked.length} listed)` : ""}
									</span>
								</label>
							)}
						</>
					)}
					{confirm?.kind === "auto" && (
						<p>
							{autoCount} {autoCount === 1 ? "browser" : "browsers"} paired automatically through Tailscale lose
							access.
						</p>
					)}
					{confirm?.kind === "fleet" && (
						<p>
							Every fleet-link pairing on {confirm.machine.name} loses access; this dashboard pairs again when
							needed.
						</p>
					)}
					{confirm?.kind === "others" && (
						<p>Only this browser stays paired. Every other device must pair again.</p>
					)}
					{confirmAuto && touchesTailnet && confirm?.kind !== "one" && <p>{AUTO_PAIR_WARNING}</p>}
				</div>
			</Modal>
			<PairDialog
				open={pairing}
				onClose={() => setPairing(false)}
				hubName={fleet ? (everyMachine.find(m => m.self)?.name ?? "this hub") : "this machine"}
				others={everyMachine.filter(m => !m.self)}
			/>
		</div>
	);
}

/**
 * Pairing link for this dashboard's hub, with its QR code. The other machines are managed from here (the hub links
 * a paired browser to them itself), so there is nothing to pair on them separately.
 */
function PairDialog({
	open,
	onClose,
	hubName,
	others,
}: {
	open: boolean;
	onClose: () => void;
	hubName: string;
	others: OpsMachine[];
}) {
	const hub = useQuery(["hub-devices-self"], ({ signal }) => getHubDevices(signal), {
		enabled: open,
		scope: "local",
		retain: false,
	});
	const [link, setLink] = useState<HubPairLink | null>(null);
	const [creating, setCreating] = useState(false);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const expiresAt = link?.expiresAt ?? null;
	useEffect(() => {
		if (expiresAt === null) return;
		setNow(Date.now());
		if (Date.now() >= expiresAt) return;
		const timer = setInterval(() => {
			const t = Date.now();
			setNow(t);
			if (t >= expiresAt) clearInterval(timer);
		}, 1000);
		return () => clearInterval(timer);
	}, [expiresAt]);

	const create = async () => {
		setCreating(true);
		setNotice(null);
		try {
			setLink(await createHubPairLink());
		} catch (error) {
			setNotice({ tone: "bad", text: `Could not create a link: ${errorText(error)}` });
		} finally {
			setCreating(false);
		}
	};
	const copy = async (url: string) => {
		try {
			await navigator.clipboard.writeText(url);
			setNotice({ tone: "ok", text: "Link copied." });
		} catch {
			setNotice({ tone: "bad", text: "Could not copy here; select the link above and copy it by hand." });
		}
	};
	const share = async (url: string) => {
		try {
			await navigator.share({ url });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") return;
			setNotice({ tone: "bad", text: `Could not share: ${errorText(error)}` });
		}
	};
	const close = () => {
		setLink(null);
		setNotice(null);
		onClose();
	};

	const canLink = hub.data?.canLink ?? false;
	const local = hub.data?.scope === "local";
	const expired = link !== null && now >= link.expiresAt;
	return (
		<Modal
			open={open}
			title={`Pair a new browser with ${hubName}`}
			onClose={close}
			cancelLabel={link ? "Done" : "Cancel"}
			primaryAction={
				link && !expired
					? undefined
					: {
							label: local ? "Create link for this Mac" : "Create pairing link",
							onClick: create,
							disabled: !canLink || creating,
						}
			}
		>
			<div className="ops-confirm">
				{!link && (
					<>
						<p>
							A pairing link works once and expires after 5 minutes. Whoever opens it first is paired, so show it
							only to the device you are pairing.
						</p>
						{hub.data && !canLink && (
							<p className="ops-warn">This hub has no Tailscale name, so no link can be made here.</p>
						)}
						{hub.error && (
							<p className="hub-notice" data-tone="bad" role="alert">
								Could not read the pairing settings: {hub.error.message}
							</p>
						)}
					</>
				)}
				{link &&
					(expired ? (
						<p>This link expired; create a new one.</p>
					) : (
						<>
							<PairQr text={link.url} />
							<p className="hub-topic mono">{link.url}</p>
							<p className="micro">Expires in {countdown(link.expiresAt - now)}</p>
							<div className="ops-actions">
								<button type="button" className="btn" data-size="sm" onClick={() => copy(link.url)}>
									<Copy size={13} /> Copy link
								</button>
								{typeof navigator.share === "function" && (
									<button type="button" className="btn" data-size="sm" onClick={() => share(link.url)}>
										<Share2 size={13} /> Share…
									</button>
								)}
							</div>
							<p className="micro">
								Anyone who opens this link within 5 minutes is paired. Show it only to the device you are
								pairing.
							</p>
						</>
					))}
				<NoticeLine notice={notice} />
				{others.length > 0 && (
					<p className="ops-hint">
						<Link2 size={13} aria-hidden="true" /> One pairing covers {others.map(m => m.name).join(" and ")} too:
						they are managed from this dashboard. Pick one in the machine menu at the top.
					</p>
				)}
				<Help summary="Home Screen apps and the terminal">
					<p>
						On the tailnet page a link pairs a browser over Tailscale (for a year). On the 127.0.0.1 page it pairs
						another browser on this Mac (for a week). A link only works on the address it was made for.
					</p>
					<p>
						Home Screen apps keep their own cookies, so paste the link on their Pair screen. In a terminal,{" "}
						<code>serve.py --pair</code>, <code>--devices</code> and <code>--revoke</code> still work.
					</p>
				</Help>
			</div>
		</Modal>
	);
}
