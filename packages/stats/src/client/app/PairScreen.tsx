import { KeyRound } from "lucide-react";
import { useState } from "react";
import { takePairingError } from "../data/pairing";
import { Card, ErrorState } from "../ui";
import "../routes/hub.css";

/**
 * Shown instead of the dashboard while the hub answers 401: this browser has no pairing cookie yet.
 * Pairing needs a single-use link printed on the Mac; the page never shows or asks for a secret.
 */
export function PairScreen() {
	const [error] = useState(takePairingError);
	return (
		<main className="pair-screen">
			<Card
				title={
					<span className="row">
						<KeyRound size={15} /> Pair this browser
					</span>
				}
				description="This dashboard only answers browsers you paired with it."
			>
				{error && <ErrorState error={`Pairing failed: ${error}`} />}
				<ol className="pair-steps">
					<li>
						On the Mac, in a terminal (not inside an omp session, or the link lands in its transcript), run your
						hub's pair command.
					</li>
					<li>
						Open the link it prints in this browser, once, within 5 minutes. On the phone, AirDrop it or use
						Universal Clipboard.
					</li>
				</ol>
				<p className="micro">
					The link works once and expires after 5 minutes either way. This browser then keeps a private cookie for
					a year; the hub's own commands list paired browsers and unpair one.
				</p>
			</Card>
		</main>
	);
}
