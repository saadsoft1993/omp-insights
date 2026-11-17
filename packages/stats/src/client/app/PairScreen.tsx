import { KeyRound, RotateCw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAutoPair, usePairingError } from "../data/pairing";
import { Card, ErrorState } from "../ui";
import "../routes/hub.css";

/**
 * Shown instead of the dashboard while the hub answers 401: this browser has no pairing cookie yet.
 * Pairing needs a single-use link printed on the Mac; the page never shows or asks for a secret.
 * When the hub auto-pairs (its 401 says `autoPair`), opening the app itself pairs the device, so the screen
 * asks for that and keeps the link steps as a fallback.
 */
/** The single-use token of a pasted pairing link (`…#pair=<token>`), or of a bare token. */
export function pairToken(text: string): string | null {
	const match = /(?:#pair=|^)([A-Za-z0-9_-]{16,})\s*$/.exec(text.trim());
	return match ? match[1] : null;
}

function PairSteps() {
	const [link, setLink] = useState("");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const token = pairToken(link);
		// index.tsx watches the fragment and trades the token for the cookie, like an opened link.
		if (token) window.location.hash = `pair=${token}`;
	};
	return (
		<>
			<ol className="pair-steps">
				<li>
					On the Mac, in a terminal (not inside an omp session, or the link lands in its transcript), run your
					hub's pair command:
					<pre className="mono">python3 omp_hub/serve.py --pair</pre>
					No terminal? On a browser that is already paired, open Devices and create a link (or scan its QR code).
				</li>
				<li>
					Open the link it prints in this browser, once, within 5 minutes. On the phone or iPad, AirDrop it or use
					Universal Clipboard.
				</li>
				<li>
					Installed to the Home Screen? That app keeps its own cookies, separate from Safari, so a link opened in
					Safari does not pair it. Paste the link here instead:
					<form className="pair-paste" onSubmit={submit}>
						<input
							className="input"
							value={link}
							onChange={event => setLink(event.target.value)}
							placeholder="https://…#pair=…"
							autoComplete="off"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
							aria-label="Pairing link"
						/>
						<button type="submit" className="btn" data-variant="accent" disabled={pairToken(link) === null}>
							Pair
						</button>
					</form>
				</li>
			</ol>
			<p className="micro">
				The link works once and expires after 5 minutes either way. This browser then keeps a private cookie for a
				year; the Devices page (or <code>serve.py --devices</code>) lists paired browsers and unpairs them.
			</p>
		</>
	);
}

export function PairScreen() {
	const autoPair = useAutoPair();
	const error = usePairingError();
	return (
		<main className="pair-screen">
			<Card
				title={
					<span className="row">
						<KeyRound size={15} /> Pair this browser
					</span>
				}
				description={
					autoPair
						? "This hub pairs your own devices when you open the app itself."
						: "This dashboard only answers browsers you paired with it."
				}
			>
				{error && <ErrorState error={`Pairing failed: ${error}`} />}
				{autoPair ? (
					<>
						<div className="pair-auto">
							<p>
								Open the app from its Home Screen icon or from the dashboard link, not from inside another page,
								then try again.
							</p>
							<button
								type="button"
								className="btn"
								data-variant="accent"
								onClick={() => window.location.reload()}
							>
								<RotateCw size={14} /> Try again
							</button>
						</div>
						<details className="pair-fallback">
							<summary>Pair with a link instead</summary>
							<PairSteps />
						</details>
					</>
				) : (
					<PairSteps />
				)}
			</Card>
		</main>
	);
}
