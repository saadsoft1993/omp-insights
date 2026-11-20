import { hubFetch, hubPost, type HubDevice, type HubDevices } from "./hub";

export interface FleetDevice extends HubDevice {
	source: string | null;
	originDevice: string | null;
}

export interface FleetDevices extends Omit<HubDevices, "devices"> {
	devices: FleetDevice[];
}

export function getMachineDevices(machine: string | undefined, signal?: AbortSignal): Promise<FleetDevices> {
	return hubFetch("devices", { signal }, machine);
}

export function revokeMachineDevice(
	machine: string | undefined,
	id: string,
): Promise<{ revoked: number; self: boolean }> {
	return hubPost("devices/revoke", { id }, machine);
}

export function revokeFleetLinks(machine: string, originDevice?: string): Promise<{ revoked: number; self: boolean }> {
	return hubPost("devices/revoke", originDevice === undefined ? { fleetLinks: true } : { originDevice }, machine);
}
