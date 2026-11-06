import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareNativeCliPaste } from "../../server/native-cli.js";
import { saveUpload } from "../../server/uploads.js";
import { planNativeCliReferences, type NativeCliReferenceAttachment } from "../../web/src/native-cli-reference.js";

describe("planNativeCliReferences", () => {
	it("passes file, directory and inclusive line references to the server without guessing shell syntax", () => {
		const references: NativeCliReferenceAttachment[] = [
			{ path: "src/含 空格 $(touch sentinel); `code`.ts", name: "code.ts", mode: "reference" },
			{ path: "C:\\项目\\目录\\", name: "目录", mode: "reference", isDir: true },
			{ path: "src/main.ts", name: "main.ts", mode: "lines", lines: { start: 17, end: 31 } },
			{ path: "./legacy.txt", name: "legacy.txt", mode: "inline" },
		];
		const plan = planNativeCliReferences(references);
		expect(plan.text).toBe("");
		expect(plan.attachments).toEqual(references);
		expect(plan.attachments[0]).not.toBe(references[0]);
	});

	it("retains the entire selected Markdown/tool/message text and its real source", () => {
		const text = "  # 标题\r\n```sh\n$(echo literal); `command`\n```\n\u001b[31m\t尾部  ";
		const plan = planNativeCliReferences([
			{
				path: "",
				name: "选中文字",
				mode: "quote",
				quote: { text, messageId: "tool-message-7", role: "toolResult", sessionId: "session-a" },
			},
		]);
		expect(plan.attachments[0].quote?.text).toBe(text);
		expect(plan.text).toBe(
			`Quoted text source: ${JSON.stringify({ name: "选中文字", messageId: "tool-message-7", role: "toolResult", sessionId: "session-a" })}`,
		);
		expect(plan.attachments[0].quote?.messageId).toBe("tool-message-7");
	});

	it.each(["", " \t\r\n "])("does not discard a quote containing %j", (text) => {
		const plan = planNativeCliReferences([
			{ path: "", mode: "quote", quote: { text, messageId: "m", role: "assistant" } },
		]);
		expect(plan.text).toBe('Quoted text source: {"messageId":"m","role":"assistant"}');
		expect(plan.attachments[0].quote?.text).toBe(text);
	});

	it("describes page, running/history conversation and canvas metadata without turning IDs into file paths", () => {
		const plan = planNativeCliReferences([
			{ path: "https://example.com", name: '页面 "一"\nnext', mode: "page" },
			{ path: "native-tab-2", name: "原生页签", mode: "page" },
			{ path: "", name: "运行中", mode: "conversation", conversationId: "c3" },
			{ path: "", name: "历史", mode: "conversation", sessionPath: "/real/data/session one.jsonl" },
			{ path: "graph-42", name: "画布", mode: "canvas" },
		]);
		expect(plan.attachments.map((attachment) => attachment.mode)).toEqual([
			"page",
			"page",
			"conversation",
			"conversation",
			"canvas",
		]);
		expect(plan.attachments[0]).toMatchObject({ path: "https://example.com", mode: "page" });
		const blocks = plan.text.split("\n\n");
		expect(blocks.map((block) => JSON.parse(block.slice(block.indexOf(": ") + 2)))).toEqual([
			{ name: '页面 "一"\nnext', target: "https://example.com" },
			{ name: "原生页签", target: "native-tab-2" },
			{ name: "运行中", conversationId: "c3" },
			{ name: "历史", sessionPath: "/real/data/session one.jsonl" },
			{ name: "画布", graphId: "graph-42" },
		]);
		expect(blocks.map((block) => block.split(": ")[0])).toEqual([
			"Web page reference",
			"Web page reference",
			"Conversation reference",
			"Conversation reference",
			"Canvas reference",
		]);
	});

	it("keeps images, zero-byte files and restored upload paths available for the real server save mechanism", () => {
		const references: NativeCliReferenceAttachment[] = [
			{ path: "", name: "本地图片.png", imageData: "data:image/png;base64,AQID", mimeType: "image/png", key: "k" },
			{ path: "", name: "empty.txt", fileData: "", mimeType: "text/plain", size: 0 },
			{ path: "", name: "previous.pdf", uploadPath: "/actual/data/uploads/client/previous.pdf", size: 3 },
		];
		const plan = planNativeCliReferences(references);
		expect(plan).toEqual({ text: "", attachments: references });
		expect(plan.attachments.every((attachment) => attachment.path === "")).toBe(true);
		expect(plan.attachments[0].uploadPath).toBeUndefined();
		expect(plan.attachments[1].fileData).toBe("");
	});

	it("preserves duplicates and order rather than merging distinct selections or uploads", () => {
		const a: NativeCliReferenceAttachment = {
			path: "source.ts",
			mode: "lines",
			lines: Object.freeze({ start: 2, end: 3 }),
		};
		const b = Object.freeze({ ...a, lines: Object.freeze({ start: 7, end: 9 }) });
		const references = Object.freeze([Object.freeze(a), b, a]);
		expect(planNativeCliReferences(references).attachments).toEqual([a, b, a]);
		expect(references[0].lines).toEqual({ start: 2, end: 3 });
	});

	it("returns an empty plan for no references and explicitly rejects a missing quote body", () => {
		expect(planNativeCliReferences([])).toEqual({ text: "", attachments: [] });
		expect(() => planNativeCliReferences([{ path: "", name: "broken", mode: "quote" }])).toThrow(
			"Text quote is missing its source text",
		);
	});

	it("produces real readable upload paths and preserves line numbers through prepareNativeCliPaste", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-native-cli-reference-"));
		vi.stubEnv("PI_WEB_DATA_DIR", join(root, "data"));
		try {
			const workspace = join(root, "workspace");
			mkdirSync(workspace);
			writeFileSync(join(workspace, "source.ts"), "one\ntwo\nthree\n");
			mkdirSync(join(workspace, "folder"));
			const clientId = "reference-client";
			const restored = saveUpload(clientId, "restored.txt", Buffer.from("existing"));
			const plan = planNativeCliReferences([
				{ path: "source.ts", mode: "lines", lines: { start: 2, end: 3 } },
				{ path: "folder", mode: "reference", isDir: true },
				{ path: "", name: "image.png", imageData: "AQID", mimeType: "image/png" },
				{ path: "", name: "empty.txt", fileData: "", size: 0 },
				{ path: "", uploadPath: restored.abs },
			]);
			const text = prepareNativeCliPaste(plan.text, plan.attachments, workspace, { clientId, settings: {} });
			expect(text).toContain(`File path: ${JSON.stringify(realpathSync(join(workspace, "source.ts")))} (lines 2-3)`);
			expect(text).toContain(`Directory path: ${JSON.stringify(realpathSync(join(workspace, "folder")))}`);
			const paths = [...text.matchAll(/^File path: ("(?:[^"\\]|\\.)*")/gm)].map((match) => JSON.parse(match[1]));
			expect(paths).toHaveLength(4);
			expect(readFileSync(paths[1])).toEqual(Buffer.from([1, 2, 3]));
			expect(readFileSync(paths[2])).toHaveLength(0);
			expect(readFileSync(paths[3], "utf8")).toBe("existing");
			expect(text.endsWith("\n")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
