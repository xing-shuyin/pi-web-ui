/**
 * tests/unit/qq-media.test.ts
 * QQ 通道富媒体（图片/语音/视频/文件）:
 *  - 纯函数（附件类型 → 种类/扩展名、文件名、软限制降级、展示行）
 *  - 上传链路（公网 URL / base64 直传 / 分片上传）与 msg_type=7 发送
 *  - 入站落地（下载到工作区 .pi-qq-media/，正文给绝对路径；关开关只给占位）
 *  - 出站：频道只收 URL、单聊/群聊本地文件自动上传
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QqBotBridge } from "../../plugins/qq/index.mjs";
import {
	QQ_FILE_DATA_MAX,
	effectiveFileType,
	extOfMedia,
	formatInboundMediaLines,
	inboundFileName,
	mediaKindOfContentType,
	mediaKindOfPath,
	mediaScopePath,
	mimeOfPath,
	qqFileTypeOfKind,
	sendQqMediaMessage,
	uploadQqMedia,
} from "../../plugins/qq/media.mjs";

const tmpDirs: string[] = [];
function makeTmp() {
	const dir = mkdtempSync(join(tmpdir(), "qq-media-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

describe("qq 媒体：纯函数", () => {
	it("content_type → 种类（voice/image/video/file）", () => {
		expect(mediaKindOfContentType("image/png")).toBe("image");
		expect(mediaKindOfContentType("video/mp4")).toBe("video");
		expect(mediaKindOfContentType("voice")).toBe("voice");
		expect(mediaKindOfContentType("audio/silk")).toBe("voice");
		expect(mediaKindOfContentType("file")).toBe("file");
		expect(mediaKindOfContentType("")).toBe("file");
	});

	it("种类 → QQ file_type（1 图片 / 2 视频 / 3 语音 / 4 文件）", () => {
		expect(qqFileTypeOfKind("image")).toBe(1);
		expect(qqFileTypeOfKind("video")).toBe(2);
		expect(qqFileTypeOfKind("voice")).toBe(3);
		expect(qqFileTypeOfKind("file")).toBe(4);
	});

	it("扩展名推断：MIME 优先，其次文件名，最后 URL", () => {
		expect(extOfMedia({ contentType: "image/jpeg" })).toBe(".jpg");
		expect(extOfMedia({ contentType: "image/webp" })).toBe(".webp");
		expect(extOfMedia({ filename: "报告.PDF" })).toBe(".pdf");
		expect(extOfMedia({ url: "https://cdn.x/a/b.png?x=1" })).toBe(".png");
		expect(extOfMedia({})).toBe("");
	});

	it("路径/URL 猜种类与 MIME", () => {
		expect(mediaKindOfPath("a/b.png")).toBe("image");
		expect(mediaKindOfPath("a.mp4")).toBe("video");
		expect(mediaKindOfPath("a.mp3")).toBe("voice");
		expect(mediaKindOfPath("a.zip")).toBe("file");
		expect(mimeOfPath("x.JPG")).toBe("image/jpeg");
		expect(mimeOfPath("x.unknown")).toBe("application/octet-stream");
	});

	it("超过软限制自动降级为文件类型（官方行为）", () => {
		expect(effectiveFileType(1, 5 * 1024 * 1024)).toBe(1);
		expect(effectiveFileType(1, 21 * 1024 * 1024)).toBe(4);
		expect(effectiveFileType(2, 31 * 1024 * 1024)).toBe(4);
	});

	it("落盘文件名保留扩展名、剥离危险字符，同批次不重名", () => {
		const a = inboundFileName({ contentType: "image/png", index: 0, at: 1700000000000, peer: "openid-ABC/123" });
		const b = inboundFileName({ contentType: "image/png", index: 1, at: 1700000000000, peer: "openid-ABC/123" });
		expect(a).toMatch(/^qq-[A-Za-z0-9]+-\d{14}-1\.png$/);
		expect(a).not.toBe(b);
		expect(a).not.toContain("/");
	});

	it("展示行：落盘给路径，失败给占位与原因", () => {
		const text = formatInboundMediaLines([
			{ kind: "image", path: "C:/w/.pi-qq-media/a.png" },
			{ kind: "voice", path: "C:/w/.pi-qq-media/v.wav", asrText: "今天天气不错" },
			{ kind: "file", filename: "x.pdf", reason: "下载失败：HTTP 404" },
		]);
		expect(text).toContain("[图片] 已保存到：C:/w/.pi-qq-media/a.png");
		expect(text).toContain("语音转写：今天天气不错");
		expect(text).toContain("[文件 x.pdf]（下载失败：HTTP 404）");
	});

	it("上传端点按场景隔离，缺 openid 直接报错", () => {
		expect(mediaScopePath({ type: "user", openid: "u1" })).toBe("/v2/users/u1");
		expect(mediaScopePath({ type: "group", openid: "g1" })).toBe("/v2/groups/g1");
		expect(() => mediaScopePath({ type: "user", openid: "" })).toThrow(/openid/);
		expect(() => mediaScopePath({ type: "channel", openid: "x" })).toThrow(/未知上传场景/);
	});
});

describe("qq 媒体：上传链路", () => {
	it("公网 URL 直接交给平台转存（不下载、不 base64）", async () => {
		const api = vi.fn().mockResolvedValue({ file_info: "FI_URL" });
		const info = await uploadQqMedia({
			api,
			scope: { type: "user", openid: "u1" },
			source: { url: "https://cdn.x/a.png" },
			kind: "image",
			fileName: "a.png",
		});
		expect(info).toBe("FI_URL");
		expect(api).toHaveBeenCalledWith("POST", "/v2/users/u1/files", {
			file_type: 1,
			url: "https://cdn.x/a.png",
			file_name: "a.png",
			srv_send_msg: false,
		});
	});

	it("小文件走 base64 file_data 直传", async () => {
		const api = vi.fn().mockResolvedValue({ file_info: "FI_B64" });
		const buffer = Buffer.from("hello-qq");
		const info = await uploadQqMedia({
			api,
			scope: { type: "group", openid: "g1" },
			source: { buffer },
			kind: "file",
			fileName: "hi.txt",
		});
		expect(info).toBe("FI_B64");
		const [method, path, body] = api.mock.calls[0];
		expect(method).toBe("POST");
		expect(path).toBe("/v2/groups/g1/files");
		expect(body.file_type).toBe(4);
		expect(body.file_data).toBe(buffer.toString("base64"));
		expect(body.file_name).toBe("hi.txt");
	});

	it("大文件走 预上传 → 分片 PUT → 片确认 → 合并", async () => {
		const size = QQ_FILE_DATA_MAX + 1024;
		const buffer = Buffer.alloc(size, 7);
		const put = vi.fn().mockResolvedValue(undefined);
		const api = vi.fn(async (method: string, path: string, body: any) => {
			if (path.endsWith("/upload_prepare")) {
				return {
					upload_id: "UP1",
					block_size: QQ_FILE_DATA_MAX,
					parts: [
						{ index: 0, presigned_url: "https://put/0", block_size: QQ_FILE_DATA_MAX },
						{ index: 1, presigned_url: "https://put/1", block_size: 1024 },
					],
				};
			}
			if (path.endsWith("/upload_part_finish")) return {};
			if (path.endsWith("/files")) return { file_info: "FI_CHUNK" };
			throw new Error(`unexpected ${method} ${path} ${JSON.stringify(body)}`);
		});
		const info = await uploadQqMedia({
			api,
			scope: { type: "user", openid: "u1" },
			source: { buffer },
			kind: "video",
			fileName: "big.mp4",
			put,
		});
		expect(info).toBe("FI_CHUNK");
		expect(put).toHaveBeenCalledTimes(2);
		expect(put.mock.calls[0][1].length).toBe(QQ_FILE_DATA_MAX);
		expect(put.mock.calls[1][1].length).toBe(1024);
		const prepare = api.mock.calls.find((c) => String(c[1]).endsWith("/upload_prepare"))!;
		expect(prepare[2].file_size).toBe(size);
		expect(prepare[2].md5).toMatch(/^[0-9a-f]{32}$/);
		const finish = api.mock.calls.filter((c) => String(c[1]).endsWith("/upload_part_finish"));
		expect(finish).toHaveLength(2);
		const merge = api.mock.calls.find((c) => String(c[1]).endsWith("/files"))!;
		expect(merge[2]).toMatchObject({ upload_id: "UP1", file_name: "big.mp4" });
	});

	it("超过硬限制直接拒绝，不发起任何请求", async () => {
		const api = vi.fn();
		await expect(
			uploadQqMedia({
				api,
				scope: { type: "user", openid: "u1" },
				source: { buffer: Buffer.alloc(10, 1) },
				hardLimit: 5,
			}),
		).rejects.toThrow(/硬限制/);
		expect(api).not.toHaveBeenCalled();
	});

	it("msg_type=7 发媒体：带 msg_id 是被动回复，不带是主动消息", async () => {
		const api = vi.fn().mockResolvedValue({ id: "m1" });
		await sendQqMediaMessage({
			api,
			scope: { type: "user", openid: "u1" },
			fileInfo: "FI1",
			msgId: "msg-1",
			msgSeq: 3,
			content: "看图",
		});
		expect(api).toHaveBeenCalledWith("POST", "/v2/users/u1/messages", {
			msg_type: 7,
			media: { file_info: "FI1" },
			content: "看图",
			msg_seq: 3,
			msg_id: "msg-1",
		});

		api.mockClear();
		await sendQqMediaMessage({ api, scope: { type: "group", openid: "g1" }, fileInfo: "FI2" });
		const body = api.mock.calls[0][2];
		expect(body.msg_id).toBeUndefined();
		expect(body.msg_seq).toBeUndefined();
		expect(body.media.file_info).toBe("FI2");
	});

	it("上传没回 file_info 时报错而不是发空消息", async () => {
		const api = vi.fn().mockResolvedValue({});
		await expect(
			uploadQqMedia({ api, scope: { type: "user", openid: "u1" }, source: { url: "https://x/a.png" } }),
		).rejects.toThrow(/file_info/);
	});
});

describe("qq 媒体：入站落地", () => {
	function makeBridge(configExtra: Record<string, unknown> = {}, hostExtra: Record<string, unknown> = {}) {
		const chats: any[] = [];
		const host = {
			chat: vi.fn(async (req: any) => {
				chats.push(req);
				return { conversationId: "c1", clientId: "plugin:qq:x", runId: "pr-qq-1" };
			}),
			onRunEvent: () => () => {},
			...hostExtra,
		};
		const bridge = new QqBotBridge({
			host,
			getConfig: () => ({ allowedUsers: [], inboundMedia: true, ...configExtra }),
		});
		return { bridge, host, chats };
	}

	it("图片附件下载到工作区 .pi-qq-media/，正文给绝对路径", async () => {
		const workspace = makeTmp();
		const body = Buffer.from("PNGDATA");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string) => ({ ok: true, arrayBuffer: async () => body }) as unknown as Response),
		);
		const { bridge, chats } = makeBridge({ workspace });

		await bridge.onInboundMessage(
			{
				id: "m1",
				channel_id: "ch1",
				author: { id: "u1", user_openid: "openid-1", bot: false },
				content: "这是什么图",
				attachments: [{ url: "https://cdn/a.png", content_type: "image/png", filename: "a.png", size: body.length }],
			},
			"MESSAGE_CREATE",
		);

		const dir = join(workspace, ".pi-qq-media");
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/\.png$/);
		expect(readFileSync(join(dir, files[0])).toString()).toBe("PNGDATA");
		expect(chats[0].text).toContain("这是什么图");
		expect(chats[0].text).toContain(`[图片] 已保存到：${join(dir, files[0])}`);
	});

	it("只有附件没有文字时也照常投递（不再回「请 @ 我」提示）", async () => {
		const workspace = makeTmp();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => Buffer.from("x") }) as unknown as Response),
		);
		const { bridge, chats } = makeBridge({ workspace });
		await bridge.onInboundMessage(
			{
				id: "m2",
				channel_id: "ch1",
				author: { id: "u1", user_openid: "openid-1", bot: false },
				content: "",
				attachments: [{ url: "https://cdn/a.jpg", content_type: "image/jpeg" }],
			},
			"MESSAGE_CREATE",
		);
		expect(chats).toHaveLength(1);
		expect(chats[0].text).toContain("[图片] 已保存到：");
	});

	it("图片以 imageData 进入 host.chat，音视频以引用进入且明确无 ASR", async () => {
		const workspace = makeTmp();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => Buffer.from("media") })),
		);
		const { bridge, chats } = makeBridge({ workspace });
		await bridge.onInboundMessage(
			{
				id: "actual-media",
				group_openid: "g",
				author: { id: "u" },
				content: "看附件",
				attachments: [
					{ url: "https://cdn/a.png", content_type: "image/png", filename: "a.png" },
					{ url: "https://cdn/v.silk", voice_wav_url: "https://cdn/v.wav", content_type: "voice" },
					{ url: "https://cdn/v.webm", content_type: "application/octet-stream" },
				],
			},
			"GROUP_AT_MESSAGE_CREATE",
		);
		expect(chats[0].attachments[0]).toEqual({
			path: "",
			imageData: Buffer.from("media").toString("base64"),
			mimeType: "image/png",
			name: "a.png",
		});
		expect(chats[0].attachments[1]).toMatchObject({ path: expect.stringMatching(/\.wav$/), mode: "reference" });
		expect(chats[0].text).toContain("当前插件不提供 ASR");
		expect(chats[0].text).toContain("视频尚未解析");
		await bridge.stop();
	});

	it("下载失败和关闭落地时仍保留平台 ASR", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		for (const inboundMedia of [true, false]) {
			const { bridge, chats } = makeBridge({ workspace: makeTmp(), inboundMedia });
			await bridge.onInboundMessage(
				{
					id: `asr-${inboundMedia}`,
					author: { id: "u" },
					content: "",
					attachments: [{ url: "https://cdn/v.silk", content_type: "voice", asr_refer_text: "打开灯" }],
				},
				"C2C_MESSAGE_CREATE",
			);
			expect(chats[0].text).toContain("语音转写：打开灯");
			expect(chats[0].attachments).toBeUndefined();
			await bridge.stop();
		}
	});

	it("限制图片数量，未知格式明确提示转换", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, arrayBuffer: async () => Buffer.from("image") })),
		);
		const { bridge, chats } = makeBridge({ workspace: makeTmp() });
		await bridge.onInboundMessage(
			{
				id: "limits",
				author: { id: "u" },
				content: "",
				attachments: [
					...Array.from({ length: 9 }, (_, i) => ({ url: `https://cdn/${i}.png`, content_type: "image/png" })),
					{ url: "https://cdn/a.bmp", content_type: "image/bmp" },
				],
			},
			"C2C_MESSAGE_CREATE",
		);
		expect(chats[0].attachments).toHaveLength(8);
		expect(chats[0].text).toContain("图片未注入模型");
		expect(chats[0].text).toContain("不支持此图片格式");
		expect(mediaKindOfPath("https://cdn/a.zip")).toBe("file");
		expect(extOfMedia({ contentType: "audio/mp4; codecs=aac" })).toBe(".m4a");
		await bridge.stop();
	});

	it("语音优先用 voice_wav_url 并带上 ASR 文本", async () => {
		const workspace = makeTmp();
		const fetchMock = vi.fn(
			async (_url: string) => ({ ok: true, arrayBuffer: async () => Buffer.from("WAV") }) as unknown as Response,
		);
		vi.stubGlobal("fetch", fetchMock);
		const { bridge, chats } = makeBridge({ workspace });
		await bridge.onInboundMessage(
			{
				id: "m3",
				channel_id: "ch1",
				author: { id: "u1", user_openid: "openid-1", bot: false },
				content: "",
				attachments: [
					{
						url: "https://cdn/v.silk",
						voice_wav_url: "https://cdn/v.wav",
						content_type: "voice",
						asr_refer_text: "帮我查下天气",
					},
				],
			},
			"MESSAGE_CREATE",
		);
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://cdn/v.wav");
		expect(chats[0].text).toContain("语音转写：帮我查下天气");
	});

	it("关闭 inboundMedia 时只给占位文字，不下载", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { bridge, chats } = makeBridge({ inboundMedia: false });
		await bridge.onInboundMessage(
			{
				id: "m4",
				channel_id: "ch1",
				author: { id: "u1", user_openid: "openid-1", bot: false },
				content: "看图",
				attachments: [{ url: "https://cdn/a.png", content_type: "image/png", filename: "a.png" }],
			},
			"MESSAGE_CREATE",
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(chats[0].text).toContain("[图片 a.png]（已关闭接收媒体）");
	});

	it("附件超过大小上限时降级为占位（不吞消息、不爆内存）", async () => {
		const workspace = makeTmp();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { bridge, chats } = makeBridge({ workspace });
		await bridge.onInboundMessage(
			{
				id: "m5",
				channel_id: "ch1",
				author: { id: "u1", user_openid: "openid-1", bot: false },
				content: "大文件",
				attachments: [
					{ url: "https://cdn/big.zip", content_type: "file", filename: "big.zip", size: 999 * 1024 * 1024 },
				],
			},
			"MESSAGE_CREATE",
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(chats[0].text).toContain("[文件 big.zip]（下载失败：");
	});
});
