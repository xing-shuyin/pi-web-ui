import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「不打补丁」的制度保证（issues/929）。
 *
 * 这一组断言不验行为，只验**形状**：所有「现在能不能投递」的知识必须收在
 * `server/conversation-delivery.ts` 与 `ClientSession.deliveryModeOf()` 两处。
 * 谁想再补一个 `if (isCompacting)` 或者再手写一次 `deliverAs: "steer"`，
 * 这里就会红，并指向该用的入口。
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const serviceSource = readFileSync(`${ROOT}server/agent-service.ts`, "utf8");
const deliverySource = readFileSync(`${ROOT}server/conversation-delivery.ts`, "utf8");

function count(source: string, needle: string | RegExp): number {
	const pattern = typeof needle === "string" ? needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : needle.source;
	return (source.match(new RegExp(pattern, "g")) ?? []).length;
}

describe("投递门单源（conversation-delivery.ts）", () => {
	it("纯逻辑：不 import SDK，也不 import agent-service（避免拿运行时当判定）", () => {
		expect(deliverySource).not.toContain("@earendil-works");
		expect(deliverySource).not.toContain("agent-service");
	});

	it("「压缩进行中」的文案匹配只允许出现在这里（别处请用 deliveryMode）", () => {
		expect(deliverySource).toContain("compaction is in progress");
		// 拿错误文案当门禁的唯一合法位置就是 conversation-delivery 的 isCompactionRejection。
		expect(count(serviceSource, /\/compaction is in progress\//i)).toBe(0);
		// 面向用户的提示文案可以提到这件事，但不能再拿它做判定。
		// import 一行 + 两处调用（开轮时撞上门、调度器抢先一步）。
		expect(count(serviceSource, /isCompactionRejection/)).toBe(3);
	});

	it("deliveryMode 是唯一判定：门相位的写者只应有 queued/running 两个构造函数", () => {
		expect(deliverySource).toContain("export function deliveryMode");
		expect(deliverySource).toContain("export function queuedCompaction");
		expect(deliverySource).toContain("export function runningCompaction");
	});
});

describe("agent-service 不许再长出第十五种投递（issues/929 防回归）", () => {
	it("旧的三套压缩字段已删除，统一成 conv.compaction", () => {
		expect(count(serviceSource, /conv\.pendingCompaction|this\.pendingCompaction/)).toBe(0);
		expect(count(serviceSource, /compactionState/)).toBe(0);
		expect(count(serviceSource, /compactionPending/)).toBe(0);
	});

	it("isCompacting 只允许 4 处出现（门判定 / 交互提示 / 驱逐保留 / 删除前守卫），其余走 deliveryModeOf", () => {
		const hits = count(serviceSource, "isCompacting");
		expect(hits, "新增的 isCompacting 直读请改成 this.deliveryModeOf(conv)，否则又多一个不认识门的调用点").toBe(4);
	});

	it('deliverAs: "steer" 只允许出现在 submitText 一处', () => {
		expect(count(serviceSource, 'deliverAs: "steer"')).toBe(1);
		expect(serviceSource).toContain("private async submitText(");
	});

	it("SDK 的 steering 队列只允许两处使用（活轮投递 + 队列编辑回滚）", () => {
		expect(
			count(serviceSource, /\.steer\(/),
			"往 steering 队列塞消息只在「有一轮活着」时成立；门关时请 park 到 ConversationDelivery",
		).toBe(2);
	});

	it("直接调用 SDK 投递的站点数量有上限（新增请走 submitText / deliverFromOutside）", () => {
		expect(
			count(serviceSource, "sendUserMessage("),
			"新增投递点请用 this.submitText() 或 this.deliverFromOutside()，不要直连 SDK",
		).toBeLessThanOrEqual(10);
	});
});
