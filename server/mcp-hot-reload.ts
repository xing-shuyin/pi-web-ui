import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import {
	getGlobalMcpPath,
	getProjectMcpPath,
	mcpServerSnapshot,
	parseMcpConfig,
	type McpReloadSummary,
	type McpServerSpec,
} from "./mcp-bridge.js";

export type McpReloadOutcome = "reloaded" | "unchanged" | "invalid";

export interface McpHotReloadDeps {
	dataDir: string;
	agentDir?: string;
	cwd?: string;
	reload: () => Promise<McpReloadSummary>;
	onToolsChanged?: () => void;
	onNotice?: (level: "info" | "warning", text: string, textEn: string) => void;
	log?: (...a: unknown[]) => void;
	debounceMs?: number;
	pollIntervalMs?: number;
}

export interface McpHotReload {
	apply(): Promise<McpReloadOutcome>;
	start(): void;
	dispose(): void;
}

function fingerprint(servers: Record<string, McpServerSpec>): string {
	const names = Object.keys(servers).sort();
	return JSON.stringify(names.map((n) => [n, mcpServerSnapshot(servers[n])]));
}

export function createMcpHotReload(deps: McpHotReloadDeps): McpHotReload {
	const globalFile = getGlobalMcpPath(deps.agentDir, deps.dataDir);
	const projectFile = deps.cwd ? getProjectMcpPath(deps.cwd) : undefined;
	const legacyFile = join(deps.dataDir, "mcp.json");

	const log = deps.log ?? (() => {});
	const debounceMs = deps.debounceMs ?? 300;
	const pollIntervalMs = deps.pollIntervalMs ?? 2000;
	let applied: string | null = null;
	let disposed = false;
	let applyTail: Promise<unknown> = Promise.resolve();
	let debounce: NodeJS.Timeout | null = null;
	let poller: NodeJS.Timeout | null = null;
	let watchers: FSWatcher[] = [];

	function readOneFile(file: string): { fp: string; servers: Record<string, McpServerSpec> | null } {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code === "ENOENT") return { fp: "empty", servers: {} };
			log(`[mcp] ${file} 读取失败（${code ?? String(err)}），按坏配置处理：保留在跑的 MCP 服务器`);
			return { fp: `unreadable:${code ?? "unknown"}`, servers: null };
		}
		const parsed = parseMcpConfig(raw);
		if (!parsed) return { fp: `invalid:${raw}`, servers: null };
		return { fp: `ok:${fingerprint(parsed.servers)}`, servers: parsed.servers };
	}

	function readOnce(): { fp: string; servers: Record<string, McpServerSpec> | null } {
		const g = readOneFile(globalFile);
		let globalServers = g.servers;
		let gFp = g.fp;
		const globalHasNoServers = g.servers !== null && Object.keys(g.servers).length === 0;
		if ((g.fp === "empty" || globalHasNoServers) && legacyFile !== globalFile) {
			const leg = readOneFile(legacyFile);
			if (leg.servers) {
				globalServers = leg.servers;
				gFp = leg.fp;
			} else if (leg.fp.startsWith("unreadable:") || leg.fp.startsWith("invalid:")) {
				return leg;
			}
		} else if (!g.servers && (g.fp.startsWith("unreadable:") || g.fp.startsWith("invalid:"))) {
			return g;
		}

		let pFp = "none";
		let projServers: Record<string, McpServerSpec> | null = {};
		if (projectFile) {
			const p = readOneFile(projectFile);
			if (!p.servers && (p.fp.startsWith("unreadable:") || p.fp.startsWith("invalid:"))) {
				return p;
			}
			projServers = p.servers;
			pFp = p.fp;
		}

		const merged: Record<string, McpServerSpec> = { ...globalServers };
		for (const [name, ps] of Object.entries(projServers || {})) {
			if (!ps.command && !ps.url && ps.enabled !== undefined && merged[name]) {
				merged[name] = { ...merged[name], enabled: ps.enabled };
			} else {
				merged[name] = ps;
			}
		}

		return {
			fp: `g:${gFp}|p:${pFp}`,
			servers: merged,
		};
	}

	async function applyOnce(): Promise<McpReloadOutcome> {
		if (disposed) return "unchanged";
		const { fp, servers } = readOnce();
		if (fp === applied) return "unchanged";
		applied = fp;
		if (!servers) {
			log("[mcp] mcp.json 解析失败，保留在跑的 MCP 服务器");
			deps.onNotice?.(
				"warning",
				"mcp.json 解析/读取失败，已保留当前 MCP 服务器（恢复可读后会自动重载）",
				"Failed to parse/read mcp.json — keeping the running MCP servers (it reloads automatically once readable)",
			);
			return "invalid";
		}
		let summary: McpReloadSummary;
		try {
			summary = await deps.reload();
		} catch (err) {
			applied = null;
			throw err;
		}
		if (disposed) return "unchanged";
		deps.onToolsChanged?.();
		log(
			`[mcp] 配置已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具` +
				`（沿用 ${summary.kept}、启动 ${summary.started}、关闭 ${summary.stopped}、失败 ${summary.failed}）`,
		);
		if (summary.failed > 0) {
			deps.onNotice?.(
				"warning",
				`MCP 配置应用失败：${summary.failed} 个服务器未能启动，已有实例已保留；请查看服务器错误详情`,
				`MCP configuration failed for ${summary.failed} server(s); previous instances were retained where available. Check server error details.`,
			);
		} else {
			deps.onNotice?.(
				"info",
				`mcp.json 已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具`,
				`mcp.json reloaded: ${summary.servers} server(s) / ${summary.tools} tool(s)`,
			);
		}
		return "reloaded";
	}

	function apply(): Promise<McpReloadOutcome> {
		const run = applyTail.then(applyOnce);
		applyTail = run.catch(() => {});
		return run;
	}

	function run(): void {
		void apply().catch((err) => log("[mcp] 热加载失败：", err instanceof Error ? err.message : err));
	}

	function schedule(): void {
		if (disposed || debounce) return;
		debounce = setTimeout(() => {
			debounce = null;
			run();
		}, debounceMs);
	}

	function fallBackToPolling(): void {
		if (disposed) return;
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
		watchers = [];
		if (poller) return;
		log(`[mcp] 目录监视不可用，mcp.json 热加载回落到 ${pollIntervalMs}ms 轮询`);
		poller = setInterval(run, pollIntervalMs);
		poller.unref();
	}

	function start(): void {
		if (disposed || watchers.length > 0 || poller) return;
		applied = readOnce().fp;

		const dirsToWatch = new Set<string>();
		dirsToWatch.add(deps.dataDir);
		if (globalFile) dirsToWatch.add(dirname(globalFile));
		if (projectFile) dirsToWatch.add(dirname(projectFile));

		for (const dir of dirsToWatch) {
			try {
				const w = watch(dir, { persistent: false }, (_event, filename) => {
					if (typeof filename === "string" && filename && filename !== "mcp.json") return;
					schedule();
				});
				w.on("error", () => fallBackToPolling());
				watchers.push(w);
			} catch {
				fallBackToPolling();
			}
		}
	}

	function dispose(): void {
		disposed = true;
		if (debounce) clearTimeout(debounce);
		debounce = null;
		if (poller) clearInterval(poller);
		poller = null;
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
		watchers = [];
	}

	return { apply, start, dispose };
}
