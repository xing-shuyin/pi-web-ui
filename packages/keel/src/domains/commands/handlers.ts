import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { SlashCommandsPort } from "../../contracts/commands.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { CommandDef, ServerMessage } from "../../protocol.js";
import { loadCommands, saveCommandsFile } from "../../../../../server/terminals.js";

export interface CommandHandlersOptions {
	/** 缺省 = 未接：`pushSlashCommands` 调到时同步抛 `CoreEngineNotReadyError`（thunk 是防循环装配）。 */
	slash?: () => SlashCommandsPort | undefined;
	/**
	 * 读/写自定义命令的目录（宿主传 cwd）。`process.cwd()` 不是正确缺省：命令文件属于工作区，必须由调用方给。
	 * 给 thunk 就每次现取（老实现的 `this.cwd` 会随对话切目录变），给字符串就固定用它。
	 */
	cwd: string | (() => string);
	/** 这条客户端连接的上行通道：`commands` / `notice` 帧只从这里出去。 */
	transport: TransportPort;
}

/** 斜杠命令面的 3 个 handler：命令解析与静态命令表归宿主，内核只管自定义命令文件的读写下发。 */
export interface CommandHandlers {
	pushSlashCommands(): Promise<void>;
	listCommands(): Promise<void>;
	saveCommands(commands: CommandDef[]): Promise<void>;
}

/**
 * `slash_commands` 那一帧不在这里拼：重算、去重、native 兜底全是 `SlashCommandsService.push()` 的事。
 * `listCommands` / `saveCommands` 只搬 `terminals.ts` 的两个纯文件叶子（`loadCommands` / `saveCommandsFile`），
 * 帧形状照老实现逐字段抄：告警先报（不清空命令表），`commands` 帧带 `path`。
 */
export function createCommandHandlers(options: CommandHandlersOptions): CommandHandlers {
	const send = (msg: ServerMessage): void => {
		if (options.transport.isClosed()) return;
		options.transport.send(msg);
	};
	const notice = (level: "info" | "warning" | "error", text: string, textEn?: string): void =>
		send({ type: "notice", level, text, textEn });
	const cwd = (): string => (typeof options.cwd === "function" ? options.cwd() : options.cwd);
	const port = (what: string): SlashCommandsPort => {
		const slash = options.slash?.();
		if (!slash) throw new CoreEngineNotReadyError(what);
		return slash;
	};

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的（与注册表口径一致，不能变成 rejected promise）。
		pushSlashCommands(): Promise<void> {
			const slash = port("pushSlashCommands");
			return Promise.resolve(slash.push());
		},

		listCommands: async () => {
			const { commands, path, warning, warningEn } = await loadCommands(cwd());
			// 老实现同序：读取告警先发一帧，命令表照发（告警不代表没有命令）。
			if (warning) notice("warning", warning, warningEn);
			send({ type: "commands", commands, path });
		},

		saveCommands: async (commands) => {
			const { path, error, errorEn } = await saveCommandsFile(cwd(), commands);
			if (error) {
				// 老实现发完 error 帧就 return；DoD#2 要求失败不静默，所以这里补一次抛出。
				notice("error", error, errorEn);
				throw new Error(error);
			}
			send({ type: "commands", commands, path });
			notice("info", `命令已保存：${path}`, `Command saved: ${path}`);
		},
	};
}
