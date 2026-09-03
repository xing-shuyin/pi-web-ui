/**
 * buildAttachmentMessages 单元测试（零 token、零 server）。
 *
 * 覆盖编辑重问的附件恢复管线：
 *   1. 新上传的 fileData → aside 卡 details.upload === true（供浏览器按路径恢复）；
 *   2. 恢复的 uploadPath → 服务端从 uploads 目录重读字节、按同路径附加；
 *   3. uploadPath 越出本客户端 uploads 目录 → 拒绝 + notice；
 *   4. uploadPath 指向已清理/不存在文件 → notice + 跳过；
 *   5. 工作区路径附件（reference/inline/lines）原样重附加。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttachmentMessages, type AttachmentContext } from "../../server/attachments.js";
import { saveUpload, uploadsRoot } from "../../server/uploads.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-attach-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Aside {
	message: {
		customType: string;
		details: {
			name?: string;
			path?: string;
			mode?: string;
			size?: number;
			upload?: boolean;
			startLine?: number;
			endLine?: number;
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
			promptMode: "append" as const,
			customSystemPrompt: "",
			disabledSkills: [],
			disabledExtensions: [],
			terminalToolsEnabled: true,
			terminalBash: false,
			terminalBashIdleMs: 15000,
			visionBridgeEnabled: true,
			visionBridgeModel: null,
			visionBridgePromptMode: "append" as const,
			visionBridgePrompt: "",
			reviewPrompt: "",
			reviewDisabledSkills: [],
			thinkingWrap: true,
			toolsWrap: true,
		},
		// 非视觉路径下只用得到 session.model / modelRuntime 的占位（不触 SDK）。
		session: { model: null, modelRuntime: null } as unknown as AttachmentContext["session"],
	};
}

describe("buildAttachmentMessages — 编辑重问附件恢复", () => {
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
			// 文本小文件 → inline，路径是 uploads 目录下的绝对路径
			expect(out[0].message.details.mode).toBe("inline");
			const abs = out[0].message.details.path!;
			expect(abs.startsWith(uploadsRoot(dataDir).replace(/\\/g, "/"))).toBe(true);
			expect(out[0].message.content[0].text).toContain("hello world");
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

	it("工作区路径附件（reference / inline / lines）原样重附加", async () => {
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
			{ path: "src/big.md", mode: "reference" },
		])) as Aside[];
		expect(out.length).toBe(4);
		expect(out[0].message.details.mode).toBe("reference");
		expect(out[0].message.details.path).toBe("src/a.ts");
		expect(out[1].message.details.mode).toBe("inline");
		expect(out[1].message.content[0].text).toContain("export const a = 1");
		expect(out[2].message.details.mode).toBe("lines");
		expect(out[2].message.details.startLine).toBe(1);
		expect(out[2].message.details.endLine).toBe(1);
		expect(out[3].message.details.mode).toBe("reference");
		expect(out[3].message.details.path).toBe("src/big.md");
	});
});
