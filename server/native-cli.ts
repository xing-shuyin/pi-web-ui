import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NativeCliConfig, PromptAttachment, ServerMessage } from "./protocol.js";
import { isUploadDataTooLong, uploadLimitBytes, type UploadLimits } from "./payload-limits.js";
import { CLIENT_ID_PATTERN, saveUpload, uploadsRoot } from "./uploads.js";
import type { NativeCliDiscoveryOptions } from "./native-cli-discovery.js";
import { ENGINE_CATALOG, isNativeCliEngineId } from "./engine-catalog.js";
import { nativeCliModelLaunch, type NativeCliModelConnection } from "./native-cli-model.js";
import { resolveCliExecutableLaunch, resolveEngineCliLaunch } from "./engine-cli.js";
import { isAbsoluteWirePath, wireToAbs } from "./files-service.js";

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
export const NATIVE_CLI_ENTRY = "webui/native-cli";

export function parseNativeCliMetadata(value: unknown): NativeCliConfig {
	const data = value as { version?: number; config?: unknown } | undefined;
	if (data?.version !== 1) throw new Error("Unsupported native CLI conversation metadata");
	return validateNativeCliConfig(data.config);
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

export function validateNativeCliConfig(value: unknown): NativeCliConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native CLI configuration");
	const config = value as Record<string, unknown>;
	if (Object.keys(config).some((key) => !["preset", "executable", "args", "model", "keepAlive"].includes(key)))
		throw new Error("Unknown native CLI configuration field");
	if (!isNativeCliEngineId(config.preset) && config.preset !== "custom") throw new Error("Invalid native CLI preset");
	if (
		config.executable !== undefined &&
		(typeof config.executable !== "string" ||
			!config.executable.trim() ||
			config.executable.length > 4096 ||
			CONTROL_CHARACTERS.test(config.executable))
	)
		throw new Error("Invalid native CLI executable (max 4096 characters, no control characters)");
	if (config.preset === "custom" && !config.executable) throw new Error("Custom native CLI requires an executable");
	if (config.keepAlive !== undefined && typeof config.keepAlive !== "boolean")
		throw new Error("Invalid native CLI keep-alive preference");
	if (
		config.args !== undefined &&
		(!Array.isArray(config.args) ||
			config.args.length > 128 ||
			config.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || CONTROL_CHARACTERS.test(arg)))
	)
		throw new Error("Invalid native CLI arguments (max 128 arguments, 4096 characters each, no control characters)");
	let model: NativeCliConfig["model"];
	if (config.model !== undefined) {
		const selected = config.model as Record<string, unknown> | null;
		if (
			!selected ||
			typeof selected !== "object" ||
			Array.isArray(selected) ||
			Object.keys(selected).some((key) => key !== "provider" && key !== "id") ||
			[selected.provider, selected.id].some(
				(part) => typeof part !== "string" || !part.trim() || part.length > 4096 || CONTROL_CHARACTERS.test(part),
			) ||
			config.preset === "custom" ||
			!ENGINE_CATALOG[config.preset].cliModelArgs
		)
			throw new Error("Invalid native CLI model");
		model = { provider: selected.provider as string, id: selected.id as string };
	}
	const args = config.args as string[] | undefined;
	if (config.preset !== "custom") {
		const engine = ENGINE_CATALOG[config.preset];
		if (!engine.cliCommand) throw new Error(`${engine.name} has no standalone CLI`);
		if (engine.cliRequiresArgs && !args?.[0]?.trim())
			throw new Error(`${engine.name} CLI requires a configured terminal profile and its arguments`);
	}
	if (args && args.reduce((size, arg) => size + arg.length + 1, 0) > 32768)
		throw new Error("Native CLI arguments are too long");
	return {
		preset: config.preset,
		...(config.executable !== undefined ? { executable: config.executable as string } : {}),
		...(args !== undefined ? { args: [...args] } : {}),
		...(config.keepAlive !== undefined ? { keepAlive: config.keepAlive as boolean } : {}),
		...(model ? { model } : {}),
	};
}

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
	const launch = resolveEngineCliLaunch(config.preset, {
		...options,
		executablePath: config.executable,
		args: [...inherited.args, ...nativeCliLaunchArgs(config)],
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
	const parts = [sanitizeNativeCliPaste(data)];
	for (const att of attachments ?? []) {
		if (!att || typeof att !== "object") throw new Error("Invalid native CLI attachment");
		if (att.mode && !["reference", "inline", "lines", "quote"].includes(att.mode))
			throw new Error(`Native CLI does not support attachment mode: ${att.mode}`);
		if (att.mode === "quote") {
			if (typeof att.quote?.text !== "string" || att.quote.text.length > MAX_NATIVE_CLI_PASTE)
				throw new Error("Invalid native CLI text quote");
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
		let location = JSON.stringify(abs);
		if (att.mode === "lines") {
			if (
				!Number.isSafeInteger(att.lines?.start) ||
				!Number.isSafeInteger(att.lines?.end) ||
				att.lines!.start < 1 ||
				att.lines!.end < att.lines!.start
			)
				throw new Error("Invalid native CLI attachment line range");
			location += ` (lines ${att.lines!.start}-${att.lines!.end})`;
		}
		parts.push(`${pathKind} path: ${location}`);
	}
	const text = parts.filter(Boolean).join("\n\n");
	if (!text.trim()) throw new Error("Native CLI prompt is empty");
	if (text.length > MAX_NATIVE_CLI_PASTE || Buffer.byteLength(text, "utf8") > MAX_NATIVE_CLI_PASTE)
		throw new Error("Native CLI prompt is too long");
	return text;
}
