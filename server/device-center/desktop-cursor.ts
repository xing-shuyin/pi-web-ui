export type DesktopCursorMode = "local" | "remote";
export type DesktopCursorShape = { png: string; width: number; height: number; hotX: number; hotY: number };
export type DesktopCursor =
	| { type: "cursor"; kind: "local" | "embedded" | "hidden" }
	| { type: "cursor"; kind: "position"; x: number; y: number; shape?: DesktopCursorShape | null };

export function isCursorMode(mode: unknown): mode is DesktopCursorMode {
	return mode === "local" || mode === "remote";
}

/** Only bounded PNG cursor images and normalized coordinates can leave the capture helper. */
export function parseDesktopCursor(value: unknown): DesktopCursor | undefined {
	if (!value || typeof value !== "object") return;
	const c = value as Record<string, unknown>;
	if (c.type !== "cursor") return;
	if (c.kind === "local" || c.kind === "embedded" || c.kind === "hidden") return { type: "cursor", kind: c.kind };
	const normalized = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
	if (c.kind !== "position" || !normalized(c.x) || !normalized(c.y)) return;
	const position: DesktopCursor = { type: "cursor", kind: "position", x: c.x, y: c.y };
	if (c.shape === undefined) return position;
	if (c.shape === null) return { ...position, shape: null };
	const shape = c.shape as DesktopCursorShape;
	if (!shape || typeof shape.png !== "string" || shape.png.length > 44000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(shape.png))
		return;
	const png = Buffer.from(shape.png, "base64");
	if (
		png.length < 33 ||
		png.length > 32768 ||
		png.readBigUInt64BE() !== 0x89504e470d0a1a0an ||
		png.readUInt32BE(8) !== 13 ||
		png.toString("ascii", 12, 16) !== "IHDR"
	)
		return;
	const width = png.readUInt32BE(16),
		height = png.readUInt32BE(20);
	if (
		!width ||
		!height ||
		width > 128 ||
		height > 128 ||
		!Number.isInteger(shape.hotX) ||
		!Number.isInteger(shape.hotY) ||
		shape.hotX < 0 ||
		shape.hotY < 0 ||
		shape.hotX >= width ||
		shape.hotY >= height
	)
		return;
	return { ...position, shape: { png: shape.png, width, height, hotX: shape.hotX, hotY: shape.hotY } };
}
