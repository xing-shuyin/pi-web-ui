/**
 * buildAttachmentMessages 单元测试（零 token、零 server）。
 *
 * 覆盖编辑重问的附件恢复管线：
 *   1. 新上传的 fileData → aside 卡 details.upload === true（供浏览器按路径恢复）；
 *   2. 恢复的 uploadPath → 服务端从 uploads 目录重读字节、按同路径附加；
 *   3. uploadPath 越出本客户端 uploads 目录 → 拒绝 + notice；
 *   4. uploadPath 指向已清理/不存在文件 → notice + 跳过；
 *   5. 工作区路径附件（reference / lines / 无 mode 的 auto / 旧版 inline）一律只给
 *      路径引用（内容不进 prompt）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCanvasGraph, saveCanvasGraph } from "../../server/canvas/canvas-store.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachmentMessages, type AttachmentContext } from "../../server/attachments.js";
import { saveUpload, uploadsRoot } from "../../server/uploads.js";
import { setGlobalRemoteSshService } from "../../server/remote-ssh-service.js";

const dirs: string[] = [];

describe("canvas references", () => {
	it("loads graph metadata, escapes the title, and instructs get before an explicit run", async () => {
		const dataDir = tempDir();
		const cwd = tempDir();
		vi.stubEnv("PI_WEB_DATA_DIR", dataDir);
		const graph = createDefaultCanvasGraph("pipeline.png");
		graph.name = 'Build "UI" <safe> & test';
		saveCanvasGraph(dataDir, graph);
		// A same-named image must never reach the workspace-image prepass.
		writeFileSync(join(cwd, graph.id), "WORKSPACE SECRET");
		const notices: { level: string; text: string }[] = [];
		const ctx = makeCtx({ dataDir, cwd, notices });
		const out = (await buildAttachmentMessages(ctx, [
			{ mode: "canvas", path: graph.id, name: "stale title" },
		])) as Aside[];
		expect(out).toHaveLength(1);
		expect(out[0].message.details).toMatchObject({
			mode: "canvas",
			path: graph.id,
			name: graph.name,
			title: graph.name,
		});
		const text = out[0].message.content[0].text!;
		expect(text).toContain('<canvas-ref id="pipeline.png" title="Build &quot;UI&quot; &lt;safe&gt; &amp; test">');
		expect(text.indexOf('action="get"')).toBeLessThan(text.indexOf('action="run_all"'));
		expect(text).toContain('action="get_log"');
		expect(text).toContain("initialPrompt");
		expect(text).toContain("does not authorize or start a run");
		expect(text).not.toContain("WORKSPACE SECRET");
		expect(notices).toEqual([]);
	});

	it.each(["missing", "default", "../escape", "", "corrupt", "mismatch"])(
		"rejects invalid or missing graph %j without a file fallback",
		async (id) => {
			const dataDir = tempDir();
			vi.stubEnv("PI_WEB_DATA_DIR", dataDir);
			mkdirSync(join(dataDir, "canvas"));
			writeFileSync(join(dataDir, "canvas", "corrupt.json"), "invalid JSON");
			writeFileSync(join(dataDir, "canvas", "mismatch.json"), JSON.stringify({ id: "other" }));
			const cwd = tempDir();
			writeFileSync(join(cwd, "missing"), "WORKSPACE SECRET");
			const notices: { level: string; text: string }[] = [];
			expect(await buildAttachmentMessages(makeCtx({ dataDir, cwd, notices }), [{ mode: "canvas", path: id }])).toEqual(
				[],
			);
			expect(existsSync(join(dataDir, "canvas", "default.json"))).toBe(false);
			expect(notices).toHaveLength(1);
			expect(notices[0].level).toBe("warning");
		},
	);
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-attach-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Aside {
	message: {
		customType: string;
		details: {
			name?: string;
			title?: string;
			path?: string;
			mode?: string;
			size?: number;
			upload?: boolean;
			startLine?: number;
			endLine?: number;
			type?: string;
		};
		content: { type: string; text?: string; data?: string }[];
	};
}

function makeCtx(opts: {
	dataDir: string;
	cwd: string;
	clientId?: string;
	notices: { level: string; text: string }[];
}): AttachmentContext {
	const { notices } = opts;
	return {
		cwd: opts.cwd,
		clientId: opts.clientId ?? "test-client",
		emit: (m: { level?: string; text?: string; [k: string]: unknown }) =>
			notices.push({ level: m.level ?? "", text: m.text ?? "" }),
		settings: {
			steeringMode: "all",
			followUpMode: "all",
			promptMode: "append" as const,
			customSystemPrompt: "",
			promptTemplate: "",
			promptOverrides: {},
			promptDisabled: [],
			toolPromptOverrides: {},
			toolLazyLoading: true,
			codemodeMode: "on" as const,
			codemodeInlineBudget: 3000,
			disabledSkills: [],
			disabledExtensions: [],
			disabledAgentTools: [],
			terminalToolsEnabled: true,
			terminalBash: false,
			terminalBashIdleMs: 15000,
			terminalBashMaxForegroundMs: 60_000,
			toolWatchdogTimeoutMs: 1_200_000,
			readDirEnabled: true,
			bgAutoCleanupMin: 0,
			toolApprovalEnabled: true,
			editSoftEnabled: false,
			visionBridgeEnabled: true,
			visionBridgeModel: null,
			visionBridgePromptMode: "append" as const,
			visionBridgePrompt: "",
			scmCommitMsgPromptMode: "append" as const,
			scmCommitMsgPrompt: "",
			quickAskEnabled: true,
			quickAskModel: null,
			quickAskThinking: "off",
			quickAskSystemPrompt: "",
			quickAskExplainPrompt: "解释下: {{input}}",
			planModePromptMode: "append" as const,
			planModePrompt: "",
			reviewPrompt: "",
			reviewDisabledSkills: [],
			thinkingWrap: true,
			toolsWrap: true,
			toolImagesEnabled: true,
			keepRecentMessages: 15,
			skillsFullText: [],
			skillsCatalogMaxDesc: 250,
			skillsCatalogShowLocation: false,
			skillsCatalogBudget: 20000,
			skillsMaxFileBytes: 8192,
			skillsFullTextMaxBytes: 32768,
			quickPhrases: [],
			quickPhrasesEnabled: true,
			minimalNewChat: false,
			preserveDraftAcrossConversations: false,
			questionnaireEnabled: true,
			goalModeEnabled: true,
			parallelReminderEnabled: true,
			retryMaxAttempts: 2,
			softCapTokens: 0,
			softCapByModel: {},
		},
		// 非视觉路径下只用得到 session.model / modelRuntime 的占位（不触 SDK）。
		session: { model: null, modelRuntime: null } as unknown as AttachmentContext["session"],
	};
}

describe("buildAttachmentMessages — 编辑重问附件恢复", () => {
	it("文字引用保存原文与来源，并作为独立上下文发送", async () => {
		const quote = { text: "  const value = '<file>';\n下一行  ", messageId: "a1", role: "assistant", sessionId: "s1" };
		const notices: { level: string; text: string }[] = [];
		const dir = tempDir();
		const result = await buildAttachmentMessages(makeCtx({ dataDir: dir, cwd: dir, notices }), [
			{ path: "", mode: "quote", quote },
		]);
		expect(result).toHaveLength(1);
		expect(result[0].message.details).toMatchObject({ mode: "quote", quote });
		expect(result[0].message.content).toEqual([{ type: "text", text: expect.stringContaining(JSON.stringify(quote)) }]);
		expect(notices).toEqual([]);
	});

	it("空白引用被跳过并提示重新选择内容", async () => {
		const notices: { level: string; text: string }[] = [];
		const dir = tempDir();
		const result = await buildAttachmentMessages(makeCtx({ dataDir: dir, cwd: dir, notices }), [
			{ path: "", mode: "quote", quote: { text: " \n ", messageId: "a1", role: "assistant" } },
		]);
		expect(result).toEqual([]);
		expect(notices).toEqual([{ level: "warning", text: expect.stringContaining("重新选择") }]);
	});
	it("新 fileData 上传的 aside 卡带 upload:true（供按路径恢复）", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					fileData: Buffer.from("hello world\nfoo").toString("base64"),
					mimeType: "text/plain",
					name: "note.txt",
					size: 15,
				},
			])) as Aside[];
			expect(out.length).toBe(1);
			expect(out[0].message.customType).toBe("file");
			expect(out[0].message.details.upload).toBe(true);
			// 上传文件一律只给绝对路径引用（不再内联小文本）
			expect(out[0].message.details.mode).toBe("reference");
			const abs = out[0].message.details.path!;
			expect(abs.startsWith(uploadsRoot(dataDir).replace(/\\/g, "/"))).toBe(true);
			expect(out[0].message.content[0].text).toBe(`<file path="${abs}" size="15" />`);
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("恢复的 uploadPath 从 uploads 目录重读字节、按同路径附加", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			const clientId = "edit-client";
			// 先真正落一个上传文件，模拟“之前 prompt 上传过”
			const { abs, displayName } = saveUpload(clientId, "data.bin", Buffer.from([0, 1, 2, 3, 4]), dataDir);
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), clientId, notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					uploadPath: abs.replace(/\\/g, "/"),
					name: displayName,
					size: 5,
				},
			])) as Aside[];
			expect(out.length).toBe(1);
			// 二进制 → reference
			expect(out[0].message.details.mode).toBe("reference");
			expect(out[0].message.details.upload).toBe(true);
			expect(out[0].message.details.name).toBe(displayName);
			expect(out[0].message.details.path).toBe(abs.replace(/\\/g, "/"));
			expect(out[0].message.content[0].text).toContain('size="5"');
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("恢复的 uploadPath 越出本客户端 uploads 目录 → 拒绝 + notice", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			// 别的客户端目录里的文件
			const other = saveUpload("other-client", "x.txt", Buffer.from("x"), dataDir);
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), clientId: "edit-client", notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					uploadPath: other.abs.replace(/\\/g, "/"),
					name: "x.txt",
				},
			])) as Aside[];
			expect(out.length).toBe(0);
			expect(notices.some((n) => /路径不在本客户端上传目录/.test(n.text))).toBe(true);
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("恢复的 uploadPath 文件已被清理 → notice + 跳过", async () => {
		const dataDir = tempDir();
		const oldDataDir = process.env.PI_WEB_DATA_DIR;
		process.env.PI_WEB_DATA_DIR = dataDir;
		try {
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir, cwd: tempDir(), clientId: "edit-client", notices });
			const out = (await buildAttachmentMessages(ctx, [
				{
					path: "",
					uploadPath: uploadsRoot(dataDir).replace(/\\/g, "/").concat("/edit-client/12345-gone.txt"),
					name: "gone.txt",
				},
			])) as Aside[];
			expect(out.length).toBe(0);
			expect(notices.some((n) => /已被清理或不可读/.test(n.text))).toBe(true);
		} finally {
			if (oldDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
			else process.env.PI_WEB_DATA_DIR = oldDataDir;
		}
	});

	it("工作区路径附件：一律只给路径引用（reference / 旧 inline / lines / auto）", async () => {
		const cwd = tempDir();
		const src = join(cwd, "src");
		mkdirSync(src, { recursive: true });
		const fileA = join(src, "a.ts");
		writeFileSync(fileA, "export const a = 1;\nexport const b = 2;\n");
		const big = join(src, "big.md");
		writeFileSync(big, "x".repeat(20 * 1024));

		const notices: { level: string; text: string }[] = [];
		const ctx = makeCtx({ dataDir: tempDir(), cwd, clientId: "c", notices });
		const out = (await buildAttachmentMessages(ctx, [
			{ path: "src/a.ts", mode: "reference" },
			{ path: "src/a.ts", mode: "inline" },
			{ path: "src/a.ts", mode: "lines", lines: { start: 1, end: 1 } },
			{ path: "src/a.ts" },
			{ path: "src/big.md", mode: "reference" },
		])) as Aside[];
		expect(out.length).toBe(5);
		// 内容永不进 prompt（连 2 行的小文件也是）
		for (const card of out) {
			expect(card.message.content[0].text).not.toContain("export const a = 1");
		}
		expect(out[0].message.details.mode).toBe("reference");
		expect(out[0].message.details.path).toBe("src/a.ts");
		expect(out[0].message.content[0].text).toContain('path="src/a.ts"');
		// 旧版 inline 模式 → 当 reference 处理
		expect(out[1].message.details.mode).toBe("reference");
		expect(out[1].message.content[0].text).toContain('path="src/a.ts"');
		// 行范围 → 引用上带 lines 属性（模型据此只读那几行）
		expect(out[2].message.details.mode).toBe("lines");
		expect(out[2].message.details.startLine).toBe(1);
		expect(out[2].message.details.endLine).toBe(1);
		expect(out[2].message.content[0].text).toContain('lines="1-1"');
		// 无 mode（auto）同样只给引用
		expect(out[3].message.details.mode).toBe("reference");
		expect(out[4].message.details.mode).toBe("reference");
		expect(out[4].message.details.path).toBe("src/big.md");
	});

	it("网页引用（mode:page）：不读文件，只给模型 browser_page 的 target（origin）+ 标题", async () => {
		const notices: { level: string; text: string }[] = [];
		// cwd 是一个空目录：若实现去 stat(URL) 就会报「附件不存在」并产出 0 张卡。
		const ctx = makeCtx({ dataDir: tempDir(), cwd: tempDir(), clientId: "c", notices });
		const out = (await buildAttachmentMessages(ctx, [
			{ path: "https://search.bilibili.com/all?keyword=x", mode: "page", name: "铁手杯 · 搜索" },
		])) as Aside[];
		expect(notices).toEqual([]);
		expect(out.length).toBe(1);
		expect(out[0].message.details.mode).toBe("page");
		// 卡片名用页面标题，path 保留完整 URL（消息里可点开）
		expect(out[0].message.details.name).toBe("铁手杯 · 搜索");
		expect(out[0].message.details.path).toBe("https://search.bilibili.com/all?keyword=x");
		// 给模型的那句话：带 origin 形式的 target（扩展按 origin 判定），且明说不要去抓网页
		const text = out[0].message.content[0].text ?? "";
		expect(text).toContain('target="https://search.bilibili.com"');
		expect(text).toContain("browser_page");
		expect(text).toContain("do not fetch");
	});

	it("网页引用的标题带引号/尖括号 → 标签属性被转义，不写坏 XML", async () => {
		const ctx = makeCtx({ dataDir: tempDir(), cwd: tempDir(), clientId: "c", notices: [] });
		const out = (await buildAttachmentMessages(ctx, [
			{ path: "https://example.com/", mode: "page", name: 'a "b" <c>' },
		])) as Aside[];
		const text = out[0].message.content[0].text ?? "";
		expect(text).toContain('title="a &quot;b&quot; &lt;c&gt;"');
	});
});

describe("buildAttachmentMessages — 远程 SSH 工作区附件引用", () => {
	it("在远程 SSH 工作区下正确引用远程文件与目录", async () => {
		const remoteUri = "ssh://root@39.99.235.208:22/root/workspace/ljz";
		const mockSvc = {
			sftpStat: async (_uri: string, p: string) => {
				if (p === "/root/workspace/ljz/小区名单/全省小区台账") {
					return { isDirectory: true, isFile: false, size: 4096, mtime: Date.now() };
				}
				if (p === "/root/workspace/ljz/小区名单/全省小区台账/附件4 石家庄市居民小区台账 (2).xls") {
					return { isDirectory: false, isFile: true, size: 10240, mtime: Date.now() };
				}
				throw new Error("File not found");
			},
			sftpReadFile: async () => ({ data: Buffer.from("mock"), size: 4 }),
		};

		setGlobalRemoteSshService(mockSvc as any);
		try {
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir: tempDir(), cwd: remoteUri, clientId: "c", notices });
			const out = (await buildAttachmentMessages(ctx, [
				{ path: "小区名单/全省小区台账", mode: "reference" },
				{ path: "小区名单/全省小区台账/附件4 石家庄市居民小区台账 (2).xls", mode: "reference" },
			])) as Aside[];

			expect(notices).toEqual([]);
			expect(out).toHaveLength(2);

			// 目录引用
			expect(out[0].message.details.type).toBe("folder");
			expect(out[0].message.details.path).toBe("小区名单/全省小区台账");
			expect(out[0].message.content[0].text).toContain('<folder path="小区名单/全省小区台账" />');

			// 文件引用
			expect(out[1].message.details.mode).toBe("reference");
			expect(out[1].message.details.path).toBe("小区名单/全省小区台账/附件4 石家庄市居民小区台账 (2).xls");
			expect(out[1].message.details.size).toBe(10240);
			expect(out[1].message.content[0].text).toContain(
				'<file path="小区名单/全省小区台账/附件4 石家庄市居民小区台账 (2).xls" size="10240" />',
			);
		} finally {
			setGlobalRemoteSshService(null as any);
		}
	});

	it("在远程 SSH 工作区下正确识别不存在的文件并提示错误", async () => {
		const remoteUri = "ssh://root@39.99.235.208:22/root/workspace/ljz";
		const mockSvc = {
			sftpStat: async () => {
				throw new Error("File not found");
			},
		};

		setGlobalRemoteSshService(mockSvc as any);
		try {
			const notices: { level: string; text: string }[] = [];
			const ctx = makeCtx({ dataDir: tempDir(), cwd: remoteUri, clientId: "c", notices });
			const out = await buildAttachmentMessages(ctx, [{ path: "nonexistent.txt", mode: "reference" }]);

			expect(out).toHaveLength(0);
			expect(notices).toHaveLength(1);
			expect(notices[0].level).toBe("error");
			expect(notices[0].text).toContain("附件不存在：nonexistent.txt");
		} finally {
			setGlobalRemoteSshService(null as any);
		}
	});
});

describe("buildAttachmentMessages — 对话引用（mode:conversation）", () => {
	it("运行中对话：只发 <conversation-ref>，转录不内联（AI 按需读）", async () => {
		const ctx = makeCtx({ dataDir: tempDir(), cwd: tempDir(), clientId: "c", notices: [] });
		const out = (await buildAttachmentMessages(ctx, [
			{ path: "", mode: "conversation", conversationId: "c3", name: "修 bug" },
		])) as Aside[];
		expect(out.length).toBe(1);
		expect(out[0].message.details.mode).toBe("conversation");
		expect(out[0].message.details.name).toBe("修 bug");
		expect(out[0].message.details.path).toBe("c3");
		const text = out[0].message.content[0].text ?? "";
		expect(text).toContain("<conversation-ref");
		expect(text).toContain('id="c3"');
		expect(text).toContain('conversation tool with action="read"');
	});

	it("历史会话：ref 带 path，卡片 path 保留转录路径", async () => {
		const ctx = makeCtx({ dataDir: tempDir(), cwd: tempDir(), clientId: "c", notices: [] });
		const out = (await buildAttachmentMessages(ctx, [
			{ path: "", mode: "conversation", sessionPath: "/s/1.jsonl", name: "买菜" },
		])) as Aside[];
		expect(out.length).toBe(1);
		expect(out[0].message.details.mode).toBe("conversation");
		expect(out[0].message.details.path).toBe("/s/1.jsonl");
		const text = out[0].message.content[0].text ?? "";
		expect(text).toContain('path="/s/1.jsonl"');
		expect(text).toContain('conversation tool with action="read"');
	});

	it("既无 id 又无 path → 跳过 + warning notice", async () => {
		const notices: { level: string; text: string }[] = [];
		const ctx = makeCtx({ dataDir: tempDir(), cwd: tempDir(), clientId: "c", notices });
		const out = await buildAttachmentMessages(ctx, [{ path: "", mode: "conversation", name: "空" }]);
		expect(out.length).toBe(0);
		expect(notices.length).toBe(1);
		expect(notices[0].level).toBe("warning");
	});
});
