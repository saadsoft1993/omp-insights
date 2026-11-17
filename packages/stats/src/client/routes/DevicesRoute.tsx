import { Copy, Link2, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import {
	createHubPairLink,
	getHubDevices,
	type HubDevice,
	type HubPairLink,
	revokeHubAutoDevices,
	revokeHubDevice,
	revokeOtherHubDevices,
} from "../data/hub";
import { useQuery } from "../data/query";
import { Badge, Card, type Column, EmptyState, Modal, PageHeader, QueryView, Table, TableSkeleton } from "../ui";
import { ago, Help, type Notice, NoticeLine } from "./hub-common";

export interface DevicesRouteProps {
	active: boolean;
}

type Confirm = { kind: "one"; device: HubDevice } | { kind: "auto" } | { kind: "others" } | null;

const AUTO_PAIR_WARNING =
	"Auto-pair is on: any of your Tailscale devices that opens the app again is paired again, this one included. To lock a device out, remove it from your Tailscale network.";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function countdown(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
	const devices = useQuery(["hub-devices"], ({ signal }) => getHubDevices(signal), {
		enabled: active,
		pollMs: 30_000,
	});
	const [notice, setNotice] = useState<Notice | null>(null);
	const [linkNotice, setLinkNotice] = useState<Notice | null>(null);
	const [link, setLink] = useState<HubPairLink | null>(null);
	const [creating, setCreating] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const [confirm, setConfirm] = useState<Confirm>(null);
	const [busy, setBusy] = useState(false);

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
		setLinkNotice(null);
		try {
			setLink(await createHubPairLink());
		} catch (error) {
			setLinkNotice({ tone: "bad", text: `Could not create a link: ${errorText(error)}` });
		} finally {
			setCreating(false);
		}
	};

	const copy = async (url: string) => {
		try {
			await navigator.clipboard.writeText(url);
			setLinkNotice({ tone: "ok", text: "Link copied." });
		} catch {
			setLinkNotice({ tone: "bad", text: "Could not copy here; select the link above and copy it by hand." });
		}
	};

	const share = async (url: string) => {
		try {
			await navigator.share({ url });
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") return;
			setLinkNotice({ tone: "bad", text: `Could not share: ${errorText(error)}` });
		}
	};

	const done = () => {
		setLink(null);
		setLinkNotice(null);
	};

	const run = async () => {
		if (!confirm) return;
		setBusy(true);
		try {
			const result =
				confirm.kind === "one"
					? await revokeHubDevice(confirm.device.id)
					: confirm.kind === "auto"
						? await revokeHubAutoDevices()
						: await revokeOtherHubDevices();
			setConfirm(null);
			setNotice({
				tone: "ok",
				text: `Unpaired ${result.revoked} ${result.revoked === 1 ? "browser" : "browsers"}.`,
			});
			if ("self" in result && result.self) window.location.reload();
		} catch (error) {
			setConfirm(null);
			setNotice({ tone: "bad", text: `Could not unpair: ${errorText(error)}` });
		} finally {
			setBusy(false);
			devices.refetch();
		}
	};

	const columns: Column<HubDevice>[] = [
		{
			key: "browser",
			header: "Browser",
			wrap: true,
			render: d => (
				<>
					{d.label}
					{d.current && (
						<>
							{" "}
							<Badge tone="accent">this browser</Badge>
						</>
					)}
				</>
			),
		},
		{
			key: "where",
			header: "Where",
			render: d => <Badge>{d.scope === "tailnet" ? "tailnet" : "this Mac"}</Badge>,
		},
		{ key: "paired", header: "Paired", sort: d => d.pairedAt, render: d => ago(d.pairedAt) },
		{ key: "how", header: "How", render: d => (d.auto ? <Badge tone="warn">auto</Badge> : "link") },
		{
			key: "expires",
			header: "Expires",
			render: d => (d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : "never"),
		},
		{
			key: "actions",
			header: "",
			align: "right",
			render: d => (
				<button
					type="button"
					className="btn"
					data-variant="danger"
					data-size="sm"
					onClick={() => setConfirm({ kind: "one", device: d })}
				>
					Unpair
				</button>
			),
		},
	];

	const list = devices.data?.devices ?? [];
	const autoCount = list.filter(d => d.auto).length;
	const autoPair = devices.data?.autoPair ?? false;
	const touchesTailnet = confirm !== null && (confirm.kind !== "one" || confirm.device.scope === "tailnet");
	const expired = link !== null && now >= link.expiresAt;
	const scope = devices.data?.scope ?? "tailnet";
	const canLink = devices.data?.canLink ?? false;

	return (
		<div className="page">
			<PageHeader
				title="Devices"
				description="Browsers paired with this hub. Pair a new one with a single-use link, or unpair one."
			/>
			<Help summary="How does pairing work?">
				<p>
					A pairing link works once and expires after 5 minutes. Whoever opens it first is paired, so show it only
					to the device you are pairing.
				</p>
				<p>
					On the tailnet page a link pairs a browser over Tailscale (for a year). On the 127.0.0.1 page it pairs
					another browser on this Mac (for a week). A link only works on the address it was made for.
				</p>
				<p>
					Home Screen apps keep their own cookies, so paste the link on their Pair screen. In a terminal,{" "}
					<code>serve.py --pair</code>, <code>--devices</code> and <code>--revoke</code> still work.
				</p>
			</Help>
			<QueryView query={devices} skeleton={<TableSkeleton rows={3} />}>
				{() => (
					<>
						<Card title="Pair a new browser">
							<div className="hub-actions">
								<button
									type="button"
									className="btn"
									data-variant="accent"
									disabled={!canLink || creating}
									title={canLink ? undefined : "Tailscale is not running on the Mac"}
									onClick={create}
								>
									<Link2 size={14} /> {scope === "local" ? "Create link for this Mac" : "Create pairing link"}
								</button>
							</div>
							{link && (
								<>
									{expired ? (
										<p>This link expired; create a new one.</p>
									) : (
										<>
											<PairQr text={link.url} />
											<p className="hub-topic mono">{link.url}</p>
											<p className="micro">Expires in {countdown(link.expiresAt - now)}</p>
											<div className="hub-actions">
												<button type="button" className="btn" onClick={() => copy(link.url)}>
													<Copy size={14} /> Copy link
												</button>
												{typeof navigator.share === "function" && (
													<button type="button" className="btn" onClick={() => share(link.url)}>
														<Share2 size={14} /> Share…
													</button>
												)}
											</div>
										</>
									)}
									<p className="micro">
										Anyone who opens this link within 5 minutes is paired. Show it only to the device you are
										pairing.
									</p>
									<div className="hub-actions">
										<button type="button" className="btn" onClick={done}>
											Done
										</button>
									</div>
								</>
							)}
							<NoticeLine notice={linkNotice} />
						</Card>
						<Card title="Paired browsers">
							<div className="hub-actions">
								<button
									type="button"
									className="btn"
									disabled={autoCount === 0}
									onClick={() => setConfirm({ kind: "auto" })}
								>
									Unpair all auto-paired ({autoCount})
								</button>
								<button
									type="button"
									className="btn"
									disabled={list.length <= 1}
									onClick={() => setConfirm({ kind: "others" })}
								>
									Unpair every other browser
								</button>
							</div>
							<NoticeLine notice={notice} />
							<Table
								columns={columns}
								rows={list}
								rowKey={d => `${d.scope}:${d.id}`}
								initialSort={{ key: "paired", dir: "desc" }}
								empty={<EmptyState title="No paired browsers" />}
							/>
						</Card>
					</>
				)}
			</QueryView>
			<Modal
				open={confirm !== null}
				title={
					confirm?.kind === "one"
						? "Unpair this browser?"
						: confirm?.kind === "auto"
							? "Unpair all auto-paired browsers?"
							: "Unpair every other browser?"
				}
				onClose={() => (busy ? undefined : setConfirm(null))}
				primaryAction={{ label: busy ? "Unpairing…" : "Unpair", onClick: run, disabled: busy }}
			>
				{confirm?.kind === "one" && (
					<>
						<p>
							{confirm.device.label} ({confirm.device.scope === "tailnet" ? "tailnet" : "this Mac"}) loses
							access.
						</p>
						{confirm.device.current && <p>This is the browser you are using: it goes back to the Pair screen.</p>}
					</>
				)}
				{confirm?.kind === "auto" && (
					<p>
						{autoCount} {autoCount === 1 ? "browser" : "browsers"} paired automatically through Tailscale lose
						access.
					</p>
				)}
				{confirm?.kind === "others" && <p>Only this browser stays paired. Every other device must pair again.</p>}
				{autoPair && touchesTailnet && <p>{AUTO_PAIR_WARNING}</p>}
			</Modal>
		</div>
	);
}
