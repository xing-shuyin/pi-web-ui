import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeAtomicSync } from "./atomic-file.js";
import type { McpScope, UiMcpServer, UiMcpToolInfo } from "./protocol.js";
import {
	getGlobalMcpPath,
	getProjectMcpPath,
	parseMcpConfig,
	type McpBridge,
	type McpServerSpec,
} from "./mcp-bridge.js";

export { getGlobalMcpPath, getProjectMcpPath };

export function readMcpConfigFile(filePath: string): {
	servers: Record<string, McpServerSpec>;
	raw: Record<string, unknown> | null;
	legacy: boolean;
	exists: boolean;
	error?: string;
} {
	try {
		const raw = readWritableConfig(filePath);
		if (!raw) return { servers: {}, raw: null, legacy: false, exists: false };
		const legacy = raw.servers !== undefined && raw.mcpServers === undefined;
		return { servers: parseMcpConfig(JSON.stringify(raw))?.servers ?? {}, raw, legacy, exists: true };
	} catch (error) {
		return {
			servers: {},
			raw: null,
			legacy: false,
			exists: true,
			error: `MCP 配置 ${filePath}: ${mutationError(error).error}`,
		};
	}
}

function readWritableConfig(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isRecord(raw)) throw new Error("MCP 配置必须是 JSON 对象");
		for (const key of ["servers", "mcpServers"]) {
			if (raw[key] !== undefined && (!isRecord(raw[key]) || Object.values(raw[key]).some((v) => !isRecord(v)))) {
				throw new Error(`MCP 配置 ${key} 格式无效`);
			}
		}
		if (raw.servers !== undefined && raw.mcpServers !== undefined)
			throw new Error("MCP 配置包含两份服务器清单，禁止覆盖");
		return raw;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function writeMcpConfigFile(
	filePath: string,
	servers: Record<string, McpServerSpec>,
	preferLegacy = false,
): void {
	const raw = readWritableConfig(filePath) ?? {};

	const legacy = raw.servers !== undefined && raw.mcpServers === undefined ? true : preferLegacy;
	const next = { ...raw };
	if (legacy) {
		delete next.mcpServers;
		next.servers = servers;
	} else {
		delete next.servers;
		next.mcpServers = servers;
	}

	atomicWrite(filePath, next);
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function atomicWrite(filePath: string, value: unknown): void {
	writeAtomicSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, fsync: true });
}

function editableConfig(filePath: string) {
	const cfg = readMcpConfigFile(filePath);
	if (cfg.error) throw new Error(cfg.error);
	return {
		...cfg,
		servers: { ...(cfg.raw?.[cfg.legacy ? "servers" : "mcpServers"] as Record<string, McpServerSpec> | undefined) },
	};
}

function mutationError(error: unknown): { ok: false; error: string } {
	return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function isValidMcpServerName(name: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(name.trim());
}

export function listAllMcpServers(opts: { agentDir?: string; cwd?: string; dataDir?: string; bridge?: McpBridge }): {
	servers: UiMcpServer[];
	globalPath: string;
	projectPath: string;
} {
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);

	const globalCfg = readMcpConfigFile(globalPath);
	const projectCfg = readMcpConfigFile(projectPath);

	const result: UiMcpServer[] = [];
	for (const [scope, path, cfg] of [
		["global", globalPath, globalCfg],
		["project", projectPath, projectCfg],
	] as const) {
		if (cfg.error) result.push({ name: path, scope, enabled: false, status: "error", error: cfg.error });
	}

	for (const [name, spec] of Object.entries(globalCfg.servers)) {
		const overridden = Object.hasOwn(projectCfg.servers, name);
		const status = getRuntimeStatus(name, spec, overridden ? undefined : opts.bridge);
		result.push({
			name,
			scope: "global",
			...(overridden ? { overriddenBy: "project" as const } : {}),
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			url: spec.url,
			headers: spec.headers,
			type: spec.type,
			timeout: spec.timeout,
			protocolVersion: spec.protocolVersion,
			enabled: spec.enabled !== false,
			description: spec.description,
			...status,
		});
	}

	for (const [name, spec] of Object.entries(projectCfg.servers)) {
		const status = getRuntimeStatus(name, spec, opts.bridge);
		result.push({
			name,
			scope: "project",
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			url: spec.url,
			headers: spec.headers,
			type: spec.type,
			timeout: spec.timeout,
			protocolVersion: spec.protocolVersion,
			enabled: spec.enabled !== false,
			description: spec.description,
			...status,
		});
	}

	return { servers: result, globalPath, projectPath };
}

function getRuntimeStatus(
	name: string,
	spec: McpServerSpec,
	bridge?: McpBridge,
): { status: "running" | "stopped" | "error"; error?: string; tools: UiMcpToolInfo[]; usingPreviousConfig?: boolean } {
	if (spec.enabled === false) {
		return { status: "stopped", tools: [] };
	}
	if (!bridge) {
		return { status: "stopped", tools: [] };
	}
	return bridge.getServerStatus(name);
}

export function saveMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	server: UiMcpServer;
	prevName?: string;
	prevScope?: McpScope;
}): { ok: boolean; error?: string } {
	const name = opts.server.name.trim();
	if (!isValidMcpServerName(name)) {
		return { ok: false, error: "服务器名称仅允许包含英文字母、数字、下划线及中划线" };
	}

	const targetScope = opts.server.scope;
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = targetScope === "global" ? globalPath : projectPath;

	try {
		const targetCfg = editableConfig(targetPath);
		const spec: McpServerSpec = {
			command: opts.server.command?.trim() || undefined,
			args: Array.isArray(opts.server.args) && opts.server.args.length > 0 ? opts.server.args.map(String) : undefined,
			cwd: opts.server.cwd?.trim() || undefined,
			env:
				opts.server.env && Object.keys(opts.server.env).length > 0
					? (opts.server.env as Record<string, string>)
					: undefined,
			url: opts.server.url?.trim() || undefined,
			headers:
				opts.server.headers && Object.keys(opts.server.headers).length > 0
					? (opts.server.headers as Record<string, string>)
					: undefined,
			type: opts.server.type,
			timeout: typeof opts.server.timeout === "number" ? opts.server.timeout : undefined,
			protocolVersion: opts.server.protocolVersion?.trim() || undefined,
			enabled: opts.server.enabled !== false,
			description: opts.server.description?.trim() || undefined,
		};

		const prevName = opts.prevName?.trim();
		const oldPath = opts.prevScope === "global" ? globalPath : projectPath;
		const moving = prevName && opts.prevScope && (prevName !== name || resolve(oldPath) !== resolve(targetPath));
		if (moving) {
			if (resolve(oldPath) !== resolve(targetPath)) return migrateMcpServer(oldPath, targetPath, prevName, name, spec);
			if (!Object.hasOwn(targetCfg.servers, prevName)) throw new Error(`源服务器 ${prevName} 不存在`);
			if (Object.hasOwn(targetCfg.servers, name)) throw new Error(`目标服务器 ${name} 已存在`);
			delete targetCfg.servers[prevName];
		}
		targetCfg.servers[name] = spec;
		writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
		return { ok: true };
	} catch (error) {
		return mutationError(error);
	}
}

function migrateMcpServer(
	sourcePath: string,
	targetPath: string,
	sourceName: string,
	targetName: string,
	spec: McpServerSpec,
): { ok: boolean; error?: string } {
	const journalPath = `${sourcePath}.migration.json`;
	const source = editableConfig(sourcePath);
	const target = editableConfig(targetPath);
	const desired = JSON.parse(JSON.stringify(spec));
	let journal: Record<string, any>;
	try {
		journal = JSON.parse(readFileSync(journalPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!Object.hasOwn(source.servers, sourceName)) throw new Error(`源服务器 ${sourceName} 不存在`);
		if (Object.hasOwn(target.servers, targetName)) throw new Error(`目标服务器 ${targetName} 已存在`);
		journal = {
			version: 1,
			sourcePath: resolve(sourcePath),
			targetPath: resolve(targetPath),
			sourceName,
			targetName,
			sourceSpec: source.servers[sourceName],
			targetSpec: desired,
		};
		atomicWrite(journalPath, journal);
	}
	if (
		!isRecord(journal) ||
		journal.version !== 1 ||
		journal.sourcePath !== resolve(sourcePath) ||
		journal.targetPath !== resolve(targetPath) ||
		journal.sourceName !== sourceName ||
		journal.targetName !== targetName ||
		!isRecord(journal.sourceSpec) ||
		!isDeepStrictEqual(journal.targetSpec, desired)
	) {
		throw new Error(`存在不同或损坏的 MCP 迁移事务：${journalPath}`);
	}
	const hasSource = Object.hasOwn(source.servers, sourceName);
	const hasTarget = Object.hasOwn(target.servers, targetName);
	if (
		(hasSource && !isDeepStrictEqual(source.servers[sourceName], journal.sourceSpec)) ||
		(hasTarget && !isDeepStrictEqual(target.servers[targetName], desired))
	) {
		throw new Error(`MCP 迁移期间配置已变更，保留两端并停止：${journalPath}`);
	}
	if (!hasSource && !hasTarget) throw new Error(`MCP 迁移两端记录均不存在：${journalPath}`);
	if (!hasTarget) {
		target.servers[targetName] = desired;
		writeMcpConfigFile(targetPath, target.servers, target.legacy);
	}
	if (hasSource) {
		delete source.servers[sourceName];
		writeMcpConfigFile(sourcePath, source.servers, source.legacy);
	}
	unlinkSync(journalPath);
	return { ok: true };
}

export function deleteMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	name: string;
	scope: McpScope;
}): { ok: boolean; error?: string } {
	const name = opts.name.trim();
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = opts.scope === "global" ? globalPath : projectPath;

	try {
		const targetCfg = editableConfig(targetPath);
		if (!targetCfg.servers[name]) {
			return { ok: false, error: `服务器 ${name} 在 ${opts.scope === "global" ? "全局" : "项目"} 配置中不存在` };
		}

		delete targetCfg.servers[name];
		writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
		return { ok: true };
	} catch (error) {
		return mutationError(error);
	}
}

export function toggleMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	name: string;
	scope: McpScope;
	enabled: boolean;
}): { ok: boolean; error?: string } {
	const name = opts.name.trim();
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = opts.scope === "global" ? globalPath : projectPath;

	try {
		const targetCfg = editableConfig(targetPath);
		if (targetCfg.servers[name]) {
			targetCfg.servers[name].enabled = opts.enabled;
			writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
			return { ok: true };
		}

		if (opts.scope === "project") {
			const globalCfg = editableConfig(globalPath);
			if (globalCfg.servers[name]) {
				targetCfg.servers[name] = { enabled: opts.enabled };
				writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
				return { ok: true };
			}
		}

		return { ok: false, error: `服务器 ${name} 不存在` };
	} catch (error) {
		return mutationError(error);
	}
}

export function deriveMcpServerName(raw: string): string {
	let s = String(raw ?? "").trim();
	if (!s) return "";
	if (/^https?:\/\//i.test(s)) {
		try {
			const u = new URL(s);
			s = u.hostname;
		} catch {}
	} else {
		const atIdx = s.lastIndexOf("@");
		if (atIdx > 0) {
			s = s.slice(0, atIdx);
		}
		if (s.startsWith("@") && s.includes("/")) {
			const [scopePart, pkgPart] = s.slice(1).split("/", 2);
			if (pkgPart && !/^(mcp|server|mcp-server)$/i.test(pkgPart)) {
				s = pkgPart;
			} else if (scopePart) {
				s = scopePart;
			}
		}
		const stripped = s.replace(/^(mcp-server-|server-|mcp-)/i, "").replace(/(-mcp-server|-server|-mcp)$/i, "");
		if (stripped.trim()) {
			s = stripped.trim();
		}
	}
	return s
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

export interface McpCheckResult {
	installed: boolean;
	running: boolean;
	enabled: boolean;
	server: UiMcpServer | null;
	matches: UiMcpServer[];
	tools: UiMcpToolInfo[];
}

export function checkMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	bridge?: McpBridge;
	query: string;
}): McpCheckResult {
	const q = String(opts.query ?? "").trim();
	if (!q) {
		return { installed: false, running: false, enabled: false, server: null, matches: [], tools: [] };
	}
	const qLower = q.toLowerCase();
	const derived = deriveMcpServerName(q).toLowerCase();
	const { servers } = listAllMcpServers(opts);

	const scored: Array<{ server: UiMcpServer; score: number }> = [];
	for (const srv of servers) {
		const nameLower = srv.name.toLowerCase();
		const cmdLower = (srv.command ?? "").toLowerCase();
		const argsLower = (srv.args ?? []).map((a) => String(a).toLowerCase());
		const urlLower = (srv.url ?? "").toLowerCase();
		let score = 0;
		if (srv.name === q) {
			score = 100;
		} else if (nameLower === qLower) {
			score = 90;
		} else if (derived && nameLower === derived) {
			score = 80;
		} else if (argsLower.some((a) => a === qLower || (derived && deriveMcpServerName(a).toLowerCase() === derived))) {
			score = 75;
		} else if (
			nameLower.includes(qLower) ||
			cmdLower.includes(qLower) ||
			urlLower.includes(qLower) ||
			argsLower.some((a) => a.includes(qLower))
		) {
			score = 50;
		}
		if (score > 0) {
			if (srv.scope === "project") score += 2;
			if (srv.status === "running") score += 1;
			scored.push({ server: srv, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	const matches = scored.map((x) => x.server);
	const primary = matches[0] ?? null;
	return {
		installed: matches.length > 0,
		running: primary ? primary.status === "running" : false,
		enabled: primary ? primary.enabled !== false : false,
		server: primary,
		matches,
		tools: primary?.tools ?? [],
	};
}

export interface McpInstallSpec {
	name?: string;
	package?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	type?: "stdio" | "http" | "streamable-http";
	timeout?: number;
	description?: string;
	overwrite?: boolean;
	scope?: McpScope;
	enabled?: boolean;
}

export interface McpInstallResult {
	ok: boolean;
	name?: string;
	scope?: McpScope;
	status?: "running" | "stopped" | "error";
	tools?: UiMcpToolInfo[];
	server?: UiMcpServer;
	error?: string;
}

export async function installMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	bridge?: McpBridge;
	spec: McpInstallSpec;
}): Promise<McpInstallResult> {
	const spec = opts.spec ?? {};
	const pkg = typeof spec.package === "string" ? spec.package.trim() : "";
	const rawCmd = typeof spec.command === "string" ? spec.command.trim() : "";
	const rawUrl = typeof spec.url === "string" ? spec.url.trim() : "";
	const extraArgs = Array.isArray(spec.args) ? spec.args.map(String) : [];

	let command = rawCmd || undefined;
	let args = extraArgs.length > 0 ? extraArgs : undefined;
	if (pkg) {
		command = command || "npx";
		args = command === "npx" ? ["-y", pkg, ...extraArgs] : [pkg, ...extraArgs];
	}

	if (!command && !rawUrl) {
		return {
			ok: false,
			error: "安装 MCP 服务器需提供 package（npm 包名）、command（启动命令）或 url（HTTP 地址）之一",
		};
	}

	const rawName =
		(typeof spec.name === "string" && spec.name.trim()) ||
		deriveMcpServerName(pkg || rawUrl || extraArgs[0] || command || "");
	if (!rawName || !isValidMcpServerName(rawName)) {
		return {
			ok: false,
			error: "无法推导出合法的服务器名称，请显式指定 name（仅允许英文字母、数字、下划线及中划线）",
		};
	}

	const scope: McpScope = spec.scope === "global" ? "global" : "project";
	const existing = listAllMcpServers({ agentDir: opts.agentDir, cwd: opts.cwd, dataDir: opts.dataDir }).servers.find(
		(s) => s.name === rawName && s.scope === scope,
	);
	if (existing && spec.overwrite !== true) {
		return {
			ok: false,
			error: `已存在同名服务器「${rawName}」(${scope})——确认要覆盖请传 overwrite=true（将替换其命令/参数/环境变量）`,
		};
	}
	const uiServer: UiMcpServer = {
		name: rawName,
		scope,
		command,
		args,
		cwd: typeof spec.cwd === "string" && spec.cwd.trim() ? spec.cwd.trim() : undefined,
		env: spec.env && typeof spec.env === "object" ? spec.env : undefined,
		url: rawUrl || undefined,
		headers: spec.headers && typeof spec.headers === "object" ? spec.headers : undefined,
		type: spec.type ?? (rawUrl ? "streamable-http" : "stdio"),
		timeout: typeof spec.timeout === "number" ? spec.timeout : undefined,
		enabled: spec.enabled !== false,
		description: typeof spec.description === "string" && spec.description.trim() ? spec.description.trim() : undefined,
		status: "stopped",
		tools: [],
	};

	const saved = saveMcpServer({
		agentDir: opts.agentDir,
		cwd: opts.cwd,
		dataDir: opts.dataDir,
		server: uiServer,
	});
	if (!saved.ok) {
		return { ok: false, error: saved.error };
	}

	if (opts.bridge) {
		try {
			await opts.bridge.reload();
		} catch {}
	}

	const after = listAllMcpServers({
		agentDir: opts.agentDir,
		cwd: opts.cwd,
		dataDir: opts.dataDir,
		bridge: opts.bridge,
	});
	const updated =
		after.servers.find((s) => s.name === rawName && s.scope === scope) ??
		after.servers.find((s) => s.name === rawName) ??
		uiServer;

	return {
		ok: true,
		name: rawName,
		scope,
		status: updated.status,
		tools: updated.tools,
		server: updated,
		...(updated.error ? { error: updated.error } : {}),
	};
}
