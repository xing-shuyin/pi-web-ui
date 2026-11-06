export interface DurableSinkLike {
	onTextDelta(delta: string): void;
	onThinkingDelta(delta: string): void;
	onToolStart?(callId: string, toolName: string, args: Record<string, unknown>): void;
	onToolUpdate?(callId: string, outputDelta: string): void;
	onToolEnd?(callId: string, result: { output?: string; error?: string }): void;
}

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

export class DurableEventProjector {
	private readonly textSent = new Map<number, number>();
	private readonly thinkingSent = new Map<number, number>();
	private assistantMessageEnded = false;
	private readonly toolOutput = new Map<string, string>();
	private readonly startedTools = new Set<string>();

	get emittedAnyText(): boolean {
		for (const length of this.textSent.values()) {
			if (length > 0) return true;
		}
		return false;
	}

	primeSnapshot(snapshot: any, sink: DurableSinkLike): void {
		this.textSent.clear();
		this.thinkingSent.clear();
		this.projectMessage(snapshot?.generation?.message, sink);
	}

	project(events: readonly any[] | undefined, sink: DurableSinkLike): void {
		if (!Array.isArray(events)) return;
		const deferred: any[] = [];
		const deferredCallIds = new Set<string>();
		for (const event of events) {
			const type = event?.type;
			if (type === "tool_execution_start") {
				deferred.push(event);
				deferredCallIds.add(String(event?.toolCallId ?? ""));
				continue;
			}
			if (
				(type === "tool_execution_update" || type === "tool_execution_end") &&
				deferredCallIds.has(String(event?.toolCallId ?? ""))
			) {
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
		} catch {}
	}

	private projectOne(event: any, sink: DurableSinkLike): void {
		if (!event || typeof event !== "object") return;
		switch (event.type) {
			case "message_start": {
				if (event.message?.role !== "assistant") return;
				this.assistantMessageEnded = false;
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
						this.projectBlock(change.contentIndex, change.block, sink);
					}
				}
				return;
			}
			case "snapshot": {
				this.projectMessage(event.generation?.message, sink);
				return;
			}
			case "message_end": {
				const message = event.entry?.model?.[0];
				if (message?.role !== "assistant") return;
				if (this.assistantMessageEnded) {
					this.textSent.clear();
					this.thinkingSent.clear();
				}
				this.projectMessage(message, sink);
				this.assistantMessageEnded = true;
				return;
			}
			case "tool_execution_start": {
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

	projectMessage(message: any, sink: DurableSinkLike): void {
		if (message?.role !== "assistant") return;
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

	private projectToolUpdate(callId: string, output: any, sink: DurableSinkLike): void {
		if (!callId || !output || typeof output !== "object") return;
		if (!sink.onToolUpdate) return;
		const previous = this.toolOutput.get(callId) ?? "";
		if (typeof output.set === "string") {
			const next = output.set;
			this.toolOutput.set(callId, next);
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
