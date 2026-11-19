export type DesktopDisplay = { id: string; width: number; height: number; primary: boolean; refreshHz?: number };
export type DesktopDisplays = {
	type: "displays";
	displays: DesktopDisplay[];
	selected: string;
	capture?: "dxgi" | "wgc" | "gdi" | "screencapturekit";
	encoder?: "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf" | "libx264";
	encoderRuntime?: "default" | "nvenc-12.1" | "desktop-timing-v2" | "rustdesk-hwcodec" | "native-d3d11";
	fallback?: string;
	maxEdge?: number;
	colorRange?: "limited" | "full";
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
		...([2560, 4096].includes(v.maxEdge ?? 0) ? { maxEdge: v.maxEdge } : {}),
		...(v.encoderRuntime === "native-d3d11" && ["limited", "full"].includes(v.colorRange ?? "")
			? { colorRange: v.colorRange }
			: {}),
		displays: v.displays.map(({ id, width, height, primary, refreshHz }) => ({
			id,
			width,
			height,
			primary,
			...(typeof refreshHz === "number" && Number.isFinite(refreshHz) && refreshHz >= 5 && refreshHz <= 1000
				? { refreshHz }
				: {}),
		})),
		selected: v.selected,
		...(["dxgi", "wgc", "gdi", "screencapturekit"].includes(v.capture ?? "") ? { capture: v.capture } : {}),
		...(["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"].includes(v.encoder ?? "")
			? { encoder: v.encoder }
			: {}),
		...(["default", "nvenc-12.1", "desktop-timing-v2", "rustdesk-hwcodec", "native-d3d11"].includes(
			v.encoderRuntime ?? "",
		)
			? { encoderRuntime: v.encoderRuntime }
			: {}),
		...(typeof v.fallback === "string" && v.fallback.length <= 1024 ? { fallback: v.fallback } : {}),
	};
}
