import type { PluginToolSyncPort } from "../contracts/plugin.js";
import {
	enabledPluginAgentToolDefs,
	pluginAgentToolNames,
	type PluginAgentToolFilter,
} from "../adapters/tools/plugin-agent-tools.js";

/**
 * 插件工具与会话的绑定账（老实现 `ClientSession.appliedPluginToolNames` 同一职责）。
 *
 * 两件事必须由同一份账回答，所以合在一个类里：
 * 1. **开会话时装哪些**：`defsFor()` 每次开会话都按当前目录/预设/设置重算（插件目录变了不需要重启）；
 * 2. **已开的会话怎么跟上**：`syncInto()` 拿上一批工具名做基线，把新一批同步进会话并把消失的摘掉
 *    —— 基线必须与「上一次真装进会话的那一批」一致，否则会漏摘（留下已经卸载的插件工具）。
 *
 * 键是「客户端 + 对话」：对话 id 只在单个客户端内唯一（`c-1` 会在两个连接里各有一份）。
 */
export class PluginToolsBinder {
	private readonly applied = new Map<string, ReadonlySet<string>>();

	/** `sync` 是懒取的：宿主端口在组合根装配，缺省 = 没有就地刷新口。 */
	constructor(private readonly sync: () => PluginToolSyncPort | undefined) {}

	private key(clientId: string, conversationId: string): string {
		return `${clientId}\u0000${conversationId}`;
	}

	/** 开会话时调用：返回本次要装进会话的插件工具定义，并把它记为下一轮的基线。 */
	defsFor(clientId: string, conversationId: string, filter: PluginAgentToolFilter): unknown[] {
		const defs = enabledPluginAgentToolDefs(filter);
		this.applied.set(this.key(clientId, conversationId), pluginAgentToolNames(defs));
		return defs;
	}

	/**
	 * 插件目录变了：把当前这一批同步进已经开着的会话。
	 * 返回 `true` = 真的改了会话工具表；`false` = 没动（没有同步口 / SDK 私有口不在 / 没开会话）。
	 * 端口抛错原样冒泡：那是宿主适配器的缺陷，不该被这里吞掉变成「看起来同步好了」。
	 */
	syncInto(clientId: string, conversationId: string, session: unknown, filter: PluginAgentToolFilter): boolean {
		const port = this.sync();
		if (!port) return false;
		const defs = enabledPluginAgentToolDefs(filter);
		const prev = this.applied.get(this.key(clientId, conversationId)) ?? new Set<string>();
		const next = port.syncIntoSession(session, defs, prev);
		// `null` = 宿主拿不到 SDK 私有口：会话工具表没变，基线也不能变，否则下一轮会漏摘。
		if (!next) return false;
		this.applied.set(this.key(clientId, conversationId), next);
		return true;
	}

	/** 会话关了（或对话退役）：把基线一起删掉，别让下一次同步拿着一份过期名单去摘工具。 */
	forget(clientId: string, conversationId: string): void {
		this.applied.delete(this.key(clientId, conversationId));
	}

	/** 本对话上一次真装进会话的插件工具名（只读，测试与排障用）。 */
	appliedNames(clientId: string, conversationId: string): ReadonlySet<string> {
		return this.applied.get(this.key(clientId, conversationId)) ?? new Set<string>();
	}
}
