import { mobileRequest, normalizeServerUrl, type MobileConnection } from "./connection";

export interface HubDevice {
	id: string;
	name: string;
	remark?: string;
	online: boolean;
}
export interface DeviceAccess {
	device: { id: string; name: string };
	serverUrl: string;
	token: string;
}

export async function loginHub(serverUrl: string, username: string, password: string): Promise<MobileConnection> {
	const connection = { serverUrl: normalizeServerUrl(serverUrl), token: "" };
	const result = await mobileRequest<{ token: string }>(connection, "/api/mobile-hub/login", {
		method: "POST",
		body: JSON.stringify({ username: username.trim(), password }),
	});
	if (typeof result.token !== "string" || !result.token || result.token.length > 4096) {
		throw new Error("设备中心未返回有效的登录凭据。");
	}
	return { ...connection, token: result.token };
}

export async function listHubDevices(connection: MobileConnection): Promise<HubDevice[]> {
	const result = await mobileRequest<{ devices: HubDevice[] }>(connection, "/api/mobile-hub/devices");
	if (!Array.isArray(result.devices) || result.devices.length > 10_000) throw new Error("设备列表格式不兼容。");
	return result.devices.filter(
		(device) =>
			device &&
			/^[a-z0-9][a-z0-9-]{0,62}$/.test(device.id) &&
			typeof device.name === "string" &&
			typeof device.online === "boolean",
	);
}

export function validateDeviceAccess(
	connection: MobileConnection,
	deviceId: string,
	access: DeviceAccess,
): DeviceAccess {
	const target = new URL(access.serverUrl);
	const hub = new URL(connection.serverUrl);
	const expectedPrefix = `/device/${encodeURIComponent(deviceId)}/__relay/`;
	const capability = target.pathname.slice(expectedPrefix.length).replace(/\/$/, "");
	if (
		access.device?.id !== deviceId ||
		access.token !== "" ||
		target.origin !== hub.origin ||
		target.username ||
		target.password ||
		target.search ||
		target.hash ||
		!target.pathname.startsWith(expectedPrefix) ||
		!/^[A-Za-z0-9_-]{24,256}$/.test(capability)
	)
		throw new Error("设备中心返回了无效的设备连接。");
	return { ...access, serverUrl: target.href.replace(/\/+$/, "") };
}

export async function accessHubDevice(connection: MobileConnection, deviceId: string): Promise<DeviceAccess> {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(deviceId)) throw new Error("无效的设备标识。");
	const access = await mobileRequest<DeviceAccess>(connection, `/api/mobile-hub/devices/${deviceId}/access`, {
		method: "POST",
	});
	return validateDeviceAccess(connection, deviceId, access);
}
