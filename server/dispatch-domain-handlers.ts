/**
 * dispatch-domain-handlers — WebSocket 客户端消息的领域分发路由处理器。
 *
 * 将 server/index.ts 中千行单体 switch-case 按业务领域横向解耦拆分：
 * - handleFileMessage: 文件树浏览、读写、检索、创建/重命名/删除/复制/路径补全、工作区根设置
 * - handleScmMessage: Git 状态查询、提交历史、文件差异、AI 提交信息生成
 * - handleBgServerMessage: 后台常驻服务管理与端口清理
 * - handlePresetAndDshMessage: 预设管理与分享、DSH 预设/补丁切换、审批规则与子代理模板持久化
 */
import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { DispatchSession } from "./index.js";
import { SchedulerValidationError, type SchedulerStore } from "./scheduler-tasks.js";

/** 文件与工作区相关操作 */
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
			void cs.uploadFile(msg.dirPath, msg.name, msg.data);
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
			void cs.setCwd(msg.path);
			return true;
		case "set_workspace_roots":
			void cs.setWorkspaceRoots(msg.roots);
			return true;
		default:
			return false;
	}
}

/** Git / SCM 相关操作 */
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
		default:
			return false;
	}
}

/** 后台常驻任务与端口管理 */
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

/** 预设分享、DSH 预设与补丁、审批规则及模板持久化 */
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

/** 模型管理、供应商配置、OAuth 及 API Key 相关操作 */
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

/** 终端 (PTY) 管理与输入控制 */
export function handleTerminalMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "terminal_create": {
			const tm = cs.getTerminalManager(msg.conversationId);
			if (tm) {
				const createOpts =
					msg.locale !== undefined || msg.agentBash !== undefined
						? { locale: msg.locale, agentBash: msg.agentBash }
						: undefined;
				tm.create(
					msg.terminalId,
					msg.cwd,
					msg.cols,
					msg.rows,
					cs.getTerminalCwd(msg.conversationId),
					msg.title,
					createOpts,
				);
			}
			return true;
		}
		case "terminal_input":
			cs.getTerminalManager(msg.conversationId)?.input(msg.terminalId, msg.data);
			return true;
		case "terminal_resize":
			cs.getTerminalManager(msg.conversationId)?.resize(msg.terminalId, msg.cols, msg.rows);
			return true;
		case "terminal_kill":
			cs.getTerminalManager(msg.conversationId)?.kill(msg.terminalId);
			return true;
		case "rename_terminal":
			cs.getTerminalManager(msg.conversationId)?.rename(msg.terminalId, msg.title);
			return true;
		case "run_command":
			cs.getTerminalManager(msg.conversationId)?.runCommand(
				msg.terminalId,
				msg.command,
				msg.cols,
				msg.rows,
				cs.getTerminalCwd(msg.conversationId),
			);
			return true;
		default:
			return false;
	}
}

/** 会话生命周期与分支管理相关操作 */
export function handleSessionLifecycleMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "new_chat":
			void cs.newChat(msg.preset, msg.ephemeral);
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
			void cs.refreshSessions();
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
			void cs.dismissConversation(msg.id, msg.withFinishedSubagents, msg.force);
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
			void cs.switchSession(msg.path, msg.sessionId);
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

/** 任务执行计划（Plan Mode）与目标模式（Goal Mode）相关操作 */
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

/** 定时任务（Scheduler）相关操作 */
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
			if (!scheduler.remove(msg.id)) {
				send({
					type: "notice",
					level: "warning",
					text: `定时任务不存在：${msg.id}`,
					textEn: `No such scheduled task: ${msg.id}`,
				});
			}
			return true;
		case "schedule_run":
			void scheduler.runNow(msg.id).then((r) => {
				if (!r.ok)
					send({
						type: "notice",
						level: "warning",
						text: `定时任务手动触发失败：${r.error ?? "未知错误"}`,
						textEn: `Manual scheduled-task run failed: ${r.error ?? "unknown error"}`,
					});
			});
			return true;
		case "schedule_toggle":
			if (!scheduler.setEnabled(msg.id, msg.enabled === true)) {
				send({
					type: "notice",
					level: "warning",
					text: `定时任务不存在：${msg.id}`,
					textEn: `No such scheduled task: ${msg.id}`,
				});
			}
			return true;
		default:
			return false;
	}
}

/** 设置面板、自定义斜杠命令与扩展重载相关操作 */
export function handleSettingsMessage(msg: ClientMessage, cs: DispatchSession): boolean {
	switch (msg.type) {
		case "list_commands":
			void cs.listCommands();
			return true;
		case "save_commands":
			void cs.saveCommands(msg.commands);
			return true;
		case "get_settings":
			cs.pushSettings();
			return true;
		case "set_settings":
			// SAFETY: Both dispatch engines validate the explicitly enumerated settings fields below.
			void (cs as unknown as { setSettings: (p: Record<string, unknown>) => Promise<void> }).setSettings({
				promptMode: msg.promptMode,
				customSystemPrompt: msg.customSystemPrompt,
				promptTemplate: (msg as { promptTemplate?: string }).promptTemplate,
				promptOverrides: (msg as { promptOverrides?: Record<string, string> }).promptOverrides,
				toolPromptOverrides: (msg as { toolPromptOverrides?: Record<string, unknown> }).toolPromptOverrides,
				disabledSkills: msg.disabledSkills,
				disabledExtensions: msg.disabledExtensions,
				disabledAgentTools: msg.disabledAgentTools,
				disabledPluginTools: (msg as { disabledPluginTools?: string[] }).disabledPluginTools,
				disabledPlugins: msg.disabledPlugins,
				terminalToolsEnabled: msg.terminalToolsEnabled,
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
				parallelReminderEnabled: (msg as { parallelReminderEnabled?: boolean }).parallelReminderEnabled,
				goalModeEnabled: (msg as { goalModeEnabled?: boolean }).goalModeEnabled,
				thinkingWrap: msg.thinkingWrap,
				toolsWrap: msg.toolsWrap,
				toolImagesEnabled: (msg as { toolImagesEnabled?: boolean }).toolImagesEnabled,
				keepRecentMessages: (msg as { keepRecentMessages?: number }).keepRecentMessages,
				devNoCache: (msg as { devNoCache?: boolean }).devNoCache,
				autoReload: (msg as { autoReload?: boolean }).autoReload,
				skillsFullText: (msg as { skillsFullText?: string[] }).skillsFullText,
				visionBridgeEnabled: msg.visionBridgeEnabled,
				visionBridgeModel: msg.visionBridgeModel,
				visionBridgePromptMode: msg.visionBridgePromptMode,
				visionBridgePrompt: msg.visionBridgePrompt,
				subagentDefaultModel: (msg as { subagentDefaultModel?: string | null }).subagentDefaultModel,
				retryMaxAttempts: (msg as { retryMaxAttempts?: number }).retryMaxAttempts,
				softCapTokens: (msg as { softCapTokens?: number }).softCapTokens,
				softCapByModel: (msg as { softCapByModel?: Record<string, number> }).softCapByModel,
				reviewPrompt: msg.reviewPrompt,
				reviewDisabledSkills: msg.reviewDisabledSkills,
				markersEnabled: (msg as { markersEnabled?: boolean }).markersEnabled,
				disabledMarkers: (msg as { disabledMarkers?: string[] }).disabledMarkers,
				quickPhrases: (msg as { quickPhrases?: string[] }).quickPhrases,
				quickPhrasesEnabled: (msg as { quickPhrasesEnabled?: boolean }).quickPhrasesEnabled,
				quickPhrasesSeeded: (msg as { quickPhrasesSeeded?: boolean }).quickPhrasesSeeded,
				uiLayout: (msg as { uiLayout?: unknown }).uiLayout,
			});
			return true;
		case "extensions_reload":
			void cs.reloadExtensions();
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

/** 人机交互弹窗应答、审批授权响应、策略配置与浏览器页面调用回包 */
export function handleInteractiveResponseMessage(
	msg: ClientMessage,
	cs: DispatchSession,
	service: {
		answerElsewhereQuestion?: (
			clientId: string,
			owner: string,
			id: string,
			answers: { id: string; selected: string[]; custom?: string }[],
			cancelled?: boolean,
		) => Promise<void>;
	},
	clientId: string | undefined,
	send: (msg: ServerMessage) => void,
): boolean {
	switch (msg.type) {
		case "dialog_response":
			cs.resolveDialog(msg.id, msg.value);
			return true;
		case "question_answer":
			if (msg.owner) {
				// 跨页作答：答案转交持有方会话（本页不持有该问卷）。
				if (typeof service.answerElsewhereQuestion === "function" && clientId) {
					void service.answerElsewhereQuestion(clientId, msg.owner, msg.id, msg.answers, msg.cancelled);
				} else {
					send({
						type: "notice",
						level: "error",
						text: "当前引擎不支持跨页作答，请用 pi 引擎",
						textEn: "Cross-page answering is not supported by the current engine; use the pi engine.",
					});
				}
			} else {
				void cs.answerQuestion?.(msg.id, msg.answers, msg.cancelled);
			}
			return true;
		case "tool_approval_response":
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
			// 浏览器（page-picker 扩展经前端）对 browser_page 的回包：恢复挂起的
			// pageCall；id 不匹配（超时后迟到/页面刷新）由 resolvePageCall 静默忽略。
			cs.resolvePageCall?.(msg.id, msg.ok, msg.result, msg.error);
			return true;
		default:
			return false;
	}
}
