import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConversationOrder,
	conversationOrderScope,
	type ConversationOrderStorage,
} from "../../web/src/conversation-order";

const scope = conversationOrderScope("pi", "/project");
const ids = <T extends { id: string }>(items: T[]) => items.map((item) => item.id);
const identity = <T>(item: T) => item;

/** 内存版存储：模拟同一份 localStorage 在两次「刷新」之间保持不变。 */
function memoryStorage(): ConversationOrderStorage & { raw: () => string | null } {
	let value: string | null = null;
	return {
		read: () => value,
		write: (data: string) => {
			value = data;
		},
		raw: () => value,
	};
}

/** 落盘有 250ms 合并窗口，测试里把它推过去。 */
async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(300);
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("会话顺序持久化", () => {
	it("刷新后保持原顺序，不按服务端最新的 modified 重排", async () => {
		vi.useFakeTimers();
		const storage = memoryStorage();
		const page1 = new ConversationOrder(storage);
		const items = [
			{ id: "newer", modified: 200 },
			{ id: "older", modified: 100 },
		];
		expect(ids(page1.sort(scope, items, identity))).toEqual(["newer", "older"]);
		await settle();

		// 服务端时间戳整体变化（比如刚打开的会话被刷新了 mtime）也不该改变位置。
		const reloaded = [
			{ id: "older", modified: 900 },
			{ id: "newer", modified: 800 },
		];
		const page2 = new ConversationOrder(storage);
		expect(ids(page2.sort(scope, reloaded, identity))).toEqual(["newer", "older"]);
	});

	it("刷新后新出现的会话仍然追加在末尾", async () => {
		vi.useFakeTimers();
		const storage = memoryStorage();
		const page1 = new ConversationOrder(storage);
		page1.sort(
			scope,
			[
				{ id: "a", modified: 300 },
				{ id: "b", modified: 200 },
			],
			identity,
		);
		await settle();

		const page2 = new ConversationOrder(storage);
		const after = page2.sort(
			scope,
			[
				{ id: "fresh", modified: 9999 },
				{ id: "a", modified: 300 },
				{ id: "b", modified: 200 },
			],
			identity,
		);
		expect(ids(after)).toEqual(["a", "b", "fresh"]);
	});

	it("用户发送消息的置顶在刷新后仍然有效", async () => {
		vi.useFakeTimers();
		const storage = memoryStorage();
		const page1 = new ConversationOrder(storage);
		const items = [
			{ id: "top", modified: 300 },
			{ id: "picked", modified: 100 },
		];
		page1.sort(scope, items, identity);
		page1.promote(scope, items[1]);
		await settle();

		const page2 = new ConversationOrder(storage);
		expect(ids(page2.sort(scope, items, identity))).toEqual(["picked", "top"]);
	});

	it("没有存储后端时保持旧行为：新页面按最新时间重排", () => {
		const items = [
			{ id: "older", modified: 900 },
			{ id: "newer", modified: 800 },
		];
		expect(ids(new ConversationOrder(null).sort(scope, items, identity))).toEqual(["older", "newer"]);
	});

	it("clear() 会清掉持久化，刷新后不会把旧顺序带回来", async () => {
		vi.useFakeTimers();
		const storage = memoryStorage();
		const page1 = new ConversationOrder(storage);
		page1.sort(
			scope,
			[
				{ id: "a", modified: 2 },
				{ id: "b", modified: 1 },
			],
			identity,
		);
		await settle();
		page1.clear();

		const page2 = new ConversationOrder(storage);
		const after = page2.sort(
			scope,
			[
				{ id: "b", modified: 2 },
				{ id: "a", modified: 1 },
			],
			identity,
		);
		expect(ids(after)).toEqual(["b", "a"]);
	});

	it("坏数据不影响排序：解析失败就当没有持久化", () => {
		const storage: ConversationOrderStorage = { read: () => "{not json", write: () => {} };
		const items = [
			{ id: "older", modified: 900 },
			{ id: "newer", modified: 800 },
		];
		expect(ids(new ConversationOrder(storage).sort(scope, items, identity))).toEqual(["older", "newer"]);
	});

	it("不同项目 / 引擎互不串台，恢复后 key 不变", async () => {
		vi.useFakeTimers();
		const storage = memoryStorage();
		const other = conversationOrderScope("pi", "/other");
		const page1 = new ConversationOrder(storage);
		page1.sort(scope, [{ id: "x", modified: 2 }], identity);
		page1.sort(other, [{ id: "y", modified: 1 }], identity);
		const keyX = page1.key(scope, { id: "x" });
		const keyY = page1.key(other, { id: "y" });
		await settle();

		// 恢复后各自的位置原样保留。
		const page2 = new ConversationOrder(storage);
		expect(page2.key(scope, { id: "x" })).toBe(keyX);
		expect(page2.key(other, { id: "y" })).toBe(keyY);
		// 别的项目里的会话不会凭空出现在这个项目里：它得分配一个新 key。
		expect(page2.key(scope, { id: "y" })).toBeGreaterThan(Math.max(keyX, keyY));
	});
});
