import type { ServerMessage } from "../../protocol.js";
import type { UiDialogKind, UiDialogOpenOptions, UiDialogSurface, UiDialogValue } from "../../contracts/ui-bridge.js";

export interface UiDialogTableOptions {
	/** 帧出口（`dialog` / `dialog_closed`）：宿主那份是它自己的 `emit`，内核那份是 `transport.send`。 */
	emit(msg: ServerMessage): void;
	/** headless（子代理 / 后台会话）：不进表、不等浏览器，直接 `null`（老实现同口径）。 */
	headless?: boolean;
}

interface PendingDialog {
	kind: UiDialogKind;
	resolve(value: UiDialogValue): void;
}

/**
 * dialog 挂起表：**唯一实现**，老宿主（`server/webui-context.ts`）与内核 handler 共用一份。
 *
 * 不变式（改这里之前先读）：
 * 1. **先摘表 → 再 resolve → 再出帧**。反过来会出两个 bug：resolve 抛错时表里留下死条目；
 *    帧先到时前端已经认为「这条关了」，回包又被当成新的。
 * 2. 每条 id 只会 settle 一次（`Map.delete` 的返回值就是那道闸），重复回包是空操作。
 * 3. `cancelAll()`（断开 / 关对话 / dispose）必须把每条都兑现成 `null`：漏一条就是一个永不 settle 的
 *    Promise，扩展会一直挂在那儿。
 */
export class UiDialogTable implements UiDialogSurface {
	private seq = 0;
	private readonly entries = new Map<number, PendingDialog>();

	constructor(private readonly options: UiDialogTableOptions) {}

	open(
		kind: UiDialogKind,
		title: string,
		args: readonly unknown[],
		options: UiDialogOpenOptions = {},
	): Promise<UiDialogValue> {
		if (this.options.headless === true) return Promise.resolve(null);
		return new Promise<UiDialogValue>((resolve) => {
			const id = ++this.seq;
			this.entries.set(id, { kind, resolve });
			this.options.emit({
				type: "dialog",
				id,
				kind,
				title,
				args: [...args],
				...(options.code ? { code: options.code } : {}),
			});
		});
	}

	resolve(id: number, value: UiDialogValue): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		entry.resolve(value);
		this.options.emit({ type: "dialog_closed", id });
	}

	cancelAll(): number {
		const ids = [...this.entries.keys()];
		for (const id of ids) this.resolve(id, null);
		return ids.length;
	}

	pending(): readonly { id: number; kind: UiDialogKind }[] {
		return [...this.entries].map(([id, entry]) => ({ id, kind: entry.kind }));
	}

	/** 表里还剩几条（宿主 refresh / 测试用；surface 不暴露）。 */
	size(): number {
		return this.entries.size;
	}
}
