import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpOAuthMessage, McpServerInventory, PluginsPort } from "../packages/keel/src/contracts/plugins.js";
import type { CorePluginsSinks } from "../packages/keel/src/app/core-engine.js";
import type { McpScope, ServerMessage, UiMcpServer, UiPluginUpdateInfo } from "./protocol.js";
import type { McpBridge } from "./mcp-bridge.js";
import {
	deleteMcpServer as deleteMcpServerFile,
	listAllMcpServers,
	saveMcpServer as saveMcpServerFile,
	toggleMcpServer as toggleMcpServerFile,
} from "./mcp-manager.js";
import { McpOAuthUi } from "./mcp-oauth-ui.js";
import { fetchRemoteMcpMarket, fetchRemoteSkillContent, fetchRemoteSkillMarket } from "./market-service.js";
import { discoverDiskSkills, readSkillInstruction } from "./skill-discovery.js";
import { checkPluginUpdates } from "./plugin-updater.js";
import { enablePluginAfterInstall } from "./plugin-installer.js";
import {
	checkAll as checkAllUpdates,
	collectTargets,
	compareVersions,
	detectPiSdkSplit,
	resolveNpmRegistry,
	sortUpdateItems,
	type UpdateItem,
} from "./update-check.js";
import { collectInstalledEngineTargets } from "./engine-probe.js";
import { isBundledInUse, sdkCopies } from "./sdk-origin.js";
import { publishCorePluginsHandle, releaseCorePluginsHandle } from "./core-plugins-handle.js";

/** 适配器只用 MCP 运行时的两个方法：结构面比整个注册表窄，单测不必造一个注册表。 */
export interface CoreMcpProjectRuntime {
	peekBridge(cwd: string): McpBridge | undefined;
	reload(cwd: string, scope: "project" | "global"): Promise<void>;
}

export interface CorePluginsAdapterOptions extends CorePluginsSinks {
	/** 全局配置根（`<agentDir>/skills`、`<agentDir>/npm/.npmrc` 都在它下面）。 */
	agentDir: string;
	dataDir: string;
	/** 本进程的 pi-web-ui 版本（`update_status.current`）。 */
	version: string;
	/** MCP 项目运行时（`server/index.ts` 的 `mcpProjects`）；缺省 = 没有连接域，只读配置文件。 */
	mcpProjects?: () => CoreMcpProjectRuntime | undefined;
}

/** 更新中心的整体缓存窗口（与老实现 `ClientSession.UPDATE_ALL_CACHE_MS` 同口径）。 */
const UPDATE_ALL_CACHE_MS = 30 * 60_000;

/**
 * 宿主侧适配器：把 MCP / 技能 / 市场 / 插件更新 / 更新中心按 `PluginsPort` 的窄面交给内核。
 *
 * 不重写任何一件：`mcp-manager`（mcp.json 读写）、`mcp-project-runtime`（连接域）、`mcp-oauth-ui`
 * （授权流程）、`market-service`（市场拉取）、`skill-discovery`（磁盘技能）、`plugin-updater`、
 * `update-check` + `engine-probe` + `sdk-origin`（更新中心）各管一段，这里只按老实现的顺序串起来：
 * 写配置 → 重载连接域 → 广播 `mcp_servers` + `extension_inventory_changed` → （内核侧补设置帧）。
 *
 * 老实现里这些 handler 长在 `ClientSession` 上（每客户端一份），所以适配器也是每客户端一份：
 * 授权流程实例、插件更新通知去重集、整体更新缓存都跟着会话走，与老实现同一粒度。
 */
export function createCorePlugins(options: CorePluginsAdapterOptions): PluginsPort {
	const emit = (msg: ServerMessage): void => {
		if (options.isDisposed()) return;
		options.emit(msg);
	};
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		emit({ type: "notice", level, text, textEn });
	};
	const projects = (): CoreMcpProjectRuntime | undefined => options.mcpProjects?.();
	const listServers = (cwd: string) =>
		listAllMcpServers({
			agentDir: options.agentDir,
			cwd,
			dataDir: options.dataDir,
			bridge: projects()?.peekBridge(cwd),
		});
	/** 端口与宿主句柄共用的那一份投影：`cwd` 缺省取本客户端活动对话的目录。 */
	const listMcpServers = (cwd?: string): McpServerInventory => listServers(cwd ?? options.getCwd());
	const broadcastMcpServers = (cwd: string): void => {
		const data = listServers(cwd);
		emit({
			type: "mcp_servers",
			servers: data.servers,
			globalConfigPath: data.globalPath,
			projectConfigPath: data.projectPath,
		});
		// issue #885：MCP 配置增删改后让前端重拉统一清单（不触发重载）。
		emit({ type: "extension_inventory_changed" });
	};
	/** 技能目录：全局在 `<agentDir>/skills`，项目在当前工作目录的 `.pi/skills`。 */
	const skillBaseDir = (scope: "global" | "project"): string =>
		scope === "global" ? join(options.agentDir, "skills") : join(options.getCwd(), ".pi", "skills");

	const oauth = new McpOAuthUi();
	// 设置帧与扩展清单没有端口句柄，靠这一次登记拿到同一份 listMcpServers / reloadSession。
	const handle = publishCorePluginsHandle({
		listMcpServers,
		reloadSession: () => options.reloadSession(),
	});
	const notifiedPluginUpdates = new Set<string>();
	let lastPluginUpdates: UiPluginUpdateInfo[] = [];
	let updatesAllCache: { at: number; items: UpdateItem[] } | null = null;

	/** 插件更新清单（老实现 4 处共用同一份映射：先出帧，再按 manual 决定要不要发 notice）。 */
	const mapPluginUpdates = (updates: Awaited<ReturnType<typeof checkPluginUpdates>>): UiPluginUpdateInfo[] =>
		updates.map((p) => ({
			id: p.id,
			name: p.name,
			version: p.version,
			latestVersion: p.latestVersion ?? null,
			source: p.source,
			localSha: p.localSha,
			remoteSha: p.remoteSha,
			updatable: p.updatable,
			builtin: p.builtin,
			error: p.error,
		}));
	/** 内置插件有更新才主动提示；同一版本组合只提示一次（自动检查路径）。 */
	const notifyNewBuiltinUpdates = (list: UiPluginUpdateInfo[], manual: boolean): void => {
		const updatableBuiltins = list.filter((p) => p.builtin && p.updatable);
		if (manual) {
			const allUpdatable = list.filter((p) => p.updatable);
			const target = updatableBuiltins.length > 0 ? updatableBuiltins : allUpdatable;
			if (target.length === 0) {
				notice("info", "所有插件均为最新版本。", "All plugins are up to date.");
				return;
			}
			const names = target.map((p) => p.name || p.id).join(", ");
			notice(
				"info",
				`发现 ${target.length} 个插件有更新：${names}`,
				`Update available for ${target.length} plugin(s): ${names}`,
			);
			return;
		}
		const fresh = updatableBuiltins.filter((p) => {
			const key = `${p.id}@${p.latestVersion || p.remoteSha || "upd"}`;
			if (notifiedPluginUpdates.has(key)) return false;
			notifiedPluginUpdates.add(key);
			return true;
		});
		if (fresh.length === 0) return;
		const names = fresh.map((p) => p.name || p.id).join(", ");
		notice(
			"info",
			`发现 ${fresh.length} 个内置插件有更新可用：${names}，可前往设置或更新面板中更新。`,
			`Update available for ${fresh.length} built-in plugin(s): ${names}. You can update in Settings or the Updates panel.`,
		);
	};

	/** 插件更新也进「检查全部」清单；插件那半段失败不能把整张表打掉（同老实现）。 */
	const collectPluginUpdateItems = async (): Promise<UpdateItem[]> => {
		try {
			const updates = await checkPluginUpdates(options.dataDir, undefined, () => options.getLang());
			const list = mapPluginUpdates(updates);
			lastPluginUpdates = list;
			emit({ type: "plugin_updates", updates: list });
			notifyNewBuiltinUpdates(list, false);
			const versionLabel = (v?: string | null) => (v ? (/^[vV]/.test(v) ? v : `v${v}`) : null);
			return updates.map((p) => ({
				name: p.name ? `${p.name} (${p.id})` : p.id,
				kind: "plugin" as const,
				current: versionLabel(p.version) ?? p.localSha ?? "unknown",
				latest: versionLabel(p.latestVersion) ?? p.remoteSha ?? null,
				latestPublishedAt: null,
				upToDate: !p.updatable,
				error: p.error,
				source: p.source,
				pluginId: p.id,
				builtin: p.builtin,
			}));
		} catch (err) {
			console.warn("[core-plugins] 检查插件更新失败:", err);
			return [];
		}
	};

	return {
		listMcpServers,

		/** 客户端断开：关掉本端口的授权流程，并收回宿主句柄（别把 attempt 与闭包留在进程里）。 */
		dispose(): void {
			oauth.dispose();
			releaseCorePluginsHandle(handle);
		},

		async saveMcpServer(server: UiMcpServer, prevName?: string, prevScope?: McpScope): Promise<void> {
			const cwd = options.getCwd();
			const res = await saveMcpServerFile({
				agentDir: options.agentDir,
				cwd,
				dataDir: options.dataDir,
				server,
				prevName,
				prevScope,
			});
			if (!res.ok) {
				notice("error", res.error || "保存 MCP 服务器失败", res.error || "Failed to save MCP server");
				return;
			}
			await projects()?.reload(cwd, server.scope === "global" || prevScope === "global" ? "global" : "project");
			broadcastMcpServers(cwd);
		},

		async deleteMcpServer(name: string, scope: McpScope): Promise<void> {
			const cwd = options.getCwd();
			const res = await deleteMcpServerFile({
				agentDir: options.agentDir,
				cwd,
				dataDir: options.dataDir,
				name,
				scope,
			});
			if (!res.ok) {
				notice("error", res.error || "删除 MCP 服务器失败", res.error || "Failed to delete MCP server");
				return;
			}
			await projects()?.reload(cwd, scope);
			broadcastMcpServers(cwd);
		},

		async toggleMcpServer(name: string, scope: McpScope, enabled: boolean): Promise<void> {
			const cwd = options.getCwd();
			const res = await toggleMcpServerFile({
				agentDir: options.agentDir,
				cwd,
				dataDir: options.dataDir,
				name,
				scope,
				enabled,
			});
			if (!res.ok) {
				notice("error", res.error || "切换 MCP 服务器状态失败", res.error || "Failed to toggle MCP server");
				return;
			}
			await projects()?.reload(cwd, scope);
			broadcastMcpServers(cwd);
		},

		async reloadMcp(): Promise<void> {
			const cwd = options.getCwd();
			await projects()?.reload(cwd, "global");
			broadcastMcpServers(cwd);
			notice("info", "已重新加载所有 MCP 服务器", "Reloaded all MCP servers");
		},

		async handleMcpOAuth(msg: McpOAuthMessage): Promise<void> {
			const cwd = options.getCwd();
			await oauth.handle(msg, {
				cwd,
				agentDir: options.agentDir,
				resolveServer: (name, scope) =>
					listServers(cwd).servers.find((server) => server.name === name && server.scope === scope)?.url,
				reload: async (capturedCwd) => {
					await projects()?.reload(capturedCwd, "global");
					if (!options.isDisposed()) broadcastMcpServers(capturedCwd);
				},
				send: (message) => emit(message),
			});
		},

		async installSkill(name: string, scope: "global" | "project", content: string): Promise<void> {
			const cleanName = name.trim();
			if (!cleanName || !/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
				notice(
					"error",
					"技能名称非法，仅允许包含英文字母、数字、下划线及中划线",
					"Invalid skill name: only letters, numbers, underscores and hyphens are allowed",
				);
				return;
			}
			const targetDir = join(skillBaseDir(scope), cleanName);
			try {
				mkdirSync(targetDir, { recursive: true });
				writeFileSync(join(targetDir, "SKILL.md"), `${content.trim()}\n`, "utf8");
				await options.reloadSession();
				notice(
					"info",
					`技能「${cleanName}」已成功安装至${scope === "global" ? "全局" : "当前项目"}`,
					`Skill "${cleanName}" installed successfully to ${scope === "global" ? "global" : "project"}`,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				notice("error", `安装技能失败：${message}`, `Failed to install skill: ${message}`);
			}
		},

		async uninstallSkill(name: string, scope: "global" | "project"): Promise<void> {
			const cleanName = name.trim();
			const baseDir = skillBaseDir(scope);
			const targetDir = join(baseDir, cleanName);
			const singleFile = join(baseDir, `${cleanName}.md`);
			try {
				let deleted = false;
				if (existsSync(targetDir)) {
					rmSync(targetDir, { recursive: true, force: true });
					deleted = true;
				}
				if (existsSync(singleFile)) {
					rmSync(singleFile, { force: true });
					deleted = true;
				}
				if (!deleted) {
					notice("warning", `未找到技能「${cleanName}」的安装文件`, `Skill "${cleanName}" installation file not found`);
					return;
				}
				await options.reloadSession();
				notice(
					"info",
					`技能「${cleanName}」已从${scope === "global" ? "全局" : "当前项目"}卸载`,
					`Skill "${cleanName}" uninstalled from ${scope === "global" ? "global" : "project"}`,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				notice("error", `卸载技能失败：${message}`, `Failed to uninstall skill: ${message}`);
			}
		},

		async fetchMcpMarket(source?: string, query?: string, page?: number, refresh?: boolean): Promise<void> {
			const res = await fetchRemoteMcpMarket({ source, query, page, refresh, dataDir: options.dataDir });
			emit({
				type: "mcp_market_result",
				ok: res.ok,
				servers: res.servers,
				source: res.source,
				total: res.total,
				error: res.error,
			});
		},

		async fetchSkillMarket(repo?: string, refresh?: boolean): Promise<void> {
			const res = await fetchRemoteSkillMarket({ repo, refresh, dataDir: options.dataDir });
			emit({ type: "skill_market_result", ok: res.ok, skills: res.skills, repo: res.repo, error: res.error });
		},

		async fetchSkillContent(repo: string, skillId: string): Promise<void> {
			// `local` 走磁盘扫描（面板要看已安装技能的正文），其余走 GitHub。
			if (repo === "local" || !repo) {
				const diskSkills = discoverDiskSkills({ cwd: options.getCwd(), agentDir: options.agentDir });
				const matched = diskSkills.find((s) => s.name.toLowerCase() === skillId.toLowerCase());
				if (matched) {
					emit({
						type: "skill_content_result",
						ok: true,
						skillId,
						content: readSkillInstruction(matched.filePath),
					});
					return;
				}
			}
			const res = await fetchRemoteSkillContent({ repo, skillId, dataDir: options.dataDir });
			emit({
				type: "skill_content_result",
				ok: res.ok,
				skillId: res.skillId,
				content: res.content,
				error: res.error,
			});
		},

		async enableInstalledPlugin(pluginId: string): Promise<boolean> {
			const next = enablePluginAfterInstall(options.getDisabledPlugins(), pluginId);
			if (!next) return false;
			await options.setDisabledPlugins(next);
			return true;
		},

		async checkPluginUpdates(manual = false): Promise<void> {
			updatesAllCache = null;
			try {
				const updates = await checkPluginUpdates(options.dataDir, undefined, () => options.getLang());
				const list = mapPluginUpdates(updates);
				lastPluginUpdates = list;
				emit({ type: "plugin_updates", updates: list });
				notifyNewBuiltinUpdates(list, manual);
			} catch (err) {
				// 自动检查失败保持安静（同老实现）：手动才把原因回告前端。
				if (!manual) return;
				const message = err instanceof Error ? err.message : String(err);
				notice("error", `检查插件更新失败：${message}`, `Failed to check plugin updates: ${message}`);
			}
		},

		async checkUpdate(): Promise<void> {
			const current = options.version;
			try {
				const { registry, authHeader } = resolveNpmRegistry(options.agentDir);
				const res = await fetch(`${registry}/pi-web-ui`, {
					signal: AbortSignal.timeout(8_000),
					...(authHeader ? { headers: { authorization: authHeader } } : {}),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as { "dist-tags"?: { latest?: string }; time?: Record<string, string> };
				const latest = data["dist-tags"]?.latest ?? null;
				const latestPublishedAt = latest && data.time ? (data.time[latest] ?? null) : null;
				const upToDate = latest === null || compareVersions(current, latest) >= 0;
				emit({ type: "update_status", current, latest, latestPublishedAt, upToDate });
			} catch (err) {
				emit({
					type: "update_status",
					current,
					latest: null,
					latestPublishedAt: null,
					upToDate: false,
					error: `检查更新失败：${(err as Error).message}`,
				});
			}
		},

		async checkUpdatesAll(force = false): Promise<void> {
			const piSdk = {
				running: options.version,
				bundledInUse: isBundledInUse(sdkCopies(), options.version),
				newerInstalled: detectPiSdkSplit(options.version)?.installed ?? null,
			};
			if (!force && updatesAllCache && Date.now() - updatesAllCache.at < UPDATE_ALL_CACHE_MS) {
				emit({ type: "update_status_all", items: updatesAllCache.items, piSdk });
				if (lastPluginUpdates.length > 0) emit({ type: "plugin_updates", updates: lastPluginUpdates });
				return;
			}
			try {
				const targets = collectTargets(options.agentDir, options.version, undefined, {
					projectCwd: options.getCwd(),
					extraTargets: collectInstalledEngineTargets(),
				});
				const items = await checkAllUpdates(
					targets,
					undefined,
					() => options.getLang(),
					resolveNpmRegistry(options.agentDir),
				);
				const pluginItems = await collectPluginUpdateItems();
				const allItems = sortUpdateItems([...items, ...pluginItems]);
				updatesAllCache = { at: Date.now(), items: allItems };
				emit({ type: "update_status_all", items: allItems, piSdk });
			} catch (err) {
				emit({
					type: "update_status_all",
					items: [
						{
							name: "pi-web-ui",
							kind: "webui",
							current: options.version,
							latest: null,
							latestPublishedAt: null,
							upToDate: false,
							error: `检查更新失败：${(err as Error).message}`,
						},
					],
				});
			}
		},
	};
}
