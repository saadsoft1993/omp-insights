import { useState } from "react";
import { runHubJob } from "../../data/hub";
import { Modal } from "../../ui";
import { jobActionError } from "../JobsRoute";
import { useOpsMachines } from "../ops-common";
import { SMS_SYNC_JOB, smsSyncRequest } from "./smsModel";

const UNIT = SMS_SYNC_JOB;
export function ConfirmRunModal({
	open,
	onClose,
	onAccepted,
}: {
	open: boolean;
	onClose: () => void;
	onAccepted: () => void;
}) {
	const { everyMachine } = useOpsMachines();
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const close = () => {
		if (!busy) {
			setTyped("");
			setError("");
			onClose();
		}
	};
	const perform = async () => {
		const local = everyMachine.find(m => m.self);
		if (!local) {
			setError("Local machine is unavailable.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const request = smsSyncRequest();
			await runHubJob(local.id, "run", request.label, request.confirm, request.confirmImpact);
			setTyped("");
			onClose();
			onAccepted();
		} catch (e) {
			setError(jobActionError(e, local.name));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal
			open={open}
			title={`Run ${UNIT} now?`}
			onClose={close}
			primaryAction={{ label: busy ? "Working…" : "Run now", onClick: perform, disabled: busy || typed !== UNIT }}
		>
			<p>The job starts now, outside its schedule.</p>
			<label className="ops-field">
				<span>
					Type <code>{UNIT}</code> to confirm
				</span>
				<input
					className="input"
					value={typed}
					onChange={e => setTyped(e.target.value)}
					autoComplete="off"
					spellCheck={false}
					aria-label="Job name"
				/>
			</label>
			{error && <p role="alert">{error}</p>}
		</Modal>
	);
}
