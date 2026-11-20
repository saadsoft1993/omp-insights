import { shortMachineName } from "./machine";

/**
 * A machine's display name that drops the owner's prefix on phones ("Ada MacBook" → "MacBook" at ≤600 px).
 * The full name stays in the tooltip and accessible text.
 */
export function MachineName({ name }: { name: string }) {
	const short = shortMachineName(name);
	const prefix = name.endsWith(short) ? name.slice(0, name.length - short.length) : "";
	if (!prefix) return <span className="machine-name">{name}</span>;
	return (
		<span className="machine-name" title={name}>
			<span className="machine-name-owner">{prefix}</span>
			{short}
		</span>
	);
}
