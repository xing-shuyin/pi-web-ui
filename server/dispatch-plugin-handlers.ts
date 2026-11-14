import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { DispatchSession } from "./index.js";
import type { PluginManager } from "./plugins.js";
import { buildPluginJobArgs, inspectInstallSpec, type PluginInstaller } from "./plugin-installer.js";
import { syncPluginCatalog } from "./plugin-catalog-sync.js";
import type { ServerLang } from "./i18n.js";
import { collectExtensionInventory, mcpServersToInput } from "./extension-inventory.js";
import { getSdkBuiltinExtensionFactories } from "./sdk-builtin-extensions.js";

export interface PluginDispatchContext {
	pluginMgr: PluginManager;
	pluginInstaller: PluginInstaller;
	cs: DispatchSession | undefined;
	clientId: string | undefined;
	send: (msg: ServerMessage) => void;
	dataDir: string;
	cwd: string;
	clients: Iterable<WebSocket>;
	pendingPathRequests: Map<string, { recipients: Set<string>; timer: NodeJS.Timeout; resolve: (ok: boolean) => void }>;
	pendingPermissionRequests: Map<
		string,
		{ recipients: Set<string>; timer: NodeJS.Timeout; resolve: (res: { ok: boolean; remember: boolean }) => void }
	>;
	pendingDomConsents: Map<string, { id: string; pluginId: string; recipients: Set<string>; timer: NodeJS.Timeout }>;
	findDomConsentById: (
		id: string,
	) => { id: string; pluginId: string; recipients: Set<string>; timer: NodeJS.Timeout } | undefined;
	applyDomConsent: (pluginId: string, granted: boolean) => void;
	pushPluginGrants: () => void;
	pushPluginPermissions: () => void;
	reloadPluginsAndPush: (lang: () => ServerLang) => Promise<void>;
	confirmPluginInstallHelper: (items: Array<{ id: string; source: string }>) => Promise<boolean>;
}

export function handlePluginMessage(msg: ClientMessage, ctx: PluginDispatchContext): boolean {
	const {
		pluginMgr,
		pluginInstaller,
		cs,
		clientId,
		send,
		dataDir,
		cwd,
		clients,
		pendingPathRequests,
		pendingPermissionRequests,
		pendingDomConsents,
		findDomConsentById,
		applyDomConsent,
		pushPluginGrants,
		pushPluginPermissions,
		reloadPluginsAndPush,
		confirmPluginInstallHelper,
	} = ctx;

	switch (msg.type) {
		case "plugin_message":
			pluginMgr.handleMessage(msg.pluginId, msg.payload, clientId ?? undefined);
			return true;
		case "plugin_settings": {
			const r = pluginMgr.savePluginSettings(msg.pluginId, msg.values ?? {}, () => cs?.getLang() ?? "en");
			if (r.error) {
				cs?.emitNotice?.("error", `插件设置保存失败：${r.error}`, `Failed to save plugin settings: ${r.error}`);
			} else {
				cs?.emitNotice?.("info", "插件设置已保存", "Plugin settings saved");
			}
			return true;
		}
		case "plugins_reload":
			void pluginMgr.reload(() => cs?.getLang() ?? "en").then(() => pluginMgr.pushToAll());
			return true;
		case "plugin_catalog_add": {
			const r = pluginMgr.addCatalogEntry(msg.entry ?? {}, () => cs?.getLang() ?? "en");
			if (r.error) {
				cs?.emitNotice?.("error", `添加到插件列表失败：${r.error}`, `Failed to add to plugin list: ${r.error}`);
			} else {
				cs?.emitNotice?.("info", "已添加到插件列表", "Added to the plugin list");
			}
			return true;
		}
		case "plugin_catalog_remove": {
			const r = pluginMgr.removeCatalogEntry(msg.id, () => cs?.getLang() ?? "en");
			if (r.error) {
				cs?.emitNotice?.("error", `从插件列表移除失败：${r.error}`, `Failed to remove from plugin list: ${r.error}`);
			} else {
				cs?.emitNotice?.("info", "已从插件列表移除", "Removed from the plugin list");
			}
			return true;
		}
		case "plugin_job": {
			const jobLang = () => cs?.getLang() ?? "en";
			const jobId = String(msg.jobId ?? "");
			const pluginId = String(msg.id ?? "");
			const jobAction = msg.action;
			const jobSpec = {
				jobId,
				action: jobAction,
				id: pluginId,
				source: msg.source,
				build: msg.build === true,
				noBuild: msg.noBuild === true,
			};
			const jobDone = (ok: boolean, error?: string) => {
				send({
					type: "plugin_job",
					jobId,
					action: jobAction,
					pluginId,
					phase: "done",
					ok,
					...(error ? { error } : {}),
					output: "",
				});
			};
			const argCheck = buildPluginJobArgs(jobSpec, dataDir, jobLang);
			if ("error" in argCheck) {
				jobDone(false, argCheck.error);
				return true;
			}
			if (jobAction === "install" || jobAction === "update") {
				const alreadyGranted = pluginMgr.permGrants.has("plugin-installer", "net", { host: "github.com" });
				if (!alreadyGranted) {
					send({
						type: "plugin_job",
						jobId,
						action: jobAction,
						pluginId,
						phase: "start",
					});
					send({
						type: "plugin_job",
						jobId,
						action: jobAction,
						pluginId,
						phase: "log",
						line: jobLang() === "zh" ? "等待确认安装授权…" : "Waiting for install confirmation…",
					});
				}
				void confirmPluginInstallHelper([{ id: pluginId, source: String(msg.source ?? "") }])
					.then((confirmed) => {
						if (!confirmed) {
							jobDone(
								false,
								jobLang() === "zh"
									? "用户未确认安装（拒绝或 120 秒超时）"
									: "Installation not confirmed (rejected or timed out after 120s)",
							);
							return;
						}
						startPluginJob();
					})
					.catch(() => jobDone(false, jobLang() === "zh" ? "安装确认流程异常" : "Installation confirmation error"));
				return true;
			}
			startPluginJob();

			function startPluginJob(): void {
				const started = pluginInstaller.start(jobSpec, {
					lang: jobLang,
					emit: (m) => send(m),
					done: async (ok, info) => {
						if (ok) {
							// 安装即启用：出厂默认把一批插件放在 disabledPlugins 里，不摘掉会变成「装了却找不到」
							if (jobAction === "install") {
								try {
									await cs?.enableInstalledPlugin?.(pluginId);
								} catch (err) {
									// 设置落盘失败时 commitSettings 已发过错误 notice，这里不阻断后面的重载与成功回执
									console.warn(`[plugins] enable after install failed (${pluginId}):`, err);
								}
							}
							await reloadPluginsAndPush(jobLang);
							if (typeof cs?.checkPluginUpdates === "function") {
								void cs.checkPluginUpdates(false);
							}
							const isZh = jobLang() === "zh";
							const actionLabel =
								jobAction === "uninstall"
									? isZh
										? "卸载"
										: "uninstalled"
									: jobAction === "update"
										? isZh
											? "更新"
											: "updated"
										: isZh
											? "安装"
											: "installed";
							cs?.emitNotice?.(
								"info",
								`插件「${pluginId}」${actionLabel}完成`,
								`Plugin "${pluginId}" ${actionLabel} successfully`,
							);
						} else if (info.error) {
							cs?.emitNotice?.("error", `插件操作失败：${info.error}`, `Plugin operation failed: ${info.error}`);
						}
					},
				});
				if (!started.ok) jobDone(false, started.error);
			}
			return true;
		}
		case "plugin_job_cancel":
			pluginInstaller.cancel(String(msg.jobId ?? ""));
			return true;
		case "plugin_install_inspect": {
			const requestId = String(msg.requestId ?? "");
			const source = String(msg.source ?? "");
			void inspectInstallSpec(source, {
				pluginsDir: pluginMgr.pluginsDir,
				...(typeof msg.explicitId === "string" && msg.explicitId.trim() ? { explicitId: msg.explicitId.trim() } : {}),
				force: msg.force === true,
			}).then((r) => {
				send({
					type: "plugin_install_inspect_result",
					requestId,
					source,
					kind: r.spec.kind,
					suggestedId: r.suggestedId,
					installed: r.installed,
					...(r.problem ? { problem: r.problem } : {}),
					...(r.detail ? { detail: r.detail } : {}),
					...(r.manifest ? { manifest: r.manifest } : {}),
				});
			});
			return true;
		}
		case "plugin_path_response": {
			const id = String(msg.id ?? "");
			const pending = pendingPathRequests.get(id);
			if (pending && clientId && pending.recipients.has(clientId)) {
				clearTimeout(pending.timer);
				pendingPathRequests.delete(id);
				pending.resolve(msg.ok === true);
			}
			return true;
		}
		case "plugin_permission_response": {
			const id = String(msg.id ?? "");
			const pending = pendingPermissionRequests.get(id);
			if (pending && clientId && pending.recipients.has(clientId)) {
				clearTimeout(pending.timer);
				pendingPermissionRequests.delete(id);
				const resolved = JSON.stringify({ type: "plugin_permission_resolved", id });
				for (const client of clients) {
					if (client.readyState === WebSocket.OPEN) {
						try {
							client.send(resolved);
						} catch {}
					}
				}
				pending.resolve({ ok: msg.ok === true, remember: msg.remember === true });
			}
			return true;
		}
		case "plugin_dom_consent": {
			if (msg.granted === true) {
				const pid = typeof msg.pluginId === "string" ? msg.pluginId.trim() : "";
				if (!pid || !pluginMgr.isDomPlugin(pid) || pendingDomConsents.has(pid)) return true;
				const id = randomUUID();
				const timer = setTimeout(() => {
					pendingDomConsents.delete(pid);
				}, 120_000);
				pendingDomConsents.set(pid, { id, pluginId: pid, recipients: new Set(pluginMgr.onlineClientIds()), timer });
				const payload = JSON.stringify({ type: "plugin_dom_consent_request", id, pluginId: pid, from: clientId });
				for (const client of clients) {
					if (client.readyState === WebSocket.OPEN) {
						try {
							client.send(payload);
						} catch {}
					}
				}
				return true;
			}
			applyDomConsent(msg.pluginId, false);
			return true;
		}
		case "plugin_dom_consent_response": {
			const id = typeof msg.id === "string" ? msg.id : "";
			const pendingConsent = findDomConsentById(id);
			if (pendingConsent && clientId && pendingConsent.recipients.has(clientId)) {
				clearTimeout(pendingConsent.timer);
				pendingDomConsents.delete(pendingConsent.pluginId);
				if (msg.ok === true) applyDomConsent(pendingConsent.pluginId, true);
			}
			return true;
		}
		case "plugin_path_revoke": {
			const removed = pluginMgr.grants.revoke(
				typeof msg.pluginId === "string" ? msg.pluginId : undefined,
				typeof msg.path === "string" ? msg.path : undefined,
			);
			cs?.emitNotice?.("info", `已撤销 ${removed} 条插件目录授权`, `Revoked ${removed} plugin path grant(s)`);
			pushPluginGrants();
			return true;
		}
		case "plugin_permission_revoke": {
			const family = msg.family === "net" || msg.family === "llm" ? msg.family : undefined;
			const removed = pluginMgr.permGrants.revoke(
				typeof msg.pluginId === "string" ? msg.pluginId : undefined,
				family,
				typeof msg.host === "string" || typeof msg.model === "string"
					? {
							...(typeof msg.host === "string" ? { host: msg.host } : {}),
							...(typeof msg.model === "string" ? { model: msg.model } : {}),
						}
					: undefined,
			);
			cs?.emitNotice?.("info", `已撤销 ${removed} 条能力授权`, `Revoked ${removed} permission grant(s)`);
			pushPluginPermissions();
			return true;
		}
		case "extension_inventory": {
			// #885 T1/健康/自动刷新：只读聚合三类来源，不改运行时、不触发重载。
			// 健康来自 listMcpServers 已有 status/error/tools（bridge 连接结果，只读，不新建连接）。
			// 首次查询即启动 mcp.json 监听（gitWatch 式防抖），变化发 extension_inventory_changed，前端自动重拉。
			const reqId = typeof msg.reqId === "number" ? msg.reqId : 0;
			void (async () => {
				try {
					const [sdkBuiltins, plugins] = await Promise.all([
						getSdkBuiltinExtensionFactories().catch((error) => {
							throw error;
						}),
						pluginMgr.list(() => cs?.getLang?.() ?? "en").catch(() => []),
					]);
					const settingsLike = (
						cs as unknown as {
							settingsSvc?: { current: { disabledExtensions?: unknown; disabledPlugins?: unknown } };
							listMcpServers?: () => { servers: import("./protocol.js").UiMcpServer[] };
						}
					)?.settingsSvc?.current;
					const disabledExtensions = Array.isArray(settingsLike?.disabledExtensions)
						? (settingsLike.disabledExtensions as string[])
						: [];
					const disabledPlugins = Array.isArray(settingsLike?.disabledPlugins)
						? (settingsLike.disabledPlugins as string[])
						: [];
					let mcpServers: import("./protocol.js").UiMcpServer[] = [];
					try {
						const maybeList = (
							cs as unknown as { listMcpServers?: () => { servers: import("./protocol.js").UiMcpServer[] } }
						)?.listMcpServers;
						if (typeof maybeList === "function") mcpServers = maybeList.call(cs).servers ?? [];
					} catch {
						mcpServers = [];
					}
					try {
						(cs as unknown as { watchMcpInventory?: () => void })?.watchMcpInventory?.();
					} catch {}
					const { entries, errors } = await collectExtensionInventory({
						getSdkBuiltins: () =>
							sdkBuiltins.map((b) => ({ name: b.name, replaceable: b.replaceable, hidden: b.hidden })),
						getDisabledExtensions: () => disabledExtensions,
						getPlugins: () =>
							plugins.map((p) => ({
								id: p.id,
								name: p.name,
								version: p.version,
								description: p.description,
								error: p.error,
								active: p.active,
							})),
						getDisabledPlugins: () => disabledPlugins,
						getMcpServers: () => mcpServersToInput(mcpServers),
						// 只读 probe 预留：生产直接用 list 信息，不新建连接；单测注入失败 probe 验证 error 不抛。
					});
					send({
						type: "extension_inventory_data",
						reqId,
						ok: errors.length === 0,
						entries,
						...(errors.length > 0 ? { error: errors.join("; ") } : {}),
					});
				} catch (error) {
					send({
						type: "extension_inventory_data",
						reqId,
						ok: false,
						entries: [],
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})();
			return true;
		}
		case "plugin_catalog_sync": {
			const syncLang = () => cs?.getLang() ?? "en";
			const requestId = String(msg.requestId ?? "");
			void syncPluginCatalog(
				String(msg.source ?? ""),
				{ install: msg.install === true, replace: msg.replace === true },
				{
					customCatalogPath: pluginMgr.customCatalogPath,
					communityCatalogPath: pluginMgr.communityCatalogPath,
					pluginsDir: join(dataDir, "plugins"),
					installer: pluginInstaller,
					afterWrite: () => (msg.install === true ? reloadPluginsAndPush(syncLang) : pluginMgr.pushCatalog()),
					lang: syncLang,
					workspaceRoot: cs?.cwd ?? cwd,
					confirmInstall: (items) => confirmPluginInstallHelper(items),
				},
			).then((r) => {
				if (r.installRefused) {
					cs?.emitNotice?.(
						"warning",
						"目录已同步，但安装未获用户确认（拒绝或超时），未安装任何插件",
						"Catalog synced, but installation was not confirmed (denied or timed out) — nothing was installed",
					);
				}
				send({
					type: "plugin_catalog_sync_result",
					requestId,
					ok: r.ok,
					...(r.error ? { error: r.error } : {}),
					entries: pluginMgr.catalog(),
					...(r.installed ? { installed: r.installed } : {}),
				});
			});
			return true;
		}
		default:
			return false;
	}
}
