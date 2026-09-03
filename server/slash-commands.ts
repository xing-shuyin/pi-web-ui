/**
 * slash-commands — 斜杠命令目录与内置命令执行，从 agent-service.ts 抽出。
 *
 * 职责：
 *  - NATIVE_COMMANDS：web 服务端原生实现的斜杠命令清单（pi CLI 的交互式内置命令
 *    如 /model /new 不经 SDK prompt()——不拦截会被当普通文本发给模型）
 *  - push()：目录 = 内置命令 + 活动对话的扩展命令 / 提示模板 / 技能（与 SDK
 *    展开行为一致），推 slash_commands 供输入框选择器使用
 *  - exec()：拦截执行内置命令；返回 false 表示非内置命令，prompt 落到 SDK
 *
 * 经 SlashHost 窄接口与 ClientSession 解耦（同 settings-service/goal-service 模式）。
 * UI 文案直接中文（服务端 notice 约定）。/help 与 /copy 是纯客户端动作（不到服务端），
 * 保留在目录里供选择器展示，exec 里吞掉防止 SDK 当文本。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, SlashCommandInfo } from "./protocol.js";
import type { PluginCommandDef } from "./plugins.js";

/** ClientSession 提供给本服务的宿主能力（窄接口，便于独立测试）。 */
export interface SlashHost {
	emit: (msg: ServerMessage) => void;
	/** 当前工作目录（/cwd 无参数时回显）。 */
	cwd: () => string;
	/** 活动对话的 session。 */
	getSession: () => AgentSession;
	newChat: () => Promise<void>;
	setModel: (modelId: string) => Promise<void>;
	setCwd: (path: string) => Promise<void>;
	setThinking: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
	refreshSessions: () => Promise<void>;
	/** supervisor 的优雅重启调度；返回 false 时 exec 兜底 process.exit(0)。 */
	onQuit?: () => boolean;
	/** session.reload() 之后的钩子（重放终端工具开关等设置门控）。 */
	afterReload?: () => void;
	/** 插件注册的斜杠命令（registerCommand）——目录展示 + exec 拦截执行。 */
	pluginCommands?: () => PluginCommandDef[];
	/** 执行一个插件命令：找到并调用 run，返回 true；没这个命令返回 false。
	 *  放在宿主层而不是本服务里，因为 clientId/通知回显需要 ClientSession 环境。 */
	execPluginCommand?: (name: string, args: string) => Promise<boolean> | boolean;
}

/** Slash commands implemented natively by the web server (the pi CLI's built-in
 * interactive commands like /model and /new are NOT handled by the SDK's
 * prompt() — without this they'd be sent to the model as plain text). Keep in
 * sync with exec(). */
export const NATIVE_COMMANDS: {
	name: string;
	description: string;
	descriptionEn: string;
	argumentHint?: string;
	argumentHintEn?: string;
}[] = [
	{ name: "new", description: "新建对话", descriptionEn: "New chat" },
	{ name: "model", description: "切换模型", descriptionEn: "Switch model", argumentHint: "[名称]", argumentHintEn: "[name]" },
	{ name: "compact", description: "压缩上下文", descriptionEn: "Compact context", argumentHint: "[说明]", argumentHintEn: "[instructions]" },
	{ name: "cwd", description: "切换工作目录", descriptionEn: "Switch workspace", argumentHint: "<路径>", argumentHintEn: "<path>" },
	{
		name: "thinking",
		description: "设置思考强度",
		descriptionEn: "Set thinking level",
		argumentHint: "<off|low|medium|high|xhigh|max>",
		argumentHintEn: "<off|low|medium|high|xhigh|max>",
	},
	{ name: "resume", description: "刷新会话列表", descriptionEn: "Refresh session list" },
	{ name: "reload", description: "重新加载扩展、技能与模板", descriptionEn: "Reload extensions, skills & templates" },
	{ name: "help", description: "显示全部命令", descriptionEn: "Show all commands" },
	{ name: "copy", description: "复制上一条助手回复", descriptionEn: "Copy last assistant reply" },
	{ name: "pi-web-ui:quit", description: "退出服务", descriptionEn: "Quit server (supervisor will restart)" },
];

/** Parse a prompt into "/command args" — returns null when it isn't one. */
export function parseSlash(text: string): { name: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/);
	if (!m || !m[1]) return null;
	return { name: m[1], args: m[2].trim() };
}

export class SlashCommandsService {
	constructor(private readonly host: SlashHost) {}

	/**
	 * Catalog of slash commands for the chat input: web-native builtins first,
	 * then the SDK's invokable commands for the ACTIVE conversation (extension
	 * commands, prompt templates, skills) — the same set the SDK expands when a
	 * prompt text starts with "/" (see AgentSession.prompt).
	 */
	async push(): Promise<void> {
		const commands: SlashCommandInfo[] = [];
		const seen = new Set<string>();
		for (const c of NATIVE_COMMANDS) {
			commands.push({ ...c, source: "builtin" });
			seen.add(c.name);
		}
		try {
			const s = this.host.getSession();
			// Extension commands — the SDK already suffixes collisions with builtin
			// names ("new:2"), and those still reach the SDK since exec() only
			// intercepts the exact native names.
			for (const cmd of s.extensionRunner.getRegisteredCommands()) {
				if (seen.has(cmd.invocationName)) continue;
				commands.push({
					name: cmd.invocationName,
					description: cmd.description,
					source: "extension",
				});
				seen.add(cmd.invocationName);
			}
			// Prompt templates: /templatename args
			for (const t of s.promptTemplates) {
				if (seen.has(t.name)) continue;
				commands.push({
					name: t.name,
					description: t.description,
					source: "prompt",
				});
				seen.add(t.name);
			}
			// Skills: /skill:name args
			for (const skill of s.resourceLoader.getSkills().skills) {
				const name = `skill:${skill.name}`;
				if (seen.has(name)) continue;
				commands.push({
					name,
					description: skill.description,
					source: "skill",
				});
				seen.add(name);
			}
		} catch {
			// Session not ready yet — native-only catalog still serves the picker.
		}
		// UI 插件注册的命令（host.registerCommand）——全局，不依赖会话就绪。
		for (const cmd of this.host.pluginCommands?.() ?? []) {
			if (seen.has(cmd.name)) continue; // 与内置/扩展重名时先到先得（内置优先）
			commands.push({
				name: cmd.name,
				description: cmd.description,
				descriptionEn: cmd.descriptionEn,
				argumentHint: cmd.argumentHint,
				argumentHintEn: cmd.argumentHintEn,
				source: "plugin",
			});
			seen.add(cmd.name);
		}
		this.host.emit({ type: "slash_commands", commands });
	}

	/** Run a native slash command (see NATIVE_COMMANDS). Returns false when the
	 *  name is not a native command (the prompt falls through to the SDK). */
	async exec(name: string, args: string): Promise<boolean> {
		switch (name) {
			case "new":
				await this.host.newChat();
				return true;
			case "model": {
				if (!args) {
					const current = this.host.getSession().model;
					this.host.emit({
						type: "notice",
						level: "info",
						text: current
							? `当前模型：${current.name}（${current.provider}/${current.id}）。用法：/model <名称>`
							: `用法：/model <名称>`,
					});
					return true;
				}
				const query = args.toLowerCase();
				const available = await this.host.getSession().modelRuntime.getAvailable();
				// Prefer an exact "provider/id" match, else id/name substring.
				const exact = available.find(
					(m) => m.provider + "/" + m.id === args.trim(),
				);
				const matches = exact
					? [exact]
					: available.filter(
							(m) =>
								m.id.toLowerCase().includes(query) ||
								m.name.toLowerCase().includes(query) ||
								m.provider.toLowerCase().includes(query),
						);
				if (matches.length === 0) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `没有匹配到模型：${args}（可用模型见顶栏模型列表）`,
						textEn: `No matching model: ${args} (see the model list in the top bar)`,
					});
					return true;
				}
				const pick = matches[0];
				if (matches.length > 1) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `找到 ${matches.length} 个匹配模型，已选用：${pick.name}（精确匹配请用 provider/id）`,
						textEn: `Found ${matches.length} matching models, using: ${pick.name} (use provider/id for an exact match)`,
					});
				}
				await this.host.setModel(`${pick.provider}/${pick.id}`);
				return true;
			}
			case "compact":
				try {
					await this.host.getSession().compact(args || undefined);
				} catch {
					// 压缩过程/结果/错误反馈统一由 agent-service onEvent 的
					// compaction_start / compaction_end 事件处理（含 errorMessage），
					// 这里不重复发通知；SDK 在 throw 前必发 compaction_end（issue #33）。
				}
				return true;
			case "cwd":
				if (!args) {
					this.host.emit({
						type: "notice",
						level: "info",
						text: `当前工作目录：${this.host.cwd()}。用法：/cwd <路径>`,
						textEn: `Current directory: ${this.host.cwd()}. Usage: /cwd <path>`,
					});
				} else {
					await this.host.setCwd(args);
				}
				return true;
			case "thinking": {
				const ALIAS: Record<string, string> = {
					off: "off",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					关闭: "off",
					极简: "minimal",
					低: "low",
					中: "medium",
					高: "high",
					极高: "xhigh",
					最大: "max",
				};
				const level = ALIAS[args.trim().toLowerCase()];
				if (!level) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `无效的思考强度：${args || "（空）"}。可用：off / minimal / low / medium / high / xhigh / max`,
						textEn: `Invalid thinking level: ${args || "(empty)"}. Available: off / minimal / low / medium / high / xhigh / max`,
					});
					return true;
				}
				this.host.setThinking(level as Parameters<SlashHost["setThinking"]>[0]);
				return true;
			}
			case "resume":
				await this.host.refreshSessions();
				this.host.emit({
					type: "notice",
					level: "info",
					text: "会话列表已刷新，请在左侧「历史对话」中选择",
					textEn: "Session list refreshed — pick one under History on the left",
				});
				return true;
			case "reload":
				try {
					// Re-discovers extensions / skills / prompt templates from disk and
					// re-pushes the picker catalog (the CLI's /reload semantics).
					await this.host.getSession().reload();
					// reload() 会把 custom 工具加回活跃集——重放设置门控（终端开关等）。
					this.host.afterReload?.();
					await this.push();
					this.host.emit({
						type: "notice",
						level: "info",
						text: "已重新加载扩展、技能与提示模板",
						textEn: "Reloaded extensions, skills and prompt templates",
					});
				} catch (err) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `重新加载失败：${(err as Error).message}`,
						textEn: `Reload failed: ${(err as Error).message}`,
					});
				}
				return true;
			case "pi-web-ui:quit": {
				this.host.emit({
					type: "notice",
					level: "info",
					text: "正在退出 pi-web-ui… supervisor 将自动重启服务",
					textEn: "Quitting pi-web-ui… the supervisor will restart the service",
				});
				setTimeout(() => {
					const didSchedule = this.host.onQuit?.() ?? false;
					if (!didSchedule) {
						setTimeout(() => process.exit(0), 100);
					}
				}, 300);
				return true;
			}
			case "help":
			case "copy":
				// Client-side UI actions — the client handles them before sending;
				// swallow here so the SDK never sees them as plain prompt text.
				return true;
			default:
				// 插件命令：拦截执行（纯配置动作，与内置命令同级，不到 SDK）。
				return (await this.host.execPluginCommand?.(name, args)) ?? false;
		}
	}
}
