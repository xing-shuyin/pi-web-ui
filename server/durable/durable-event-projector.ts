/**
 * durable-event-projector.ts — 把 @earendil-works/pi-durable 的 AgentEvent 批次投影为宿主 AgentEventSink 事件。
 *
 * 事实源：pi-durable `harness/events.d.ts`（`AgentEvent` / `ToolEventCall` / `MessageChange`）。
 *
 * 关键契约（别再回到读 `pi.live` 槽位的老路）：
 * 1. `pi.live` 只是「运行期进度投影」——槽位**只有 running 期间**带 `output`，结算是全部剪掉；
 *    槽位**从不携带 `input`**（模型发起调用的入参在工具任务的 checkpoint 里，事件层已解析好）。
 * 2. 因此工具入参唯一来源是 `tool_execution_start.args`，
 *    工具结果唯一来源是 `tool_execution_end.entry`（模型调用）或 `tool_execution_end.result`（嵌套调用）。
 * 3. 正文/思考走 `message_start` / `message_update(changes)` / `message_end`，
 *    投影层按 `contentIndex` 记账已下发长度，保证流式增量与整段回执不重复、不丢字。
 */

/** 宿主事件槽的最小面（只声明投影层用到的成员，便于单测 mock）。 */
export interface DurableSinkLike {
	onTextDelta(delta: string): void;
	onThinkingDelta(delta: string): void;
	onToolStart?(callId: string, toolName: string, args: Record<string, unknown>): void;
	onToolUpdate?(callId: string, outputDelta: string): void;
	onToolEnd?(callId: string, result: { output?: string; error?: string }): void;
}

/** 富文本内容块转纯文本（字符串 / `{type:"text"}` 数组两种形态）。 */
export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			parts.push(item);
			continue;
		}
		if (item && typeof item === "object") {
			const block = item as { type?: unknown; text?: unknown };
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * 工具回执（`tool_execution_end`）里的正文与错误标记。
 * 成功只带 `output`，失败只带 `error`（宿主以 `error` 是否存在判定 isError）。
 */
export function readToolEnd(event: any): { output?: string; error?: string } {
	const message = event?.entry?.model?.[0];
	if (message) {
		const text = contentToText(message.content);
		return message.isError ? { error: text || "error" } : { output: text };
	}
	const result = event?.result;
	if (result) {
		const diagnostics = Array.isArray(result.diagnostics)
			? result.diagnostics
					.map((d: any) => (typeof d?.message === "string" ? d.message : ""))
					.filter(Boolean)
					.join("\n")
			: "";
		const text = contentToText(result.structuredOutput) || diagnostics;
		return result.isError ? { error: text || "error" } : { output: text };
	}
	return { output: "" };
}

/**
 * 一次投影器实例 = 一次 prompt 轮次的展示状态（每个对话每轮新建，避免跨轮串味）。
 */
export class DurableEventProjector {
	/** 每个正文内容块（contentIndex）已下发的字符数 */
	private readonly textSent = new Map<number, number>();
	/** 每个思考内容块已下发的字符数 */
	private readonly thinkingSent = new Map<number, number>();
	/** 每个工具调用已下发的进度输出窗口（用于把 `set` / `append` 换算成增量） */
	private readonly toolOutput = new Map<string, string>();
	/** 已发过 onToolStart 的调用（未见过开始的回执不单独出结果卡） */
	private readonly startedTools = new Set<string>();

	/** 是否已经下发过任何正文（供“流式全文都没出来”时最后一手兜底判断）。 */
	get emittedAnyText(): boolean {
		for (const length of this.textSent.values()) {
			if (length > 0) return true;
		}
		return false;
	}

	/**
	 * 附着时的快照：若挂接时已有在飞的半截回复（重启续跑/自愈），把它当作已下发内容补上，
	 * 否则随后的 `message_update` 增量只有尾巴、正文会从中间开始。正常时序（先挂接再 submit）下是空操作。
	 */
	primeSnapshot(snapshot: any, sink: DurableSinkLike): void {
		this.textSent.clear();
		this.thinkingSent.clear();
		this.projectMessage(snapshot?.generation?.message, sink);
	}

	/** 投影一批 AgentEvent。 */
	project(events: readonly any[] | undefined, sink: DurableSinkLike): void {
		if (!Array.isArray(events)) return;
		// 引擎在同一个提交里会先发 `tool_execution_start`、后发该轮正文的 message 事件（见 events.js 的 Progress 段），
		// 而正文在时间上早于工具调用——“我来看下目录”类的文字必须落在工具卡之前，所以把工具开始推迟到批末
		// （同一批里它自己的 `tool_execution_update` 跟着一起推，避免先到进度后到卡片）。
		const deferred: any[] = [];
		const deferredCallIds = new Set<string>();
		for (const event of events) {
			const type = event?.type;
			if (type === "tool_execution_start") {
				deferred.push(event);
				deferredCallIds.add(String(event?.toolCallId ?? ""));
				continue;
			}
			if (type === "tool_execution_update" && deferredCallIds.has(String(event?.toolCallId ?? ""))) {
				deferred.push(event);
				continue;
			}
			this.projectSafely(event, sink);
		}
		for (const event of deferred) this.projectSafely(event, sink);
	}

	private projectSafely(event: any, sink: DurableSinkLike): void {
		try {
			this.projectOne(event, sink);
		} catch {
			/* 单条事件投影失败不拖垮整批（事件是外部包产物，字段可能随版本微调） */
		}
	}

	private projectOne(event: any, sink: DurableSinkLike): void {
		if (!event || typeof event !== "object") return;
		switch (event.type) {
			case "message_start": {
				// 新一轮助手消息：contentIndex 记账归零，避免沿用上一条消息的下发长度
				this.textSent.clear();
				this.thinkingSent.clear();
				this.projectMessage(event.message, sink);
				return;
			}
			case "message_update": {
				const changes = Array.isArray(event.changes) ? event.changes : [];
				for (const change of changes) {
					if (change?.type === "text_delta" && typeof change.delta === "string") {
						this.emitDelta(this.textSent, change.contentIndex, change.delta, (d) => sink.onTextDelta(d));
					} else if (change?.type === "thinking_delta" && typeof change.delta === "string") {
						this.emitDelta(this.thinkingSent, change.contentIndex, change.delta, (d) => sink.onThinkingDelta(d));
					} else if (change?.type === "message") {
						this.projectMessage(change.message, sink);
					} else if (typeof change?.contentIndex === "number" && change?.block) {
						// text_start / thinking_start / block：块整体送达，按已下发长度补齐剩余部分
						this.projectBlock(change.contentIndex, change.block, sink);
					}
				}
				return;
			}
			case "snapshot": {
				// 流溢出时引擎以快照替换未投递批次：只补在飞消息的剩余正文（历史条目/工具卡已在先前批次发过）
				this.projectMessage(event.generation?.message, sink);
				return;
			}
			case "message_end": {
				// 提交后的完整助手消息：补齐流式期间遗漏的尾部
				this.projectMessage(event.entry?.model?.[0], sink);
				return;
			}
			case "tool_execution_start": {
				// 嵌套调用（`parentCallId` 存在）是父调用内部的子步骤，不单独出卡片，保持与既往展示口径一致
				if (event.parentToolCallId !== undefined) return;
				const callId = String(event.toolCallId ?? "");
				if (!callId) return;
				this.toolOutput.delete(callId);
				const args = event.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args : {};
				this.startedTools.add(callId);
				sink.onToolStart?.(callId, String(event.toolName ?? "tool"), args);
				return;
			}
			case "tool_execution_update": {
				if (event.parentToolCallId !== undefined) return;
				this.projectToolUpdate(String(event.toolCallId ?? ""), event.output, sink);
				return;
			}
			case "tool_execution_end": {
				if (event.parentToolCallId !== undefined) return;
				const callId = String(event.toolCallId ?? "");
				if (!callId) return;
				this.toolOutput.delete(callId);
				if (!this.startedTools.delete(callId)) {
					// 边缘情形：附着前就已开始的调用（崩溃恢复/自愈续跑）。入参无事件可捞，宁可不编造；至少不丢回执
					sink.onToolStart?.(callId, String(event.toolName ?? "tool"), {});
				}
				const { output, error } = readToolEnd(event);
				sink.onToolEnd?.(callId, error !== undefined ? { error } : { output });
				return;
			}
			default:
				return;
		}
	}

	/** 按已下发长度补齐一条完整助手消息（含 thinking / text）。 */
	projectMessage(message: any, sink: DurableSinkLike): void {
		const blocks = message?.content;
		if (!Array.isArray(blocks)) return;
		blocks.forEach((block: any, index: number) => this.projectBlock(index, block, sink));
	}

	private projectBlock(index: number, block: any, sink: DurableSinkLike): void {
		if (!block || typeof block !== "object") return;
		if (block.type === "text" && typeof block.text === "string") {
			this.emitRemainder(this.textSent, index, block.text, (d) => sink.onTextDelta(d));
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			this.emitRemainder(this.thinkingSent, index, block.thinking, (d) => sink.onThinkingDelta(d));
		}
	}

	private emitDelta(sent: Map<number, number>, index: number, delta: string, emit: (delta: string) => void): void {
		if (!delta) return;
		emit(delta);
		sent.set(index, (sent.get(index) ?? 0) + delta.length);
	}

	private emitRemainder(sent: Map<number, number>, index: number, text: string, emit: (delta: string) => void): void {
		const already = sent.get(index) ?? 0;
		if (text.length <= already) return;
		sent.set(index, text.length);
		emit(text.slice(already));
	}

	/**
	 * 运行期进度输出 → 增量。
	 * 引擎侧窗口语义只有两种：`{ trimStart, append }`（修剪后追加）与 `{ set }`（整体替换）。
	 */
	private projectToolUpdate(callId: string, output: any, sink: DurableSinkLike): void {
		if (!callId || !output || typeof output !== "object") return;
		if (!sink.onToolUpdate) return;
		const previous = this.toolOutput.get(callId) ?? "";
		if (typeof output.set === "string") {
			const next = output.set;
			this.toolOutput.set(callId, next);
			// 无法回撤已下发内容：仅在窗口是纯追加时补增量
			if (next.startsWith(previous) && next.length > previous.length) {
				sink.onToolUpdate(callId, next.slice(previous.length));
			}
			return;
		}
		const trim = typeof output.trimStart === "number" && output.trimStart > 0 ? output.trimStart : 0;
		const base = trim ? previous.slice(trim) : previous;
		const append = typeof output.append === "string" ? output.append : "";
		this.toolOutput.set(callId, base + append);
		if (append) sink.onToolUpdate(callId, append);
	}
}
