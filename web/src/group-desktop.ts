import { deviceLabel } from "../../server/device-center/device-label";
import type { GroupDetail, GroupDevice } from "./device-group-messages";
import type { Device } from "./components/DeviceDirectory";

export type GroupDesktop = {
	id: string;
	name: string;
	online: boolean;
	members: GroupDevice[];
};

/** A group member is a Bot; only its explicit hosting device can supply a desktop. */
export function groupDesktops(detail: GroupDetail | null, devices: readonly Device[]): GroupDesktop[] {
	const targets = new Map<string, GroupDesktop>();
	for (const member of detail?.bots ?? []) {
		if (!detail?.room.botIds.includes(member.id) || !member.deviceId) continue;
		let target = targets.get(member.deviceId);
		if (!target) {
			const device = devices.find((item) => item.id === member.deviceId);
			target = {
				id: member.deviceId,
				name: deviceLabel(device?.name, device?.remark, member.deviceName || member.deviceId),
				online: device?.online === true,
				members: [],
			};
			targets.set(target.id, target);
		}
		target.members.push(member);
	}
	return [...targets.values()];
}
