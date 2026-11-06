import type { CanvasMessage } from "../protocol.js";

/** Pure wire validator, also used by the browser for imported or historical graphs. */
export function isCanvasMessage(value: unknown): value is CanvasMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { key, vars } = value as Record<string, unknown>;
	return (
		typeof key === "string" &&
		key.length > 0 &&
		(vars === undefined ||
			(vars !== null &&
				typeof vars === "object" &&
				!Array.isArray(vars) &&
				Object.values(vars).every(
					(entry) => typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry)),
				)))
	);
}

/** UI-only metadata. Legacy strings remain the execution and persistence fallback. */
export function canvasRuntimeMessage(key: string, vars?: CanvasMessage["vars"]): CanvasMessage {
	return { key: `canvas.runtime.${key}`, ...(vars ? { vars } : {}) };
}

/** Keep the original Error.message for existing callers and AI/tool results. */
export class CanvasRuntimeError extends Error {
	readonly canvasMessage: CanvasMessage;

	constructor(text: string, key: string, vars?: CanvasMessage["vars"], options?: ErrorOptions) {
		super(text, options);
		this.name = "Error";
		this.canvasMessage = canvasRuntimeMessage(key, vars);
	}
}

/** External errors and model output are intentionally left as original text. */
export function canvasErrorMessage(error: unknown): CanvasMessage | undefined {
	return error instanceof CanvasRuntimeError ? error.canvasMessage : undefined;
}
