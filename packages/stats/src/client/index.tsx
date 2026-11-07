import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { redeemPairingLink } from "./data/pairing";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// Registered before the app's own hash listener: a pairing link opened in a tab already showing the
// dashboard only changes the fragment.
window.addEventListener("hashchange", () => redeemPairingLink());
// A pairing link reloads the page once the hub has set its cookie; nothing renders until then.
if (!redeemPairingLink()) createRoot(root).render(<App />);
