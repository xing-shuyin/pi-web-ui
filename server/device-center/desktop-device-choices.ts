export type DesktopDeviceChoice = { id: string; name: string; remark?: string; online: boolean };
export function desktopDeviceChoices(value: unknown): DesktopDeviceChoice[] {
	if (!Array.isArray(value)) throw new Error("Device list unavailable");
	return value
		.slice(0, 2048)
		.filter(
			(item) =>
				item &&
				typeof item.id === "string" &&
				/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.id) &&
				typeof item.name === "string" &&
				typeof item.online === "boolean",
		)
		.map((item) => ({
			id: item.id,
			name: item.name.slice(0, 255),
			...(typeof item.remark === "string" ? { remark: item.remark.slice(0, 255) } : {}),
			online: item.online,
		}));
}
