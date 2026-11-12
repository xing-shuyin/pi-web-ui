export type DesktopDisplay = { id: string; width: number; height: number; primary: boolean };
export type DesktopDisplays = {
	type: "displays";
	displays: DesktopDisplay[];
	selected: string;
	capture?: "dxgi" | "gdi" | "screencapturekit";
};
export function parseDesktopDisplays(value: unknown): DesktopDisplays | undefined {
	if (!value || typeof value !== "object") return;
	const v = value as DesktopDisplays;
	if (
		v.type !== "displays" ||
		!Array.isArray(v.displays) ||
		!v.displays.length ||
		v.displays.length > 32 ||
		typeof v.selected !== "string"
	)
		return;
	const ids = new Set<string>();
	for (const item of v.displays) {
		if (
			!item ||
			typeof item.id !== "string" ||
			!item.id.length ||
			item.id.length > 128 ||
			/[\x00-\x1f]/.test(item.id) ||
			ids.has(item.id) ||
			!Number.isInteger(item.width) ||
			item.width < 1 ||
			item.width > 32768 ||
			!Number.isInteger(item.height) ||
			item.height < 1 ||
			item.height > 32768 ||
			typeof item.primary !== "boolean"
		)
			return;
		ids.add(item.id);
	}
	if (!ids.has(v.selected)) return;
	return {
		type: "displays",
		displays: v.displays.map(({ id, width, height, primary }) => ({ id, width, height, primary })),
		selected: v.selected,
		...(["dxgi", "gdi", "screencapturekit"].includes(v.capture ?? "") ? { capture: v.capture } : {}),
	};
}
