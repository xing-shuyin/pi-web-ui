import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { NativeCliConfig, PromptAttachment, ServerMessage } from "./protocol.js";
import { isUploadDataTooLong, uploadLimitBytes, type UploadLimits } from "./payload-limits.js";
import { CLIENT_ID_PATTERN, saveUpload, uploadsRoot } from "./uploads.js";
import type { NativeCliDiscoveryOptions } from "./native-cli-discovery.js";
import { ENGINE_CATALOG, isNativeCliEngineId } from "./engine-catalog.js";
import { nativeCliModelLaunch, withClaudeSettingsEnv, type NativeCliModelConnection } from "./native-cli-model.js";
import { resolveCliExecutableLaunch, resolveEngineCliLaunch } from "./engine-cli.js";
import { isAbsoluteWirePath, wireToAbs } from "./files-service.js";

import {
	NATIVE_CLI_ENTRY,
	parseNativeCliMetadata,
	validateNativeCliConfig,
} from "../packages/keel/src/native-cli-meta.js";

/** 原生 CLI 元数据的校验与解析单源在 keel（`native-cli-meta.ts`）：这里只再导出一遍。 */
export { NATIVE_CLI_ENTRY, parseNativeCliMetadata, validateNativeCliConfig };

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

export function isDefaultNativeCliTitle(title: string, preset?: string, executable?: string): boolean {
	const trimmed = title.trim();
	if (!trimmed) return true;
	if (preset) {
		const presetLower = preset.toLowerCase();
		if (trimmed.toLowerCase() === `${presetLower} cli`) return true;
	}
	if (executable) {
		const exeName = basename(executable).toLowerCase();
		if (trimmed.toLowerCase() === exeName) return true;
	}
	return /^(agy|claude|pi|codex|dsh|custom)\s+cli$/i.test(trimmed);
}

export function readNativeCliConfig(manager: Pick<SessionManager, "getEntries">): NativeCliConfig | undefined {
	const entry = [...manager.getEntries()]
		.reverse()
		.find((item) => item.type === "custom" && item.customType === NATIVE_CLI_ENTRY);
	if (!entry || entry.type !== "custom") return undefined;
	return parseNativeCliMetadata(entry.data);
}

export function persistNativeCliConfig(manager: SessionManager, config: NativeCliConfig, title: string): void {
	manager.appendCustomEntry(NATIVE_CLI_ENTRY, { version: 1, config: validateNativeCliConfig(config) });
	manager.appendSessionInfo(title);
	const path = manager.getSessionFile();
	if (manager.isPersisted() && path && !existsSync(path)) {
		writeFileSync(
			path,
			[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			{ encoding: "utf8", flag: "wx" },
		);
		manager.setSessionFile(path);
	}
}
export const MAX_NATIVE_CLI_PASTE = 64 * 1024 - 12;

export function nativeCliLaunchArgs(config: NativeCliConfig): string[] {
	const args = config.args ?? [];
	if (!config.model || config.preset === "custom") return args;
	const flags = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
	const hasOption = (...names: string[]) =>
		flags.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
	const inherited: string[] = [];
	if (ENGINE_CATALOG[config.preset].cliModelArgs === "provider-model" && !hasOption("--provider")) {
		inherited.push("--provider", config.model.provider);
	}
	if (!hasOption("--model", "-m")) inherited.push("--model", config.model.id);
	return [...inherited, ...args];
}

export function resolveNativeCliLaunch(
	value: NativeCliConfig,
	options: Omit<NativeCliDiscoveryOptions, "autoDetect"> & { modelConnection?: NativeCliModelConnection } = {},
): { file: string; args: string[]; env?: NodeJS.ProcessEnv } {
	const config = validateNativeCliConfig(value);
	if (config.preset === "custom") return resolveCliExecutableLaunch(config.executable!, config.args, options);
	const inherited = nativeCliModelLaunch(config, options.modelConnection, options.env ?? process.env);
	// Without a resolved connection the CLI falls back to its own login: drop the inherited `--model`/
	// `--provider` too, otherwise a foreign model id (e.g. a DeepSeek id passed to Claude Code) breaks the
	// fallback launch. Pi only passes model arguments and needs no connection, so it is unaffected.
	const modelArgs =
		options.modelConnection || (config.preset !== "claude" && config.preset !== "codex")
			? nativeCliLaunchArgs(config)
			: [...(config.args ?? [])];
	const args = [...inherited.args, ...withClaudeSettingsEnv(modelArgs, inherited.settingsEnv)];
	const launch = resolveEngineCliLaunch(config.preset, {
		...options,
		executablePath: config.executable,
		args,
	});
	return { ...launch, ...(inherited.env ? { env: inherited.env } : {}) };
}

export interface NativeCliPasteContext {
	clientId: string;
	dataDir?: string;
	settings: UploadLimits;
	send: (message: ServerMessage) => void;
	materializeAttachments?: (
		attachments: PromptAttachment[],
		conversationId?: string,
		pasteText?: string,
	) => Promise<PromptAttachment[]>;
}

export function sanitizeNativeCliPaste(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function checkedString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.length > 4096 || CONTROL_CHARACTERS.test(value))
		throw new Error(`Invalid native CLI attachment ${label}`);
	return value;
}

function assertWithin(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Attachment is outside the allowed directory");
}

export interface FormatCliFileTargetOptions {
	isDirectory?: boolean;
	lines?: { start: number; end: number };
	isPosix?: boolean;
	forceAbsolute?: boolean;
}

export function formatCliFileTarget(absPath: string, cwd: string, options?: FormatCliFileTargetOptions): string {
	const p = options?.isPosix
		? posix
		: {
				relative: (from: string, to: string) => relative(from, to).replace(/\\/g, "/"),
				isAbsolute: (path: string) => isAbsolute(path),
			};
	const normalizedAbs = absPath.replace(/\\/g, "/");
	const normalizedCwd = cwd.replace(/\\/g, "/");

	const rel = options?.forceAbsolute ? "" : p.relative(normalizedCwd, normalizedAbs);
	const isInsideCwd = !options?.forceAbsolute && !rel.startsWith("..") && !p.isAbsolute(rel);

	let target: string;
	if (isInsideCwd) {
		target = rel || ".";
		if (options?.isDirectory && !target.endsWith("/")) {
			target += "/";
		}
	} else {
		target = normalizedAbs;
		if (options?.isDirectory && !target.endsWith("/")) {
			target += "/";
		}
	}

	if (options?.lines) {
		const { start, end } = options.lines;
		target += `:${start}${start !== end ? `-${end}` : ""}`;
	}

	if (/[\s"'`$*?~#&;|<>()\[\]{}]/.test(target)) {
		return `@"${target.replace(/"/g, '\\"')}"`;
	}
	return `@${target}`;
}

export function prepareNativeCliPaste(
	data: unknown,
	attachments: PromptAttachment[] | undefined,
	cwd: string,
	context: Pick<NativeCliPasteContext, "clientId" | "settings" | "dataDir">,
): string {
	if (typeof data !== "string" || data.length > MAX_NATIVE_CLI_PASTE)
		throw new Error("Native CLI prompt is too long or invalid");
	if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 32))
		throw new Error("Invalid native CLI attachments (max 32)");
	if (!CLIENT_ID_PATTERN.test(context.clientId)) throw new Error("Invalid upload client identity");
	const maxBytes = uploadLimitBytes(context.settings, "chat");
	let uploadBytes = 0;
	const parts: string[] = [];
	const dataText = sanitizeNativeCliPaste(data);
	if (dataText.trim()) parts.push(dataText);
	const refTokens: string[] = [];
	for (const att of attachments ?? []) {
		if (!att || typeof att !== "object") throw new Error("Invalid native CLI attachment");
		if (att.mode && !["reference", "inline", "lines", "quote"].includes(att.mode))
			throw new Error(`Native CLI does not support attachment mode: ${att.mode}`);
		if (att.mode === "quote") {
			if (typeof att.quote?.text !== "string" || att.quote.text.length > MAX_NATIVE_CLI_PASTE)
				throw new Error("Invalid native CLI text quote");
			if (refTokens.length > 0) {
				parts.push(refTokens.join(" "));
				refTokens.length = 0;
			}
			parts.push(`Quoted text:\n${sanitizeNativeCliPaste(att.quote.text)}`);
			continue;
		}
		const sources = [att.fileData, att.imageData, att.uploadPath].filter((source) => source !== undefined);
		if (sources.length > 1) throw new Error("Ambiguous native CLI attachment source");
		let abs: string;
		let pathKind = "File";
		if (att.fileData !== undefined || att.imageData !== undefined) {
			const rawData = att.fileData ?? att.imageData;
			if (typeof rawData !== "string") throw new Error("Invalid native CLI upload data");
			const raw = rawData.replace(/^data:[^;,]+;base64,/, "");
			if (isUploadDataTooLong(raw.length, maxBytes - uploadBytes))
				throw new Error("Native CLI uploads exceed the chat upload limit");
			if (raw.length % 4 === 1 || (raw.includes("=") && raw.length % 4 !== 0) || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw))
				throw new Error("Invalid native CLI upload base64");
			const buf = Buffer.from(raw, "base64");
			uploadBytes += buf.length;
			if (uploadBytes > maxBytes) throw new Error("Native CLI uploads exceed the chat upload limit");
			const name =
				att.name === undefined ? (att.imageData !== undefined ? "image.png" : "file") : checkedString(att.name, "name");
			abs = saveUpload(context.clientId, name, buf, context.dataDir).abs;
		} else if (att.uploadPath !== undefined) {
			const root = resolve(uploadsRoot(context.dataDir), context.clientId);
			abs = resolve(checkedString(att.uploadPath, "upload path"));
			assertWithin(root, abs);
			assertWithin(realpathSync(root), realpathSync(abs));
			if (!statSync(abs).isFile()) throw new Error("Uploaded attachment is not a file");
			uploadBytes += statSync(abs).size;
			if (uploadBytes > maxBytes) throw new Error("Native CLI uploads exceed the chat upload limit");
		} else {
			const reference = checkedString(att.path, "path");
			const absolute = isAbsoluteWirePath(reference);
			abs = realpathSync(absolute ? wireToAbs(reference) : resolve(cwd, reference));
			if (!absolute) assertWithin(realpathSync(cwd), abs);
			const stats = statSync(abs);
			if (!stats.isFile() && !stats.isDirectory()) throw new Error("Native CLI attachment is not a file or directory");
			if (stats.isDirectory()) pathKind = "Directory";
		}
		const lines = att.mode === "lines" ? att.lines : undefined;
		if (lines) {
			if (
				!Number.isSafeInteger(lines.start) ||
				!Number.isSafeInteger(lines.end) ||
				lines.start < 1 ||
				lines.end < lines.start
			)
				throw new Error("Invalid native CLI attachment line range");
		}
		const isUpload = att.fileData !== undefined || att.imageData !== undefined || att.uploadPath !== undefined;
		refTokens.push(
			formatCliFileTarget(abs, cwd, {
				isDirectory: pathKind === "Directory",
				lines,
				forceAbsolute: isUpload,
			}),
		);
	}
	if (refTokens.length > 0) {
		parts.push(refTokens.join(" "));
	}
	const text = parts.filter(Boolean).join("\n\n");
	if (!text.trim()) throw new Error("Native CLI prompt is empty");
	if (text.length > MAX_NATIVE_CLI_PASTE || Buffer.byteLength(text, "utf8") > MAX_NATIVE_CLI_PASTE)
		throw new Error("Native CLI prompt is too long");
	return text;
}
