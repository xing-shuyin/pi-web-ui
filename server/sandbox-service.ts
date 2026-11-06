import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as sandboxJailFs from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizePathKey } from "./client-state.js";
import { isConversationTool } from "./conversation-tool-names.js";
import { pick, type ServerLang } from "./i18n.js";
import type { SandboxInfo } from "./protocol.js";

export const SANDBOX_IGNORED_DIRS = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".parcel-cache",
	"target",
	".gradle",
	".cache",
	"coverage",
	".nyc_output",
]);

function toComparablePath(p: string): string {
	return normalizePathKey(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function isSameOrSubpath(childAbs: string, parentAbs: string): boolean {
	const c = toComparablePath(childAbs);
	const p = toComparablePath(parentAbs);
	return c === p || c.startsWith(p + "/");
}

export function isStrictlyInsideSandbox(targetPath: string, cwd: string, sandboxRoot: string): boolean {
	if (!targetPath || typeof targetPath !== "string") return false;
	const trimmed = targetPath.trim();
	if (!trimmed) return false;
	const expanded =
		trimmed === "~"
			? homedir()
			: trimmed.startsWith("~/") || trimmed.startsWith("~\\")
				? join(homedir(), trimmed.slice(2))
				: trimmed;
	const resolvedTarget = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	const resolvedSandbox = resolve(sandboxRoot);

	if (!isSameOrSubpath(resolvedTarget, resolvedSandbox)) {
		return false;
	}

	let realSandbox: string;
	try {
		if (sandboxJailFs.lstatSync(resolvedSandbox).isSymbolicLink()) return false;
		realSandbox = realpathSync(resolvedSandbox);
	} catch {
		return false;
	}

	let cur = resolvedTarget;
	while (true) {
		if (existsSync(cur)) {
			try {
				const realCur = realpathSync(cur);
				if (!isSameOrSubpath(realCur, realSandbox)) {
					return false;
				}
			} catch {
				return false;
			}
			break;
		}
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}

	return true;
}

export function extractPatchTargetPaths(patchText: string): string[] {
	if (!patchText || typeof patchText !== "string") return [];
	const paths: string[] = [];
	for (const rawLine of patchText.split(/\r?\n/)) {
		const line = rawLine.trim();
		const mHeader = line.match(/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s+(.+)$/);
		if (mHeader?.[1]) {
			paths.push(mHeader[1].trim());
			continue;
		}
		const mUnified = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\r\n]+)$/);
		if (mUnified?.[1] && mUnified[1] !== "/dev/null") {
			paths.push(mUnified[1].trim());
			continue;
		}
		const mHashline = rawLine.match(/^\s*\[([^#\]]+)(?:#[0-9a-fA-F]{4})?\]\s*$/);
		if (mHashline?.[1]?.trim()) {
			paths.push(mHashline[1].trim());
		}
	}
	return paths;
}

export interface SandboxDenial {
	reason: string;
	reasonEn: string;
}

export interface SandboxJailPolicy {
	trustedTool?: boolean;
	inheritedSandboxSubagent?: boolean;
}

const SANDBOX_MANAGEMENT_ACTIONS = new Set([
	"list",
	"create",
	"diff",
	"reset",
	"persist",
	"promote",
	"apply_to_source",
	"destroy",
]);

function sandboxJailPath(raw: unknown, cwd: string, root: string): boolean {
	if (
		typeof raw !== "string" ||
		!raw.trim() ||
		raw !== raw.trim() ||
		raw.startsWith("@") ||
		/[\x00-\x1f\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(raw)
	)
		return false;
	if (!isStrictlyInsideSandbox(raw, cwd, root)) return false;
	const target = resolve(cwd, raw);
	const sandboxRoot = resolve(root);
	const suffix = target.slice(sandboxRoot.length);
	if (suffix.includes(":")) return false;
	const safeEntry = (path: string): boolean => {
		const entry = sandboxJailFs.lstatSync(path);
		return !entry.isSymbolicLink() && (entry.isDirectory() || (entry.isFile() && entry.nlink === 1));
	};
	try {
		if (!sandboxJailFs.lstatSync(sandboxRoot).isDirectory() || sandboxJailFs.lstatSync(sandboxRoot).isSymbolicLink())
			return false;
		let current = sandboxRoot;
		for (const part of suffix.split(/[\\/]/).filter(Boolean)) {
			current = join(current, part);
			try {
				if (!safeEntry(current)) return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
				throw error;
			}
		}
		return true;
	} catch {
		return false;
	}
}

export function evaluateSandboxJail(
	sandbox: SandboxInfo,
	toolName: string,
	params: Record<string, unknown> | undefined,
	cwd: string,
	policy: SandboxJailPolicy = {},
): SandboxDenial | null {
	const deny = (detail: string): SandboxDenial => ({
		reason: "【沙盒安全隔离拦截】副本沙盒只允许可信宿主的受限文件工具与管理操作。" + detail,
		reasonEn:
			"[Sandbox Isolation Blocked] Copy sandboxes only allow trusted, bounded local file tools and management operations. " +
			detail,
	});
	if (!policy.trustedTool) return deny("Untrusted or unknown tool implementation: " + toolName);
	const p = params ?? {};
	if (toolName === "sandbox") {
		return typeof p.action === "string" && SANDBOX_MANAGEMENT_ACTIONS.has(p.action)
			? null
			: deny("Unknown sandbox management action.");
	}
	if (!sandboxJailPath(".", cwd, sandbox.path))
		return deny("Sandbox workspace is unavailable or outside its boundary.");
	if (toolName === "communicate") {
		return typeof p.action === "string" && ["read", "send", "request", "reply", "escalate"].includes(p.action)
			? null
			: deny("Unknown communication action.");
	}
	if (isConversationTool(toolName) && policy.inheritedSandboxSubagent) return null;
	if (toolName === "bash")
		return deny(
			"Host command execution (including scripts, eval and test/build commands) requires a secure OS-isolated backend; a workspace copy cannot isolate execution.",
		);
	const paths: unknown[] = [];
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "edit_soft":
			if (p.path !== undefined) paths.push(p.path);
			if (p.file_path !== undefined) paths.push(p.file_path);
			break;
		case "grep":
		case "find":
			return deny(
				"Search requires a verified safe backend without host execution or inherited executable configuration; trusted tool ownership alone is insufficient.",
			);
		case "patch": {
			if (typeof p.patch !== "string" || !p.patch.trim()) return deny("Missing patch targets.");
			paths.push(...extractPatchTargetPaths(p.patch));
			for (const line of p.patch.split(/\r?\n/)) {
				const move = line.trim().match(/^MV\s+([^\s]+)/i);
				if (move) paths.push(move[1]);
			}
			break;
		}
		case "present_files":
			if (!Array.isArray(p.items)) return deny("Missing local file items.");
			for (const item of p.items)
				paths.push(item && typeof item === "object" ? (item as Record<string, unknown>).path : undefined);
			break;
		default:
			return deny("Tool capability is not allowed in a copy sandbox: " + toolName);
	}
	if (!paths.length || paths.some((path) => !sandboxJailPath(path, cwd, sandbox.path))) {
		return deny(
			"Every file target must stay inside the sandbox; links, special files, invalid paths and unsafe recursive searches are refused.",
		);
	}
	return null;
}

export function withSandboxJailGate(
	tool: ToolDefinition,
	getSandbox: () => SandboxInfo | undefined,
	getCwd: () => string,
	getLang: () => ServerLang,
	policy: SandboxJailPolicy = {},
	acquireExecution?: () => () => void,
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			signal?.throwIfAborted();
			const sbx = getSandbox();
			if (sbx) {
				const denied = evaluateSandboxJail(
					sbx,
					tool.name,
					params as Record<string, unknown> | undefined,
					getCwd(),
					policy,
				);
				if (denied) {
					return {
						content: [{ type: "text", text: pick(getLang(), denied.reason, denied.reasonEn) }],
						details: { guardDenied: true, sandboxDenied: true, sandboxId: sbx.id },
						isError: true,
					} as never;
				}
			}
			const release = acquireExecution?.();
			try {
				signal?.throwIfAborted();
				return await tool.execute(toolCallId, params as never, signal, onUpdate, ctx);
			} finally {
				release?.();
			}
		},
	};
}

export { SandboxManager, type SandboxLifecycle } from "./sandbox-data.js";
