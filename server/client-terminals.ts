import type { ServerLang } from "./i18n.js";
import type { ClientMessage, ServerMessage, TerminalInfo } from "./protocol.js";
import { TerminalManager } from "./terminals.js";

export interface ClientTerminalContext {
	getCwd: () => string;
	getLang: () => ServerLang;
}

interface ClientTerminalEntry {
	manager?: TerminalManager;
	sinks: Set<(msg: ServerMessage) => void>;
	getCwd: () => string;
	getLang: () => ServerLang;
}

/**
 * 引擎无关的客户端级用户终端注册表（单源持有 `ownerKind: "client"` 终端）。
 *
 * 生命周期独立于任何对话引擎（Pi / DSH / Claude / Codex / Agy / Durable）与单次 WebSocket 连接：
 * 切换引擎、切换对话或断线重连都不会销毁或隐藏用户自己打开的终端。
 */
export class ClientTerminalRegistry {
	private readonly clients = new Map<string, ClientTerminalEntry>();

	constructor(private readonly defaultCwd: string) {}

	private ensureEntry(clientId: string, context?: ClientTerminalContext): ClientTerminalEntry {
		let entry = this.clients.get(clientId);
		if (!entry) {
			entry = {
				sinks: new Set(),
				getCwd: context?.getCwd ?? (() => this.defaultCwd),
				getLang: context?.getLang ?? (() => "en"),
			};
			this.clients.set(clientId, entry);
		} else if (context) {
			entry.getCwd = context.getCwd;
			entry.getLang = context.getLang;
		}
		return entry;
	}

	private emitForClient(clientId: string, msg: ServerMessage): void {
		const entry = this.clients.get(clientId);
		if (!entry || entry.sinks.size === 0) return;
		let outbound: ServerMessage = msg;
		if (msg.type === "terminal_list") {
			outbound = {
				...msg,
				scope: "client",
				terminals: msg.terminals.map((t) => ({ ...t, ownerKind: "client" as const })),
			};
		} else if (msg.type === "terminal_output" || msg.type === "terminal_exit") {
			outbound = { ...msg, ownerKind: "client" as const };
		}
		for (const sink of entry.sinks) {
			try {
				sink(outbound);
			} catch {}
		}
	}

	private getOrCreateManager(clientId: string): TerminalManager {
		const entry = this.ensureEntry(clientId);
		if (!entry.manager) {
			entry.manager = new TerminalManager(
				(msg) => this.emitForClient(clientId, msg),
				() => entry.getCwd(),
				() => entry.getLang(),
				"client",
			);
		}
		return entry.manager;
	}

	findManager(clientId: string): TerminalManager | undefined {
		return this.clients.get(clientId)?.manager;
	}

	resolveTerminal(clientId: string, terminalId: string): TerminalInfo | undefined {
		return this.findManager(clientId)
			?.list()
			.find((t) => t.id === terminalId);
	}

	attach(clientId: string, send: (msg: ServerMessage) => void, context?: ClientTerminalContext): void {
		const entry = this.ensureEntry(clientId, context);
		entry.sinks.add(send);
		const list: TerminalInfo[] = (entry.manager?.list() ?? []).map((t) => ({ ...t, ownerKind: "client" }));
		try {
			send({ type: "terminal_list", scope: "client", terminals: list });
		} catch {}
		if (entry.manager) {
			for (const output of entry.manager.replay()) {
				try {
					send({
						type: "terminal_output",
						ownerKind: "client",
						terminalId: output.terminalId,
						data: output.data,
						reset: true,
					});
				} catch {}
			}
		}
	}

	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		const entry = this.clients.get(clientId);
		if (!entry) return;
		entry.sinks.delete(send);
	}

	/**
	 * 拦截并处理属于客户端级（`ownerKind: "client"`）的终端消息。
	 * 返回 `true` 表示已由独立终端宿主接管，不再进入引擎路由；
	 * 返回 `false` 表示属于对话级（`ownerKind: "conversation"` / `agentBash`）或非终端消息。
	 */
	handleMessage(clientId: string, msg: ClientMessage): boolean {
		switch (msg.type) {
			case "terminal_create": {
				if (msg.ownerKind === "conversation" || msg.agentBash === true) return false;
				const entry = this.ensureEntry(clientId);
				const tm = this.getOrCreateManager(clientId);
				const createOpts =
					msg.locale !== undefined || msg.nativeCli !== undefined
						? {
								locale: msg.locale,
								...(msg.nativeCli !== undefined ? { nativeCli: msg.nativeCli } : {}),
							}
						: undefined;
				const create = msg.nativeCli && tm.createNativeCli ? tm.createNativeCli.bind(tm) : tm.create.bind(tm);
				void create(msg.terminalId, msg.cwd, msg.cols, msg.rows, entry.getCwd(), msg.title, createOpts);
				return true;
			}
			case "run_command": {
				const entry = this.ensureEntry(clientId);
				const tm = this.getOrCreateManager(clientId);
				tm.runCommand(msg.terminalId, msg.command, msg.cols, msg.rows, entry.getCwd());
				return true;
			}
			case "terminal_attach": {
				if (msg.ownerKind === "conversation") return false;
				const tm = this.findManager(clientId);
				if (msg.ownerKind === "client") {
					tm?.attach(msg.terminalId, msg.cols, msg.rows);
					return true;
				}
				if (tm?.has(msg.terminalId)) {
					tm.attach(msg.terminalId, msg.cols, msg.rows);
					return true;
				}
				return false;
			}
			case "terminal_input": {
				if (msg.ownerKind === "conversation") return false;
				const tm = this.findManager(clientId);
				if (msg.ownerKind === "client") {
					tm?.input(msg.terminalId, msg.data);
					return true;
				}
				if (tm?.has(msg.terminalId)) {
					tm.input(msg.terminalId, msg.data);
					return true;
				}
				return false;
			}
			case "terminal_resize": {
				if (msg.ownerKind === "conversation") return false;
				const tm = this.findManager(clientId);
				if (msg.ownerKind === "client") {
					tm?.resize(msg.terminalId, msg.cols, msg.rows);
					return true;
				}
				if (tm?.has(msg.terminalId)) {
					tm.resize(msg.terminalId, msg.cols, msg.rows);
					return true;
				}
				return false;
			}
			case "terminal_kill": {
				if (msg.ownerKind === "conversation") return false;
				const tm = this.findManager(clientId);
				if (msg.ownerKind === "client") {
					tm?.kill(msg.terminalId);
					return true;
				}
				if (tm?.has(msg.terminalId)) {
					tm.kill(msg.terminalId);
					return true;
				}
				return false;
			}
			case "rename_terminal": {
				if (msg.ownerKind === "conversation") return false;
				const tm = this.findManager(clientId);
				if (msg.ownerKind === "client") {
					tm?.rename(msg.terminalId, msg.title);
					return true;
				}
				if (tm?.has(msg.terminalId)) {
					tm.rename(msg.terminalId, msg.title);
					return true;
				}
				return false;
			}
			default:
				return false;
		}
	}

	disposeClient(clientId: string): void {
		const entry = this.clients.get(clientId);
		if (!entry) return;
		this.clients.delete(clientId);
		entry.sinks.clear();
		entry.manager?.killAll();
	}

	disposeAll(): void {
		for (const clientId of Array.from(this.clients.keys())) {
			this.disposeClient(clientId);
		}
	}
}
