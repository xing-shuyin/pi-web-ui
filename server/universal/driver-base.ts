/**
 * driver-base.ts — 通用 Agent 适配底座基础驱动契约与能力定义。
 *
 * 任何第三方 Agent（Claude Code、Aider、Codex、ACP 等）只要实现 BaseAgentDriver，
 * 并向 AgentEventSink 发射标准事件，即可通过 UniversalAgentHost 自动获得：
 *   - Web 聊天界面渲染（文本、流式 Thinking 气泡、折叠工具调用卡片、Token 统计）
 *   - 完整工作区文件树（代码查看、高亮、文件上传、图片音视频预览）
 *   - 底部/侧边多终端（xterm.js + node-pty）
 *   - Git SCM（代码差异、状态、提交历史）
 *   - 后台服务检测与一键释放
 *   - 60ms 增量快照广播与刷新后状态恢复
 */

import type { PromptAttachment, AgentEngineCapabilities, SlashCommandInfo } from "../protocol.js";
import { DEFAULT_UNIVERSAL_CAPABILITIES } from "../engine-capabilities.js";

/**
 * 驱动能力声明（Capabilities Flags）。
 * 用于告知前端宿主哪些深水区特性需要降级/隐藏。
 */
export interface AgentCapabilities {
	/** 是否支持从历史消息分叉（pi 原生为 true；第三方 Agent 默认为 false，降级为线性会话） */
	supportsTreeFork?: boolean;
	/** 是否支持就地编辑历史消息（第三方 Agent 默认为 false，历史只读） */
	supportsHistoryEdit?: boolean;
	/** 是否支持逐工具微调提示词（第三方 Agent 默认为 false，使用其自身默认提示词） */
	supportsToolPromptOverride?: boolean;
	/** 是否支持模型切换列表 */
	supportsModelSwitch?: boolean;
	/** 是否支持 Thinking 等级调节 */
	supportsThinkingLevels?: boolean;
	/** 是否支持人在回路提问（ask_user_question 等） */
	supportsAskUser?: boolean;
	/** 是否支持子代理生命周期与调度管理（默认为 true，由通用底座统管） */
	supportsSubagents?: boolean;
}

/**
 * 单轮模型调用的 Token 与成本统计。
 */
export interface AgentTurnUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** 本轮消耗的成本（美元） */
	costUSD?: number;
	/** 本轮当前上下文总长度（Token 数） */
	contextTokens?: number;
	/** 上下文窗口上限（默认 200,000） */
	contextWindow?: number;
}

/**
 * 本轮执行结束时的元数据。
 */
export interface AgentTurnMeta {
	usage?: AgentTurnUsage;
	model?: string;
	costUSD?: number;
	contextTokens?: number;
	contextWindow?: number;
}

/**
 * 驱动向宿主底座发射事件的输出槽（Event Sink）。
 * Driver 无需关心快照节流、WS 打包或 UI 数据结构，只需按生命周期调用对应方法。
 */
export interface AgentEventSink {
	/** 发射流式增量正文 */
	onTextDelta(delta: string): void;

	/** 发射流式增量思考过程（DeepSeek/Claude Thinking） */
	onThinkingDelta(delta: string): void;

	/**
	 * 工具调用开始：底座会自动在前端创建折叠工具卡片
	 * @param callId 工具调用唯一标识（如 call_123）
	 * @param toolName 工具名（如 Bash, ReadFile, Edit 等）
	 * @param args 工具入参
	 */
	onToolStart(callId: string, toolName: string, args: Record<string, unknown>): void;

	/**
	 * 工具执行过程中的实时日志增量（如终端标准输出、构建输出）
	 */
	onToolUpdate?(callId: string, outputDelta: string): void;

	/**
	 * 工具调用完成
	 * @param callId 工具调用唯一标识
	 * @param result 工具回执（包含 output 或 error）
	 */
	onToolEnd(callId: string, result: { output?: string; error?: string }): void;

	/**
	 * 人在回路确认/提问（如果驱动支持向用户发起确认或表单）
	 */
	onAskUser?(
		questionId: string,
		question: string,
		options?: Array<{ id: string; label: string; description?: string }>,
	): Promise<{ selected: string[]; custom?: string }>;

	/**
	 * 本轮执行结束（助手回答完成）
	 * @param meta 包含 token 统计、消耗成本、上下文占用和模型等元数据
	 */
	onTurnComplete(meta?: AgentTurnMeta): void;

	/** 发生未捕获错误或异常中断 */
	onError(err: Error | string): void;
}

/**
 * 通用 Agent 驱动抽象基类。
 */
export abstract class BaseAgentDriver {
	/** 驱动标识符，如 "claude-code" | "acp" | "aider" */
	abstract readonly id: string;
	/** 人类可读名称，如 "Claude Code" */
	abstract readonly name: string;
	/** 驱动能力声明 */
	abstract readonly capabilities: AgentCapabilities;

	protected cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** 更新驱动运行的工作目录 */
	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	/**
	 * 启动一轮 Prompt 执行。
	 * @param prompt 用户输入的文字
	 * @param attachments 用户附加的图片、代码片段或文件引用
	 * @param sink 事件接收槽
	 */
	abstract sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void>;

	/** 中断当前正在进行的生成或工具执行（用户点击停止按钮） */
	abstract abort(): Promise<void>;

	/** 初始化一个新会话（返回驱动内部的 sessionId，例如 Claude Code 的 session_id） */
	abstract createSession(): Promise<string>;

	/** 恢复/切换到一个已存在的会话 */
	abstract resumeSession(sessionId: string): Promise<void>;

	/** 原生分叉一个会话分支（返回分支会话的 sessionId） */
	async forkSession?(_sessionId: string, _atEntryId?: number): Promise<string> {
		return "";
	}

	/** 列出可用的模型列表（若不支持返回空数组） */
	async listModels?(): Promise<Array<{ id: string; name: string }>> {
		return [];
	}

	/** 切换当前模型（可选） */
	async setModel?(_modelId: string): Promise<void> {
		/* 可由子类覆盖 */
	}

	/** 设置运行态思考强度档位（可选） */
	setThinkingLevel?(_level: string): void {
		/* 可由子类覆盖 */
	}

	/** 获取该驱动/运行态支持的思考档位列表（默认回落为标准档位） */
	getSupportedThinkingLevels?(): string[] {
		return ["off", "low", "medium", "high"];
	}

	/** 转换为标准底座能力声明（AgentEngineCapabilities）供前端与快照使用 */
	getEngineCapabilities(): AgentEngineCapabilities {
		return {
			...DEFAULT_UNIVERSAL_CAPABILITIES,
			treeFork: this.capabilities.supportsTreeFork ?? false,
			messageEdit: this.capabilities.supportsHistoryEdit ?? false,
			toolPromptOverride: this.capabilities.supportsToolPromptOverride ?? false,
			subagents: this.capabilities.supportsSubagents ?? DEFAULT_UNIVERSAL_CAPABILITIES.subagents,
		};
	}

	/** 释放驱动持有的所有资源（子进程、TCP 连接等） */
	abstract dispose(): Promise<void> | void;

	/** 驱动支持的自定义斜杠命令列表（供输入框 / 补全展示） */
	async getSlashCommands?(): Promise<SlashCommandInfo[]> {
		return [];
	}

	/** 驱动执行自定义斜杠命令（返回 true 表示已拦截处理，无需作为普通 prompt 投递） */
	async execSlashCommand?(
		_name: string,
		_args: string,
		_context?: {
			emitNotice?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
			sink?: AgentEventSink;
		},
	): Promise<boolean> {
		return false;
	}

	/** 驱动特定的额外技能列表 */
	async getSkills?(): Promise<Array<{ name: string; description: string; filePath?: string }>> {
		return [];
	}
}
