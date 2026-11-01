import type { DeviceTaskActivity, DeviceTaskProgress } from "../protocol.js";

/**
 * Filter out thought/reasoning fragments.
 * Drops open or closed thought blocks entirely. If an open tag exists without closure,
 * the trailing fragment is discarded to prevent streaming leaks.
 */
export function sanitizeTextForJournal(input: string): string {
	if (!input) return "";
	let text = input;
	// Drop closed thought tags
	text = text.replace(/<thought[\s\S]*?<\/thought>/gi, "");
	text = text.replace(/<thinking[\s\S]*?<\/thinking>/gi, "");
	// Drop unclosed trailing thought tags (streaming fragment)
	text = text.replace(/<(thought|thinking)[\s\S]*$/gi, "");
	// Drop credential/token patterns (best-effort defense in depth)
	text = text.replace(
		/((?:bearer|token|key|secret|password|passwd|credential|auth|api[-_]?key)[\s:="']{1,4})([A-Za-z0-9_\-./+=]{8,})/gi,
		"$1[REDACTED]",
	);
	text = text.replace(
		/-----BEGIN[A-Z0-9\s_-]+PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9\s_-]+PRIVATE KEY-----/gi,
		"[REDACTED PRIVATE KEY]",
	);
	return text.trim();
}

export interface SanitizedToolLifecycle {
	toolName: string;
	phase: "start" | "progress" | "end" | "failed";
	callId?: string;
	summary?: string;
	parametersPreview?: Record<string, unknown>;
	outputSnippet?: string;
	durationMs?: number;
}

/**
 * Sanitize tool parameters into safe structural summaries.
 * Never outputs raw commands, raw file contents, or raw sensitive file paths.
 */
export function sanitizeToolParameters(toolName: string, params: unknown): Record<string, unknown> | undefined {
	if (!params || typeof params !== "object" || Array.isArray(params)) return;
	const input = params as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	if (toolName === "bash" || toolName === "terminal") {
		if (typeof input.command === "string") {
			result.commandLength = input.command.length;
			result.action = "run_shell_command";
		}
		if (typeof input.timeout === "number") result.timeout = input.timeout;
	} else if (toolName === "read") {
		if (typeof input.path === "string") {
			const ext = input.path.split(".").pop();
			result.fileType = ext ? `.${ext.slice(0, 8)}` : "file";
			result.action = "read_file";
		}
	} else if (toolName === "write" || toolName === "edit" || toolName === "edit_soft") {
		if (typeof input.path === "string") {
			const ext = input.path.split(".").pop();
			result.fileType = ext ? `.${ext.slice(0, 8)}` : "file";
			result.action = toolName === "write" ? "write_file" : "edit_file";
		}
		if (typeof input.content === "string") {
			result.contentBytes = Buffer.byteLength(input.content, "utf8");
		}
		if (Array.isArray(input.edits)) {
			result.editCount = input.edits.length;
		}
	} else {
		// Generic tool summary: count parameters without exposing unknown values
		result.parameterCount = Object.keys(input).length;
		result.action = `invoke_${toolName}`;
	}
	return result;
}

export function summarizeToolOutput(toolName: string, output: string, isError = false): string {
	const byteLen = Buffer.byteLength(output, "utf8");
	if (isError) {
		return `[${toolName} failed: ${byteLen} bytes error output]`;
	}
	if (toolName === "read") {
		return `[read completed: ${byteLen} bytes read]`;
	}
	if (toolName === "write" || toolName === "edit" || toolName === "edit_soft") {
		return `[${toolName} completed: ${byteLen} bytes written]`;
	}
	if (toolName === "bash" || toolName === "terminal") {
		return `[${toolName} completed: ${byteLen} bytes output]`;
	}
	return `[${toolName} completed: ${byteLen} bytes output]`;
}

/** Project tool lifecycle with strict parameter and credential redaction. */
export function projectToolLifecycle(value: unknown): SanitizedToolLifecycle | undefined {
	if (!value || typeof value !== "object") return;
	const val = value as any;
	if (typeof val.toolName !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(val.toolName)) return;
	const phase = ["start", "progress", "end", "failed"].includes(val.phase) ? val.phase : "progress";
	const lifecycle: SanitizedToolLifecycle = {
		toolName: val.toolName,
		phase,
	};
	if (typeof val.callId === "string" && val.callId.length <= 64) lifecycle.callId = val.callId;
	if (typeof val.summary === "string") {
		lifecycle.summary = sanitizeTextForJournal(val.summary).slice(0, 256);
	}
	if (val.parameters) {
		const safeParams = sanitizeToolParameters(val.toolName, val.parameters);
		if (safeParams && Object.keys(safeParams).length > 0) lifecycle.parametersPreview = safeParams;
	}
	if (typeof val.output === "string") {
		// Never leak raw read/bash/write outputs or environment secrets; emit safe structural summary
		lifecycle.outputSnippet = summarizeToolOutput(val.toolName, val.output, phase === "failed");
	}
	if (typeof val.durationMs === "number" && Number.isFinite(val.durationMs) && val.durationMs >= 0) {
		lifecycle.durationMs = Math.round(val.durationMs);
	}
	return lifecycle;
}

/** Project explicitly allowed fields; never spread tool arguments or approval payloads. */
export function projectTaskActivity(value: unknown): DeviceTaskActivity | undefined {
	if (!value || typeof value !== "object") return;
	const input = value as DeviceTaskActivity;
	if (!["model", "tool", "waiting"].includes(input.phase)) return;
	let safeText: string | undefined;
	if (typeof input.text === "string") {
		const sanitized = sanitizeTextForJournal(input.text);
		safeText = Buffer.from(sanitized)
			.subarray(0, 2048)
			.toString("utf8")
			.replace(/\uFFFD$/u, "");
	}
	return {
		phase: input.phase,
		...(safeText !== undefined ? { text: safeText } : {}),
		...(typeof input.toolName === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(input.toolName)
			? { toolName: input.toolName }
			: {}),
	};
}

export function validTaskProgress(value: any): value is DeviceTaskProgress {
	return (
		!!projectTaskActivity(value) &&
		[value.taskId, value.botId, value.attemptId].every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 128,
		) &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence > 0 &&
		(value.text === undefined || (typeof value.text === "string" && Buffer.byteLength(value.text) <= 2048)) &&
		(value.toolName === undefined || /^[A-Za-z0-9_.:-]{1,80}$/.test(value.toolName))
	);
}
