import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「不打补丁」的制度保证（issues/929）。
 *
 * 所有「现在能不能投递」的知识必须收在 `server/conversation-delivery.ts`。
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const deliverySource = readFileSync(`${ROOT}server/conversation-delivery.ts`, "utf8");

describe("投递门单源（conversation-delivery.ts）", () => {
	it("纯逻辑：不 import SDK，也不 import agent-service（避免拿运行时当判定）", () => {
		expect(deliverySource).not.toContain("@earendil-works");
		expect(deliverySource).not.toContain("agent-service");
	});

	it("「压缩进行中」的文案匹配只允许出现在这里（别处请用 deliveryMode）", () => {
		expect(deliverySource).toContain("compaction is in progress");
	});

	it("deliveryMode 是唯一判定：门相位的写者只应有 queued/running 两个构造函数", () => {
		expect(deliverySource).toContain("export function deliveryMode");
		expect(deliverySource).toContain("export function queuedCompaction");
		expect(deliverySource).toContain("export function runningCompaction");
	});
});
