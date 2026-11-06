import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { DispatchSession } from "./index.js";
import { SchedulerValidationError, type SchedulerStore } from "./scheduler-tasks.js";
import { getGlobalRemoteSshService, isRemoteWorkspaceUri, type RemoteSshService } from "./remote-ssh-service.js";
import { prepareRemoteNativeCliPaste } from "./native-cli-remote-files.js";
import { remoteNativeCliCleanupQueue } from "./native-cli-remote-cleanup.js";
import { normalizePathKey } from "./client-state.js";
import { prepareNativeCliPaste, type NativeCliPasteContext } from "./native-cli.js";

export function handleFileMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "list_files":
			void cs.listFiles(msg.path);
			return true;
		case "search_files":
			void cs.searchFiles(msg.query, msg.reqId);
			return true;
		case "read_file":
			void cs.readFile(msg.path);
			return true;
		case "write_file":
			void cs.writeFile(msg.path, msg.text);
			return true;
		case "upload_file":
			void cs.uploadFile(msg.dirPath, msg.name, msg.data, msg.uploadId);
			return true;
		case "file_create":
			void cs.createEntry(msg.dir, msg.name, msg.kind);
			return true;
		case "file_rename":
			void cs.renameEntry(msg.path, msg.newName);
			return true;
		case "file_delete":
			void cs.deleteEntry(msg.path);
			return true;
		case "file_copy":
			void cs.copyEntry(msg.src, msg.destDir, msg.move);
			return true;
		case "file_reveal":
			void cs.revealEntry(msg.path);
			return true;
		case "file_open_default":
			void cs.openDefaultEntry(msg.path);
			return true;
		case "complete_path":
			void cs.completePath(msg.path);
			return true;
		case "make_dir":
			void cs.makeDir(msg.path, msg.setAsCwd === true);
			return true;
		case "set_cwd":
			void (async () => {
				try {
					await cs.setCwd(msg.path);
				} catch (err) {
					cs.emitNotice(
						"error",
						`切换工作目录失败：${(err as Error).message}`,
						`Failed to switch workspace: ${(err as Error).message}`,
					);
				}
			})();
			return true;
		case "set_workspace_roots":
			void (async () => {
				try {
					await cs.setWorkspaceRoots(msg.roots);
				} catch (err) {
					cs.emitNotice(
						"error",
						`设置额外工作区根失败：${(err as Error).message}`,
						`Failed to set workspace roots: ${(err as Error).message}`,
					);
				}
			})();
			return true;
		case "create_sandbox":
			void (async () => {
				try {
					await cs.createSandbox?.({
						name: msg.name,
						sourcePath: msg.sourcePath,
						ephemeral: msg.ephemeral,
					});
				} catch (err) {
					cs.emitNotice(
						"error",
						`创建沙盒失败：${(err as Error).message}`,
						`Failed to create sandbox: ${(err as Error).message}`,
					);
				}
			})();
			return true;
		case "reset_sandbox":
			void cs.resetSandbox?.(msg.path);
			return true;
		case "persist_sandbox":
			void cs.persistSandbox?.(msg.path);
			return true;
		case "promote_sandbox":
			void cs.promoteSandbox?.(msg.targetPath, msg.path, msg.switchToTarget);
			return true;
		case "diff_sandbox":
			void cs.diffSandbox?.(msg.path, msg.requestId);
			return true;
		case "apply_sandbox_to_source":
			void cs.applySandboxToSource?.(msg.path, msg.expectedRevision);
			return true;
		case "destroy_sandbox":
			void cs.destroySandbox?.(msg.path);
			return true;
		default:
			return false;
	}
}

export function handleScmMessage(msg: ClientMessage, cs: DispatchSession, send: (msg: ServerMessage) => void): boolean {
	switch (msg.type) {
		case "scm_status":
			void cs.scmQuery("status", msg.reqId);
			return true;
		case "scm_history":
			void cs.scmQuery("history", msg.reqId);
			return true;
		case "scm_filediff":
			void cs.scmQuery("filediff", msg.reqId, { path: msg.path });
			return true;
		case "scm_commit":
			void cs.scmQuery("commit", msg.reqId, { hash: msg.hash });
			return true;
		case "scm_commitmsg":
			if (typeof cs.scmGenCommitMessage === "function") {
				void cs.scmGenCommitMessage(msg.reqId);
			} else {
				send({
					type: "scm_data",
					reqId: msg.reqId,
					kind: "commitmsg",
					ok: false,
					error: "当前引擎不支持 AI 生成提交信息（请用 pi 引擎）/ AI commit messages need the pi engine",
				});
			}
			return true;
		case "refresh_worktrees":
			void cs.refreshWorktreeInfo?.();
			return true;
		case "switch_worktree":
			void cs.switchWorktree?.(msg.path);
			return true;
		case "remove_worktree":
			void cs.removeWorktree?.(msg.path, msg.force);
			return true;
		default:
			return false;
	}
}

export function handleBgServerMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "kill_background_server":
			void cs.killBackgroundServer(msg.port, msg.taskId);
			return true;
		case "kill_background_servers":
			void cs.killAllBackgroundServers();
			return true;
		case "list_bg_servers":
			void cs.listBgServers();
			return true;
		case "set_bg_keep":
			cs.setBackgroundKeep(msg.port, msg.keep);
			return true;
		case "clean_bg_leftovers":
			void cs.cleanBackgroundLeftovers((msg as { minutes?: number }).minutes);
			return true;
		default:
			return false;
	}
}

export function handlePresetAndDshMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "dsh_patches_list":
			void cs.listDshPatches?.();
			return true;
		case "dsh_preset_list":
			void cs.refreshAgentPresets?.();
			return true;
		case "dsh_preset_select":
			void cs.selectAgentPreset?.(msg.preset);
			return true;
		case "dsh_preset_default":
			void cs.setDefaultAgentPreset?.(msg.preset);
			return true;
		case "dsh_permission_set":
			void cs.setPermissionPreset?.(msg.preset);
			return true;
		case "dsh_permission_default":
			void cs.setDefaultPermissionPreset?.(msg.preset);
			return true;
		case "dsh_patches_rescan":
			void cs.rescanDshPatches?.();
			return true;
		case "dsh_patch_install":
			void cs.installDshPatch?.(msg.spec, msg.id);
			return true;
		case "dsh_patch_toggle":
			void cs.toggleDshPatch?.(msg.name, msg.enabled);
			return true;
		case "dsh_patch_delete":
			void cs.deleteDshPatch?.(msg.name);
			return true;
		case "dsh_market_fetch":
			void cs.fetchDshMarket?.(msg.force);
			return true;
		case "save_preset":
			void cs.savePreset(msg.name);
			return true;
		case "preset_export":
			void cs.exportPreset(msg);
			return true;
		case "preset_import":
			void cs.importPreset(msg);
			return true;
		case "preset_import_url":
			void cs.importPresetFromUrl(msg);
			return true;
		case "preset_catalog":
			void cs.pushPresetCatalog(msg);
			return true;
		case "preset_share":
			void cs.sharePreset(msg);
			return true;
		case "save_subagent_template":
			void cs.saveSubagentTemplate(msg.template);
			return true;
		case "delete_subagent_template":
			void cs.deleteSubagentTemplate(msg.name);
			return true;
		case "save_approval_rule":
			void cs.saveApprovalRule?.(msg.rule);
			return true;
		case "save_approval_rules":
			void cs.saveApprovalRules?.(msg.rules);
			return true;
		case "delete_approval_rule":
			void cs.deleteApprovalRule?.(msg.id);
			return true;
		case "reset_builtin_approval_rule":
			void cs.resetBuiltinApprovalRule?.(msg.id);
			return true;
		case "apply_preset":
			void cs.applyPreset(msg.name);
			return true;
		case "delete_preset":
			void cs.deletePreset(msg.name);
			return true;
		default:
			return false;
	}
}

export function handleModelAndProviderMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "list_models":
			void cs.listModels();
			return true;
		case "set_model":
			void cs.setModel(msg.modelId);
			return true;
		case "set_default_model":
			void cs.setDefaultModel?.(msg.modelId);
			return true;
		case "clear_default_model":
			cs.clearDefaultModel?.();
			return true;
		case "set_thinking":
			cs.setThinking(msg.level);
			return true;
		case "install_pi_agent":
			void cs.installPiAgent();
			return true;
		case "set_provider_api_key":
			void cs.setProviderApiKey(msg.provider, msg.apiKey);
			return true;
		case "clear_provider_api_key":
			void cs.clearProviderApiKey(msg.provider);
			return true;
		case "provider_oauth_start":
			cs.startProviderOAuth(msg.provider);
			return true;
		case "provider_oauth_reply":
			cs.replyProviderOAuth(msg.flowId, msg.promptId, msg.value);
			return true;
		case "provider_oauth_cancel":
			cs.cancelProviderOAuth(msg.flowId);
			return true;
		case "list_provider_oauth_flows":
			cs.listProviderOAuthFlows();
			return true;
		case "provider_oauth_logout":
			void cs.logoutProviderOAuth(msg.provider);
			return true;
		case "list_models_config":
			void cs.listModelsConfig();
			return true;
		case "reload_models_config":
			void cs.reloadModelsConfig();
			return true;
		case "save_model_config":
			void cs.saveModelConfig(msg.providerId, msg.config);
			return true;
		case "delete_model_config":
			void cs.deleteModelConfig(msg.providerId);
			return true;
		case "list_providers":
			void cs.listProviders();
			return true;
		case "fetch_models":
			void cs.fetchModelsList(msg.reqId, msg.baseUrl, msg.apiKey, msg.authHeader, msg.api, msg.providerId);
			return true;
		case "test_model_connection":
			void cs.testModelConnection?.(msg.reqId, msg.baseUrl, msg.apiKey, msg.authHeader, msg.api, msg.providerId);
			return true;
		case "refresh_provider_models":
			void cs.refreshProviderModels(msg.providerId, msg.reqId);
			return true;
		case "refresh_builtin_models":
			void cs.refreshBuiltinModels(msg.reqId);
			return true;
		case "append_builtin_model":
			void cs.appendBuiltinModel(msg.providerId, msg.model, msg.reqId);
			return true;
		case "clone_provider":
			void cs.cloneProvider(msg.provider, msg.reqId);
			return true;
		case "enrich_models":
			void cs.enrichModels(msg.reqId, msg.ids, msg.hints);
			return true;
		case "abort_enrich_models":
			cs.abortEnrichModels(msg.reqId);
			return true;
		case "list_provider_keys":
			cs.listProviderKeys();
			return true;
		case "add_provider_key":
			void cs.addProviderKey(msg.provider, msg.apiKey, msg.name);
			return true;
		case "activate_provider_key":
			void cs.activateProviderKey(msg.provider, msg.keyName);
			return true;
		case "remove_provider_key":
			void cs.removeProviderKey(msg.provider, msg.keyName);
			return true;
		default:
			return false;
	}
}

export function handleTerminalMessage(
	msg: ClientMessage,
	cs: DispatchSession,
	context?: NativeCliPasteContext,
): boolean {
	switch (msg.type) {
		case "terminal_attach": {
			const tm = cs.findTerminalManager
				? cs.findTerminalManager(msg.terminalId, msg.conversationId, msg.ownerKind)
				: msg.ownerKind === "client"
					? cs.getUserTerminalManager?.()
					: cs.getTerminalManager(msg.conversationId);
			tm?.attach?.(msg.terminalId, msg.cols, msg.rows);
			return true;
		}
		case "terminal_create": {
			const isAgentBash = msg.agentBash === true;
			const conversationOwned = msg.ownerKind === "conversation" || isAgentBash;
			const cli = conversationOwned ? cs.getNativeCliConversation?.(msg.conversationId) : undefined;
			if (
				msg.ownerKind === "conversation" &&
				!isAgentBash &&
				(!msg.conversationId || cli?.terminalId !== msg.terminalId)
			) {
				context?.send({
					type: "notice",
					level: "error",
					text: "CLI 终端不属于该对话",
					textEn: "CLI terminal does not belong to this conversation",
				});
				return true;
			}
			const nativeCli = cli?.terminalId === msg.terminalId ? cli.config : msg.nativeCli;
			const tm = conversationOwned
				? cs.getTerminalManager(msg.conversationId)
				: (cs.getUserTerminalManager?.() ?? cs.getTerminalManager(msg.conversationId));
			if (tm) {
				const createOpts =
					msg.locale !== undefined || msg.agentBash !== undefined || nativeCli !== undefined
						? {
								locale: msg.locale,
								agentBash: msg.agentBash,
								...(nativeCli !== undefined ? { nativeCli } : {}),
							}
						: undefined;
				const create = nativeCli && tm.createNativeCli ? tm.createNativeCli.bind(tm) : tm.create.bind(tm);
				void create(
					msg.terminalId,
					cli ? cs.getTerminalCwd(msg.conversationId) : msg.cwd,
					msg.cols,
					msg.rows,
					cs.getTerminalCwd(msg.conversationId),
					msg.title,
					createOpts,
				);
			}
			return true;
		}
		case "terminal_cli_control": {
			if (!context) return true;
			void (async () => {
				try {
					if (
						typeof msg.requestId !== "string" ||
						!msg.requestId ||
						msg.requestId.length > 128 ||
						/[\x00-\x1f\x7f-\x9f]/.test(msg.requestId)
					)
						throw new Error("Invalid CLI control request ID");
					if (
						msg.ownerKind !== "conversation" ||
						typeof msg.conversationId !== "string" ||
						!["detach", "reconnect", "stop"].includes(msg.action)
					)
						throw new Error("Invalid CLI control target or action");
					const cli = cs.getNativeCliConversation?.(msg.conversationId);
					if (!cli || cli.terminalId !== msg.terminalId || !cs.controlNativeCli)
						throw new Error("CLI terminal does not belong to this conversation");
					await cs.controlNativeCli(msg.conversationId, msg.terminalId, msg.action);
					context.send({
						type: "terminal_cli_control_result",
						requestId: msg.requestId,
						terminalId: msg.terminalId,
						conversationId: msg.conversationId,
						ok: true,
					});
				} catch (error) {
					context.send({
						type: "terminal_cli_control_result",
						requestId: msg.requestId,
						terminalId: msg.terminalId,
						conversationId: msg.conversationId,
						ok: false,
						error: (error as Error).message,
					});
				}
			})();
			return true;
		}
		case "terminal_cli_paste": {
			if (!context) return true;
			void (async () => {
				let cleanup: (() => Promise<void>) | undefined;
				let cleanupRetained = false;
				let stagedPaths: readonly string[] | undefined;
				let remoteService: RemoteSshService | null = null;
				let remoteCwd: string | undefined;
				try {
					if (
						typeof msg.requestId !== "string" ||
						!msg.requestId ||
						msg.requestId.length > 128 ||
						/[\x00-\x1f\x7f-\x9f]/.test(msg.requestId)
					)
						throw new Error("Invalid native CLI paste request ID");
					const tm = cs.findTerminalManager
						? cs.findTerminalManager(msg.terminalId, msg.conversationId, msg.ownerKind)
						: msg.ownerKind === "client"
							? cs.getUserTerminalManager?.()
							: cs.getTerminalManager(msg.conversationId);
					const captured = tm?.captureNativeCliPasteTarget?.(msg.terminalId);
					const target = captured ?? tm?.getNativeCliTerminal?.(msg.terminalId);
					if (!target) throw new Error("Native CLI terminal not found or its process has exited");
					if (msg.attachments !== undefined && (!Array.isArray(msg.attachments) || msg.attachments.length > 32))
						throw new Error("Invalid native CLI attachments (max 32)");
					if (context.materializeAttachments && !captured)
						throw new Error("Native CLI process identity cannot be captured");
					const attachments = context.materializeAttachments
						? await context.materializeAttachments(msg.attachments ?? [], msg.conversationId, msg.data)
						: msg.attachments;
					if (captured?.signal?.aborted)
						throw new Error("Native CLI terminal exited or was restarted before this prompt was ready");
					let text: string;
					if (isRemoteWorkspaceUri(target.cwd)) {
						remoteCwd = target.cwd;
						remoteService = getGlobalRemoteSshService();
						if (!remoteService || !captured?.retainCleanup) throw new Error("Remote CLI file service is unavailable");
						const service = remoteService;
						const prepared = await prepareRemoteNativeCliPaste(
							{
								cwd: target.cwd,
								clientId: context.clientId,
								dataDir: context.dataDir,
								settings: context.settings,
								service,
								signal: captured.signal,
								onCleanupFailure: (paths) => remoteNativeCliCleanupQueue.enqueue(service, target.cwd, paths),
							},
							msg.data,
							attachments ?? [],
						);
						text = prepared.text;
						stagedPaths = prepared.paths;
						cleanup = async () => {
							try {
								await prepared.dispose();
							} catch {
								remoteNativeCliCleanupQueue.enqueue(service, target.cwd, prepared.paths);
							}
						};
					} else text = prepareNativeCliPaste(msg.data, attachments, target.cwd, context);
					if (cleanup) {
						cleanupRetained = captured!.retainCleanup!(cleanup, stagedPaths);
						if (!cleanupRetained) throw new Error("Native CLI exited before uploaded references could be retained");
					}
					const pasted = captured ? captured.paste(text) : tm?.pasteNativeCli?.(msg.terminalId, text);
					if (!pasted) {
						cleanupRetained = false;
						throw new Error("Native CLI terminal exited or was restarted before this prompt was ready");
					}
					context.send({
						type: "terminal_cli_paste_result",
						requestId: msg.requestId,
						terminalId: msg.terminalId,
						ok: true,
					});
				} catch (err) {
					const paths = (err as { paths?: unknown }).paths;
					if (remoteService && remoteCwd && Array.isArray(paths) && paths.every((path) => typeof path === "string"))
						remoteNativeCliCleanupQueue.enqueue(remoteService, remoteCwd, paths);
					context.send({
						type: "terminal_cli_paste_result",
						requestId: msg.requestId,
						terminalId: msg.terminalId,
						ok: false,
						error: (err as Error).message,
					});
				} finally {
					if (cleanup && !cleanupRetained) await cleanup();
				}
			})();
			return true;
		}
		case "terminal_input": {
			const tm = cs.findTerminalManager
				? cs.findTerminalManager(msg.terminalId, msg.conversationId, msg.ownerKind)
				: cs.getTerminalManager(msg.conversationId);
			tm?.input(msg.terminalId, msg.data);
			return true;
		}
		case "terminal_resize": {
			const tm = cs.findTerminalManager
				? cs.findTerminalManager(msg.terminalId, msg.conversationId, msg.ownerKind)
				: cs.getTerminalManager(msg.conversationId);
			tm?.resize(msg.terminalId, msg.cols, msg.rows);
			return true;
		}
		case "terminal_kill": {
			const tm = cs.findTerminalManager
				? cs.findTerminalManager(msg.terminalId, msg.conversationId, msg.ownerKind)
				: cs.getTerminalManager(msg.conversationId);
			tm?.kill(msg.terminalId);
			return true;
		}
		case "rename_terminal": {
			const tm = cs.findTerminalManager
				? cs.findTerminalManager(msg.terminalId, msg.conversationId, msg.ownerKind)
				: cs.getTerminalManager(msg.conversationId);
			tm?.rename(msg.terminalId, msg.title);
			return true;
		}
		case "run_command": {
			const tm = cs.getUserTerminalManager?.() ?? cs.getTerminalManager(msg.conversationId);
			tm?.runCommand(msg.terminalId, msg.command, msg.cols, msg.rows, cs.getTerminalCwd(msg.conversationId));
			return true;
		}
		default:
			return false;
	}
}

export function handleSessionLifecycleMessage(
	msg: ClientMessage,
	cs: DispatchSession,
	send?: (message: ServerMessage) => void,
	daemon?: {
		dismissConversation?: (
			clientId: string,
			msg: { id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string },
		) => Promise<boolean>;
	},
	clientId?: string,
): boolean {
	switch (msg.type) {
		case "new_chat":
		case "new_cli_chat": {
			let acknowledged = false;
			const acknowledge = (conversationId?: string) => {
				if (!msg.requestId || acknowledged) return;
				acknowledged = true;
				send?.({
					type: "new_chat_result",
					requestId: msg.requestId,
					ok: !!conversationId,
					...(conversationId ? { conversationId } : {}),
				});
			};
			if (msg.type === "new_cli_chat" && !cs.newCliChat) {
				send?.({
					type: "notice",
					level: "error",
					text: "当前会话引擎尚不支持独立 CLI 对话；请在标准 Pi 会话宿主中创建",
					textEn:
						"This conversation engine does not support independent CLI conversations yet; create one in the standard Pi session host",
				});
				acknowledge();
				return true;
			}
			const pending =
				msg.type === "new_cli_chat"
					? cs.newCliChat?.(msg.config, msg.cwd, acknowledge)
					: cs.newChat(msg.preset, msg.ephemeral, acknowledge, msg.independent);
			void Promise.resolve(pending)
				.then(() => acknowledge())
				.catch(() => acknowledge());
			return true;
		}
		case "delete_message":
			if (cs.deleteMessage) void cs.deleteMessage(msg.messageId, msg.conversationId);
			else
				send?.({
					type: "notice",
					level: "error",
					text: "当前引擎不支持删除消息",
					textEn: "This engine does not support message deletion",
				});
			return true;
		case "edit_message":
			void cs.editMessage(msg.messageId, msg.text, msg.attachments);
			return true;
		case "fork_session":
			void cs.forkSession?.(msg.messageId, msg.position, msg.conversationId);
			return true;
		case "rollback_session":
			void cs.rollbackSession?.(msg.messageId, msg.conversationId, msg.restoreWorkspace);
			return true;
		case "list_sessions":
			if (typeof msg.limit === "number") cs.setSessionListLimit?.(msg.path ?? cs.cwd, msg.limit);
			if (msg.path && normalizePathKey(msg.path) !== normalizePathKey(cs.cwd)) {
				void cs.pushSessionsForCwd?.(msg.path);
			} else {
				void cs.refreshSessions();
			}
			return true;
		case "list_projects":
			void cs.pushProjects();
			return true;
		case "remove_project":
			void cs.removeProject(msg.path);
			return true;
		case "delete_session":
			void cs.deleteSession(msg.path);
			return true;
		case "rename_session":
			void cs.renameSession(msg.path, msg.name);
			return true;
		case "rename_conversation":
			void cs.renameConversation(msg.id, msg.name);
			return true;
		case "dismiss_conversation":
			if (clientId && daemon?.dismissConversation) {
				void daemon.dismissConversation(clientId, msg);
			} else {
				void cs.dismissConversation(msg.id, msg.withFinishedSubagents, msg.force);
			}
			return true;
		case "persist_conversation":
			void cs.persistConversation?.(msg.id);
			return true;
		case "pin_conversation":
			void cs.setConversationPinned?.(msg.id, msg.pinned);
			return true;
		case "pin_session":
			void cs.pinSession?.(msg.path, msg.pinned);
			return true;
		case "dismiss_finished_subagents":
			void cs.dismissFinishedSubagents(msg.parentId);
			return true;
		case "switch_session":
			void cs.switchSession(msg.path, msg.sessionId, msg.independent);
			return true;
		case "switch_conversation":
			void cs.switchConversation(msg.id);
			return true;
		case "search_sessions":
			void cs.searchSessions(msg.query, msg.reqId);
			return true;
		case "get_compacted_messages":
			void cs.getCompactedMessages?.(msg.compactionMessageId, msg.conversationId);
			return true;
		default:
			return false;
	}
}

export function handlePlanAndGoalMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "set_goal":
			void cs.setGoal(msg.goal, {
				reviewModel: msg.reviewModel,
				maxRounds: msg.maxRounds,
				locked: msg.locked,
				execModel: msg.execModel,
			});
			return true;
		case "clear_goal":
			void cs.clearGoal();
			return true;
		case "start_goal_wizard":
			void cs.startGoalWizard(msg.text, {
				wizardModel: msg.wizardModel,
				maxRounds: msg.maxRounds,
				locked: msg.locked,
			});
			return true;
		case "set_goal_prefs":
			void cs.setGoalPrefs({
				reviewModel: msg.reviewModel,
				maxRounds: msg.maxRounds,
				locked: msg.locked,
				execModel: msg.execModel,
			});
			return true;
		case "plan_update":
			cs.updatePlan?.(msg.steps, msg.activeStepId, msg.conversationId);
			return true;
		case "plan_step_update":
			cs.updatePlanStep?.(msg.stepId, msg.patch, msg.conversationId);
			return true;
		case "plan_step_delete":
			cs.deletePlanStep?.(msg.stepId, msg.conversationId);
			return true;
		case "plan_step_add":
			cs.addPlanStep?.(msg.step, msg.afterStepId, msg.conversationId);
			return true;
		case "plan_clean_handoff":
			void cs.planCleanHandoff?.(msg.steps, msg.prompt);
			return true;
		case "set_plan_mode":
			void cs.setPlanMode?.(msg.enabled, msg.conversationId);
			return true;
		case "set_delegate_mode":
			void cs.setDelegateMode?.(msg.enabled, msg.conversationId);
			return true;
		default:
			return false;
	}
}

export function handleScheduleMessage(
	msg: ClientMessage,
	scheduler: SchedulerStore,
	send: (msg: ServerMessage) => void,
): boolean {
	switch (msg.type) {
		case "schedule_list":
			try {
				send({ type: "scheduler_tasks", tasks: scheduler.list() });
			} catch (err) {
				send({
					type: "notice",
					level: "error",
					text: `读取定时任务失败：${(err as Error).message}`,
					textEn: `Failed to list scheduled tasks: ${(err as Error).message}`,
				});
			}
			return true;
		case "schedule_save":
			try {
				scheduler.upsert(msg.task);
			} catch (err) {
				const isVal = err instanceof SchedulerValidationError;
				send({
					type: "notice",
					level: "error",
					text: `保存定时任务失败：${isVal ? err.messageZh : (err as Error).message}`,
					textEn: `Failed to save scheduled task: ${isVal ? err.messageEn : (err as Error).message}`,
				});
			}
			return true;
		case "schedule_delete":
		case "schedule_toggle":
			try {
				const found =
					msg.type === "schedule_delete"
						? scheduler.remove(msg.id)
						: scheduler.setEnabled(msg.id, msg.enabled === true);
				if (!found) {
					send({
						type: "notice",
						level: "warning",
						text: `定时任务不存在：${msg.id}`,
						textEn: `No such scheduled task: ${msg.id}`,
					});
				}
			} catch (err) {
				send({
					type: "notice",
					level: "error",
					text: `更新定时任务失败：${(err as Error).message}`,
					textEn: `Failed to update scheduled task: ${(err as Error).message}`,
				});
			}
			return true;
		case "schedule_run":
			void scheduler
				.runNow(msg.id)
				.then((r) => {
					if (!r.ok)
						send({
							type: "notice",
							level: "warning",
							text: `定时任务手动触发失败：${r.error ?? "未知错误"}`,
							textEn: `Manual scheduled-task run failed: ${r.error ?? "unknown error"}`,
						});
				})
				.catch((err) => console.error("[scheduler] manual run failed:", err));
			return true;
		default:
			return false;
	}
}

export function handleSettingsMessage(
	msg: ClientMessage,
	cs: DispatchSession,
	send?: (message: ServerMessage) => void,
): boolean {
	switch (msg.type) {
		case "list_commands":
			void cs.listCommands();
			return true;
		case "save_commands":
			void cs.saveCommands(msg.commands);
			return true;
		case "get_settings":
			cs.refreshSettings();
			return true;
		case "set_settings":
			void (cs as unknown as { setSettings: (p: Record<string, unknown>) => Promise<void> }).setSettings({
				promptMode: msg.promptMode,
				customSystemPrompt: msg.customSystemPrompt,
				promptTemplate: (msg as { promptTemplate?: string }).promptTemplate,
				promptOverrides: (msg as { promptOverrides?: Record<string, string> }).promptOverrides,
				promptDisabled: (msg as { promptDisabled?: string[] }).promptDisabled,
				toolPromptOverrides: (msg as { toolPromptOverrides?: Record<string, unknown> }).toolPromptOverrides,
				disabledSkills: msg.disabledSkills,
				disabledExtensions: msg.disabledExtensions,
				disabledAgentTools: msg.disabledAgentTools,
				disabledPluginTools: (msg as { disabledPluginTools?: string[] }).disabledPluginTools,
				disabledPlugins: msg.disabledPlugins,
				terminalToolsEnabled: msg.terminalToolsEnabled,
				nativeCliInheritModel: msg.nativeCliInheritModel,
				terminalBash: msg.terminalBash,
				terminalBashIdleMs: msg.terminalBashIdleMs,
				terminalBashMaxForegroundMs: (msg as { terminalBashMaxForegroundMs?: number }).terminalBashMaxForegroundMs,
				toolWatchdogTimeoutMs: (msg as { toolWatchdogTimeoutMs?: number }).toolWatchdogTimeoutMs,
				readDirEnabled: (msg as { readDirEnabled?: boolean }).readDirEnabled,
				bgAutoCleanupMin: (msg as { bgAutoCleanupMin?: number }).bgAutoCleanupMin,
				toolLazyLoading: (msg as { toolLazyLoading?: boolean }).toolLazyLoading,
				toolApprovalEnabled: (msg as { toolApprovalEnabled?: boolean }).toolApprovalEnabled,
				editSoftEnabled: (msg as { editSoftEnabled?: boolean }).editSoftEnabled,
				questionnaireEnabled: (msg as { questionnaireEnabled?: boolean }).questionnaireEnabled,
				questionPresentation: msg.questionPresentation,
				toolApprovalPresentation: msg.toolApprovalPresentation,
				questionTimeoutSeconds: msg.questionTimeoutSeconds,
				parallelReminderEnabled: (msg as { parallelReminderEnabled?: boolean }).parallelReminderEnabled,
				goalModeEnabled: (msg as { goalModeEnabled?: boolean }).goalModeEnabled,
				thinkingWrap: msg.thinkingWrap,
				toolsWrap: msg.toolsWrap,
				toolImagesEnabled: (msg as { toolImagesEnabled?: boolean }).toolImagesEnabled,
				keepRecentMessages: (msg as { keepRecentMessages?: number }).keepRecentMessages,
				reversePagination: (msg as { reversePagination?: boolean }).reversePagination,
				showForkedParentSessions: (msg as { showForkedParentSessions?: boolean }).showForkedParentSessions,
				retainFinishedConversations: msg.retainFinishedConversations,
				openRecentSessionOnProjectSwitch: msg.openRecentSessionOnProjectSwitch,
				devNoCache: (msg as { devNoCache?: boolean }).devNoCache,
				autoReload: (msg as { autoReload?: boolean }).autoReload,
				skillsFullText: (msg as { skillsFullText?: string[] }).skillsFullText,
				skillsCatalogMaxDesc: msg.skillsCatalogMaxDesc,
				skillsCatalogShowLocation: msg.skillsCatalogShowLocation,
				skillsCatalogBudget: msg.skillsCatalogBudget,
				skillsMaxFileBytes: msg.skillsMaxFileBytes,
				skillsFullTextMaxBytes: msg.skillsFullTextMaxBytes,
				codemodeMode: msg.codemodeMode,
				codemodeInlineBudget: msg.codemodeInlineBudget,
				visionBridgeEnabled: msg.visionBridgeEnabled,
				visionBridgeModel: msg.visionBridgeModel,
				visionBridgePromptMode: msg.visionBridgePromptMode,
				visionBridgePrompt: msg.visionBridgePrompt,
				quickAskEnabled: msg.quickAskEnabled,
				quickAskModel: msg.quickAskModel,
				quickAskThinking: msg.quickAskThinking,
				quickAskSystemPrompt: msg.quickAskSystemPrompt,
				quickAskExplainPrompt: msg.quickAskExplainPrompt,
				quickAskTranslateEnabled: msg.quickAskTranslateEnabled,
				quickAskTranslateTarget: msg.quickAskTranslateTarget,
				quickAskTranslateStyle: msg.quickAskTranslateStyle,
				quickAskTranslatePrompt: msg.quickAskTranslatePrompt,
				quickAskShowOriginal: msg.quickAskShowOriginal,
				quickAskReferenceMenus: msg.quickAskReferenceMenus,
				quickAskConversationScope: msg.quickAskConversationScope,
				quickAskFolderScope: msg.quickAskFolderScope,
				subagentDefaultModel: (msg as { subagentDefaultModel?: string | null }).subagentDefaultModel,
				subagentMaxDepth: (msg as { subagentMaxDepth?: number }).subagentMaxDepth,
				subagentAutoWakeMaxTurns: (msg as { subagentAutoWakeMaxTurns?: number }).subagentAutoWakeMaxTurns,
				retryMaxAttempts: (msg as { retryMaxAttempts?: number }).retryMaxAttempts,
				softCapTokens: (msg as { softCapTokens?: number }).softCapTokens,
				softCapByModel: (msg as { softCapByModel?: Record<string, number> }).softCapByModel,
				autoCompactionInstructions: (msg as { autoCompactionInstructions?: string }).autoCompactionInstructions,
				reviewPrompt: msg.reviewPrompt,
				reviewDisabledSkills: msg.reviewDisabledSkills,
				markersEnabled: (msg as { markersEnabled?: boolean }).markersEnabled,
				disabledMarkers: (msg as { disabledMarkers?: string[] }).disabledMarkers,
				quickPhrases: (msg as { quickPhrases?: string[] }).quickPhrases,
				quickPhrasesEnabled: (msg as { quickPhrasesEnabled?: boolean }).quickPhrasesEnabled,
				minimalNewChat: (msg as { minimalNewChat?: boolean }).minimalNewChat,
				preserveDraftAcrossConversations: (msg as { preserveDraftAcrossConversations?: boolean })
					.preserveDraftAcrossConversations,
				quickPhrasesSeeded: (msg as { quickPhrasesSeeded?: boolean }).quickPhrasesSeeded,
				uiLayout: (msg as { uiLayout?: unknown }).uiLayout,
			});
			return true;
		case "extensions_reload":
			void cs.reloadExtensions();
			return true;
		case "mcp_oauth_start":
		case "mcp_oauth_finish":
		case "mcp_oauth_status":
		case "mcp_oauth_cancel":
			if (cs.handleMcpOAuth) void cs.handleMcpOAuth(msg);
			else
				send?.({
					type: "mcp_oauth_result",
					reqId: msg.reqId,
					status: "error",
					error: "MCP OAuth is unavailable in this session.",
				});
			return true;
		case "save_mcp_server":
			void cs.saveMcpServer?.(msg.server, msg.prevName, msg.prevScope);
			return true;
		case "delete_mcp_server":
			void cs.deleteMcpServer?.(msg.name, msg.scope);
			return true;
		case "toggle_mcp_server":
			void cs.toggleMcpServer?.(msg.name, msg.scope, msg.enabled);
			return true;
		case "reload_mcp":
			void cs.reloadMcp?.();
			return true;
		case "install_skill":
			void cs.installSkill?.(msg.name, msg.scope, msg.content);
			return true;
		case "uninstall_skill":
			void cs.uninstallSkill?.(msg.name, msg.scope);
			return true;
		case "fetch_mcp_market":
			void cs.fetchMcpMarket?.(msg.source, msg.query, msg.page, msg.refresh);
			return true;
		case "fetch_skill_market":
			void cs.fetchSkillMarket?.(msg.repo, msg.refresh);
			return true;
		case "fetch_skill_content":
			void cs.fetchSkillContent?.(msg.repo, msg.skillId);
			return true;
		default:
			return false;
	}
}

export function handleInteractiveResponseMessage(
	msg: ClientMessage,
	cs: DispatchSession,
	service: {
		resolveSharedQuestion?: (
			viewerId: string,
			id: string,
			answers: { id: string; selected: string[]; custom?: string }[],
			cancelled?: boolean,
			cancelReason?: string,
		) => boolean;
		resolveSharedToolApproval?: (
			viewerId: string,
			...args: Parameters<NonNullable<DispatchSession["resolveToolApproval"]>>
		) => boolean;
		resolveGlobalQuestion?: (
			id: string,
			answers: { id: string; selected: string[]; custom?: string }[],
			cancelled?: boolean,
			cancelReason?: string,
		) => boolean;
		answerElsewhereQuestion?: (
			clientId: string,
			owner: string,
			id: string,
			answers: { id: string; selected: string[]; custom?: string }[],
			cancelled?: boolean,
			cancelReason?: string,
		) => Promise<void>;
	},
	clientId: string | undefined,
	send: (msg: ServerMessage) => void,
): boolean {
	switch (msg.type) {
		case "dialog_response":
			cs.resolveDialog(msg.id, msg.value);
			return true;
		case "tui_overlay_input":
			cs.handleTuiOverlayInput?.(msg.id, msg.data);
			return true;
		case "tui_overlay_resize":
			cs.handleTuiOverlayResize?.(msg.id, msg.cols, msg.rows);
			return true;
		case "tui_overlay_cancel":
			cs.handleTuiOverlayCancel?.(msg.id);
			return true;
		case "question_answer":
			if (clientId && service.resolveSharedQuestion?.(clientId, msg.id, msg.answers, msg.cancelled, msg.cancelReason))
				return true;
			if (cs.resolveQuestion?.(msg.id, msg.answers, msg.cancelled, msg.cancelReason)) return true;
			if (service.resolveGlobalQuestion?.(msg.id, msg.answers, msg.cancelled, msg.cancelReason)) return true;
			if (msg.owner) {
				if (typeof service.answerElsewhereQuestion === "function" && clientId) {
					void service.answerElsewhereQuestion(
						clientId,
						msg.owner,
						msg.id,
						msg.answers,
						msg.cancelled,
						msg.cancelReason,
					);
				} else {
					send({
						type: "notice",
						level: "error",
						text: "当前引擎不支持跨页作答，请用 pi 引擎",
						textEn: "Cross-page answering is not supported by the current engine; use the pi engine.",
					});
				}
			} else {
				void cs.answerQuestion?.(msg.id, msg.answers, msg.cancelled, msg.cancelReason);
			}
			return true;
		case "tool_approval_response":
			if (
				clientId &&
				service.resolveSharedToolApproval?.(clientId, msg.id, msg.decision, msg.editedParams, msg.reason, msg.scope)
			)
				return true;
			cs.resolveToolApproval?.(msg.id, msg.decision, msg.editedParams, msg.reason, msg.scope);
			return true;
		case "set_approval_policy":
			cs.setApprovalPolicy?.({
				conversationId: msg.conversationId,
				allowAll: msg.allowAll,
				categories: msg.categories,
			});
			return true;
		case "page_response":
			cs.resolvePageCall?.(msg.id, msg.ok, msg.result, msg.error);
			return true;
		default:
			return false;
	}
}

export function handleRemoteSshMessage(
	msg: ClientMessage,
	remoteSshSvc: RemoteSshService,
	send: (msg: ServerMessage) => void,
): boolean {
	switch (msg.type) {
		case "remote_ssh_probe":
			void (async () => {
				const res = await remoteSshSvc.probe(msg.params);
				send({
					type: "remote_ssh_probe_result",
					reqId: msg.reqId,
					...res,
				});
			})();
			return true;
		case "remote_ssh_list_dir":
			void (async () => {
				const res = await remoteSshSvc.listDir(msg.connectionId, msg.path);
				send({
					type: "remote_ssh_list_dir_result",
					reqId: msg.reqId,
					...res,
				});
			})();
			return true;
		case "remote_ssh_install_tools":
			void (async () => {
				const res = await remoteSshSvc.installTools(msg.connectionId, msg.tools);
				send({
					type: "remote_ssh_install_result",
					reqId: msg.reqId,
					...res,
				});
			})();
			return true;
		case "remote_ssh_list_profiles":
			void (async () => {
				const profiles = await remoteSshSvc.listProfiles();
				send({
					type: "remote_ssh_profiles_result",
					reqId: msg.reqId,
					profiles,
				});
			})();
			return true;
		case "remote_ssh_delete_profile":
			void (async () => {
				await remoteSshSvc.deleteProfile(msg.name);
				const profiles = await remoteSshSvc.listProfiles();
				send({
					type: "remote_ssh_profiles_result",
					profiles,
				});
			})();
			return true;
		default:
			return false;
	}
}
