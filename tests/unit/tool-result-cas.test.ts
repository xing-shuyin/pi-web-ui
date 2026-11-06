import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAttachmentStore, saveAttachmentSync, findAttachment } from "../../server/attachment-store.js";
import { serializeMessage } from "../../server/serialize.js";

describe("toolResult 图片的 CAS 内容寻址优化", () => {
	let testDir: string;

	beforeAll(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pi-test-tool-cas-"));
		initAttachmentStore(testDir);
	});

	afterAll(async () => {
		if (testDir && existsSync(testDir)) {
			await rm(testDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("saveAttachmentSync 能同步将图片落盘并返回 CAS 记录", () => {
		const buf = Buffer.from("hello cas image sync", "utf-8");
		const rec = saveAttachmentSync(buf, "image/png");
		expect(rec.hash).toHaveLength(64);
		expect(rec.url).toBe(`/api/attachment/${rec.hash}`);
		expect(existsSync(rec.filePath)).toBe(true);

		const rec2 = saveAttachmentSync(buf, "image/png");
		expect(rec2.hash).toBe(rec.hash);
	});

	it("serializeMessage 将 toolResult 中的图片转为 /api/attachment/<hash>，避免快照膨胀", async () => {
		const rawBase64 = Buffer.from("test png binary data").toString("base64");
		const toolResult = {
			role: "toolResult",
			toolCallId: "tc-read-image",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file" },
				{ type: "image", data: rawBase64, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 123456,
		} as unknown as Parameters<typeof serializeMessage>[0];

		const msg = serializeMessage(toolResult, 0);
		expect(msg).not.toBeNull();
		expect(msg?.content).toHaveLength(2);

		const textBlock = msg?.content[0];
		expect(textBlock).toEqual({ type: "text", text: "Read image file", truncated: false });

		const imageBlock = msg?.content[1] as { type: string; dataUrl: string; mimeType: string };
		expect(imageBlock.type).toBe("image");
		expect(imageBlock.dataUrl).toMatch(/^\/api\/attachment\/[a-f0-9]{64}$/);
		expect(imageBlock.mimeType).toBe("image/png");

		const hash = imageBlock.dataUrl.replace("/api/attachment/", "");
		const rec = await findAttachment(hash);
		expect(rec).not.toBeNull();
		const savedBuf = await readFile(rec!.filePath);
		expect(savedBuf.toString("base64")).toBe(rawBase64);
	});

	it("超大图片（超过 TOOL_RESULT_IMAGE_CAP）依然安全回退为占位文本", () => {
		const hugeBase64 = "A".repeat(3_000_000);
		const toolResult = {
			role: "toolResult",
			toolCallId: "tc-huge",
			toolName: "read",
			content: [{ type: "image", data: hugeBase64, mimeType: "image/png" }],
			isError: false,
			timestamp: 123456,
		} as unknown as Parameters<typeof serializeMessage>[0];

		const msg = serializeMessage(toolResult, 0);
		expect(msg?.content).toEqual([{ type: "text", text: "[image result]", truncated: false }]);
	});
});
