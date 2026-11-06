import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, SlashCommandInfo } from "./protocol.js";
import type { PluginCommandDef } from "./plugins.js";

export interface SlashHost {
	emit: (msg: ServerMessage) => void;
	cwd: () => string;
	getSession?: () => AgentSession;
	newChat: () => Promise<void | boolean>;
	prompt?: (text: string) => Promise<void>;
	setModel: (modelId: string) => Promise<void>;
	setCwd: (path: string) => Promise<void>;
	setThinking: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
	renameSession?: (name: string) => Promise<void> | void;
	refreshSessions: () => Promise<void>;
	onQuit?: () => boolean;
	setPlanMode?: (enabled: boolean) => Promise<void> | void;
	getPlanMode?: () => boolean;
	afterReload?: () => void;
	pluginCommands?: () => PluginCommandDef[];
	execPluginCommand?: (name: string, args: string) => Promise<boolean> | boolean;

	getModel?: () => { id: string; name?: string; provider?: string } | undefined;
	getAvailableModels?: () => Promise<Array<{ id: string; name: string; provider?: string }>>;
	getSkills?: () =>
		| Array<{ name: string; description?: string; filePath?: string }>
		| Promise<Array<{ name: string; description?: string; filePath?: string }>>;
	getExtraCommands?: () => SlashCommandInfo[] | Promise<SlashCommandInfo[]>;
	execExtraCommand?: (name: string, args: string) => Promise<boolean> | boolean;
	compact?: (instructions?: string) => Promise<void>;
	reload?: () => Promise<void>;
	getSessionName?: () => string | undefined;
}

export const NATIVE_COMMANDS: {
	name: string;
	description: string;
	descriptionEn: string;
	argumentHint?: string;
	argumentHintEn?: string;
}[] = [
	{
		name: "new",
		description: "新建对话（可带首条提示：/new <提示>）",
		descriptionEn: "New chat (optional first prompt: /new <prompt>)",
		argumentHint: "[提示]",
		argumentHintEn: "[prompt]",
	},
	{
		name: "name",
		description: "重命名当前会话",
		descriptionEn: "Set session display name",
		argumentHint: "<名称>",
		argumentHintEn: "<name>",
	},
	{
		name: "model",
		description: "切换模型",
		descriptionEn: "Switch model",
		argumentHint: "[名称]",
		argumentHintEn: "[name]",
	},
	{
		name: "compact",
		description: "压缩上下文",
		descriptionEn: "Compact context",
		argumentHint: "[说明]",
		argumentHintEn: "[instructions]",
	},
	{
		name: "cwd",
		description: "切换工作目录",
		descriptionEn: "Switch workspace",
		argumentHint: "<路径>",
		argumentHintEn: "<path>",
	},
	{
		name: "plan",
		description: "开启或关闭计划模式（/plan [on|off]）",
		descriptionEn: "Toggle plan mode (/plan [on|off])",
		argumentHint: "[on|off]",
		argumentHintEn: "[on|off]",
	},
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

export function parseSlash(text: string): { name: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = trimmed.match(/^\/([^\s]*)\s*([\s\S]*)$/);
	if (!m) return null;
	return { name: m[1] ?? "", args: (m[2] ?? "").trim() };
}

export class SlashCommandsService {
	constructor(private readonly host: SlashHost) {}

	async push(): Promise<void> {
		const commands: SlashCommandInfo[] = [];
		const seen = new Set<string>();
		for (const c of NATIVE_COMMANDS) {
			commands.push({ ...c, source: "builtin" });
			seen.add(c.name);
		}
		if (this.host.getSession) {
			try {
				const s = this.host.getSession();
				if (s) {
					for (const cmd of s.extensionRunner?.getRegisteredCommands?.() ?? []) {
						if (seen.has(cmd.invocationName)) continue;
						commands.push({
							name: cmd.invocationName,
							description: cmd.description,
							source: "extension",
						});
						seen.add(cmd.invocationName);
					}
					for (const t of s.promptTemplates ?? []) {
						if (seen.has(t.name)) continue;
						commands.push({
							name: t.name,
							description: t.description,
							source: "prompt",
						});
						seen.add(t.name);
					}
					for (const skill of s.resourceLoader?.getSkills?.()?.skills ?? []) {
						const name = `skill:${skill.name}`;
						if (seen.has(name)) continue;
						commands.push({
							name,
							description: skill.description,
							source: "skill",
						});
						seen.add(name);
					}
				}
			} catch {}
		}
		if (this.host.getSkills) {
			try {
				const skills = await this.host.getSkills();
				for (const skill of skills) {
					const name = skill.name.startsWith("skill:") ? skill.name : `skill:${skill.name}`;
					if (seen.has(name)) continue;
					commands.push({
						name,
						description: skill.description ?? `Skill ${skill.name}`,
						source: "skill",
					});
					seen.add(name);
				}
			} catch {}
		}
		if (this.host.getExtraCommands) {
			try {
				const extra = await this.host.getExtraCommands();
				for (const cmd of extra) {
					if (seen.has(cmd.name)) continue;
					commands.push(cmd);
					seen.add(cmd.name);
				}
			} catch {}
		}
		for (const cmd of this.host.pluginCommands?.() ?? []) {
			if (seen.has(cmd.name)) continue;
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

	async exec(name: string, args: string): Promise<boolean> {
		switch (name) {
			case "new": {
				const first = args.trim();
				const ready = await this.host.newChat();
				if (ready !== false && first && this.host.prompt) await this.host.prompt(first);
				return true;
			}
			case "name": {
				const trimmed = args.trim();
				if (!trimmed) {
					const current = this.host.getSession?.()?.sessionName ?? this.host.getSessionName?.();
					this.host.emit({
						type: "notice",
						level: "info",
						text: current ? `当前会话名称：${current}。用法：/name <名称>` : `用法：/name <名称>`,
						textEn: current ? `Current session name: ${current}. Usage: /name <name>` : `Usage: /name <name>`,
					});
					return true;
				}
				if (this.host.renameSession) {
					await this.host.renameSession(trimmed);
				} else if (this.host.getSession) {
					this.host.getSession().setSessionName(trimmed);
					await this.host.refreshSessions();
					this.host.emit({
						type: "notice",
						level: "info",
						text: `已重命名当前会话为「${trimmed}」`,
						textEn: `Renamed current session to "${trimmed}"`,
					});
				}
				return true;
			}
			case "model": {
				if (!args) {
					const current = this.host.getSession?.()?.model ?? this.host.getModel?.();
					const modelDesc = current
						? current.provider
							? `${current.name || current.id}（${current.provider}/${current.id}）`
							: `${current.name || current.id}`
						: "";
					this.host.emit({
						type: "notice",
						level: "info",
						text: modelDesc ? `当前模型：${modelDesc}。用法：/model <名称>` : `用法：/model <名称>`,
						textEn: modelDesc ? `Current model: ${modelDesc}. Usage: /model <name>` : `Usage: /model <name>`,
					});
					return true;
				}
				const query = args.toLowerCase();
				let available: readonly { id: string; name: string; provider?: string }[] = [];
				if (this.host.getSession) {
					try {
						available = await this.host.getSession().modelRuntime.getAvailable();
					} catch {
						available = [];
					}
				}
				if (available.length === 0 && this.host.getAvailableModels) {
					available = await this.host.getAvailableModels();
				}
				const hasLister = Boolean(this.host.getSession || this.host.getAvailableModels);
				if (hasLister) {
					const exact = available.find((m) => (m.provider ? `${m.provider}/${m.id}` : m.id) === args.trim());
					const matches = exact
						? [exact]
						: available.filter(
								(m) =>
									m.id.toLowerCase().includes(query) ||
									m.name.toLowerCase().includes(query) ||
									Boolean(m.provider && m.provider.toLowerCase().includes(query)),
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
					await this.host.setModel(pick.provider ? `${pick.provider}/${pick.id}` : pick.id);
				} else {
					await this.host.setModel(args.trim());
				}
				return true;
			}
			case "compact":
				try {
					if (this.host.compact) {
						await this.host.compact(args || undefined);
					} else if (this.host.getSession) {
						await this.host.getSession().compact(args || undefined);
					} else {
						this.host.emit({
							type: "notice",
							level: "info",
							text: "当前引擎不支持手动上下文压缩",
							textEn: "Current engine does not support manual context compaction",
						});
					}
				} catch {}
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
			case "plan": {
				const trimmed = args.trim().toLowerCase();
				const current = this.host.getPlanMode ? this.host.getPlanMode() : false;
				const next = trimmed === "on" ? true : trimmed === "off" ? false : !current;
				if (this.host.setPlanMode) {
					await this.host.setPlanMode(next);
				}
				return true;
			}
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
					if (this.host.reload) {
						await this.host.reload();
					} else if (this.host.getSession) {
						await this.host.getSession().reload();
					}
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
			case "":
			case "?":
			case "help": {
				void this.push();
				const cmdList = NATIVE_COMMANDS.map((c) => `/${c.name} : ${c.description}`).join("\n");
				this.host.emit({
					type: "notice",
					level: "info",
					text: `可用斜杠指令：\n${cmdList}`,
					textEn: `Available slash commands:\n${cmdList}`,
				});
				return true;
			}
			case "copy":
				return true;
			default:
				if (this.host.execExtraCommand) {
					const handled = await this.host.execExtraCommand(name, args);
					if (handled) return true;
				}
				return (await this.host.execPluginCommand?.(name, args)) ?? false;
		}
	}
}
