import type { UiOverlaySink, UiOverlaySurface } from "../../contracts/ui-bridge.js";

/**
 * 虚拟 TUI overlay 的路由表：**唯一实现**，宿主（`server/webui-context.ts` 的 `activeTuiOverlays`）
 * 与内核 handler 共用一份。
 *
 * 内核只做三件事：发 id、按 id 找回路、会话结束/断开时全取消。**渲染与键解析全在宿主**
 * （`server/virtual-tui.ts` 的 `VirtualTuiBridge` + `pi-tui` 的 `Component`），所以这张表不碰任何 SDK 类型。
 *
 * 不变式：`cancel(id)` **先摘表再调 `sink.cancel()`** —— 宿主的 cancel 会走它的 `onClose`（那里可能再调
 * `remove(id)`），重入时表里已经没这条，不会二次取消；同时保证「取消过的 id 再也喂不进键」。
 */
export class UiOverlayTable implements UiOverlaySurface {
	private seq = 0;
	private readonly sinks = new Map<number, UiOverlaySink>();

	register(sink: UiOverlaySink): number {
		const id = ++this.seq;
		this.sinks.set(id, sink);
		return id;
	}

	remove(id: number): boolean {
		return this.sinks.delete(id);
	}

	input(id: number, data: string): void {
		this.sinks.get(id)?.feedInput(data);
	}

	resize(id: number, cols: number, rows: number): void {
		this.sinks.get(id)?.resize(cols, rows);
	}

	cancel(id: number): void {
		const sink = this.sinks.get(id);
		if (!sink) return;
		this.sinks.delete(id);
		sink.cancel();
	}

	cancelAll(): number {
		const ids = [...this.sinks.keys()];
		for (const id of ids) this.cancel(id);
		return ids.length;
	}

	size(): number {
		return this.sinks.size;
	}

	/** 这条 overlay 还在不在（宿主 `tui_overlay_*` 帧之前用它兜一次；surface 不暴露）。 */
	has(id: number): boolean {
		return this.sinks.has(id);
	}
}
