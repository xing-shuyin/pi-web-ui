import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import type { LocalBot } from "../../server/device-center/bots.js";
import {
	BOT_CHAT_ENTRY,
	acquireBotChatLease,
	botChatSessionDir,
	latestBotChatTranscript,
	pickBotChatConversation,
	setBotChatHost,
} from "../../server/device-center/bot-chat.js";
import { fakeClientSession, protoMethod } from "../helpers/fake-session.js";

/**
 * 私聊默认「回到同一个对话」的两个判定件：
 * - 内存里开着的私聊 → 直接切回去（当前活跃的优先，其次最近用过的）；
 * - 磁盘上最近一次的私聊转录 → 重新打开（只认带 `webui/bot-chat` 且 botId 对得上的文件）。
 */
describe("pickBotChatConversation：回到同一个私聊", () => {
	it("优先当前活跃的那条，不看 lastActiveAt", () => {
		const convs = [
			{ id: "a", botId: "bot-1", lastActiveAt: 10 },
			{ id: "b", botId: "bot-1", lastActiveAt: 99 },
		];
		expect(pickBotChatConversation(convs, "bot-1", "a")?.id).toBe("a");
	});

	it("活跃的不是这个 Bot 时选最近用过的那条", () => {
		const convs = [
			{ id: "other", botId: "bot-2", lastActiveAt: 999 },
			{ id: "a", botId: "bot-1", lastActiveAt: 10 },
			{ id: "b", botId: "bot-1", lastActiveAt: 42 },
		];
		expect(pickBotChatConversation(convs, "bot-1", "other")?.id).toBe("b");
	});

	it("跳过子代理 / 临时 / 原生 CLI / 过户中的会话", () => {
		const convs = [
			{ id: "sub", botId: "bot-1", lastActiveAt: 500, isSubagent: true },
			{ id: "eph", botId: "bot-1", lastActiveAt: 400, isEphemeral: true },
			{ id: "cli", botId: "bot-1", lastActiveAt: 300, nativeCli: { config: {} } },
			{ id: "moving", botId: "bot-1", lastActiveAt: 200, transferring: true },
			{ id: "real", botId: "bot-1", lastActiveAt: 1 },
		];
		expect(pickBotChatConversation(convs, "bot-1")?.id).toBe("real");
	});

	it("没有这个 Bot 的会话就返回 undefined（交给建新会话那条路）", () => {
		expect(pickBotChatConversation([{ id: "x", botId: "bot-2" }], "bot-1")).toBeUndefined();
	});
});

describe("latestBotChatTranscript：磁盘上最近一次的私聊", () => {
	function writeTranscript(dir: string, name: string, entries: object[], mtimeMs: number): string {
		const path = join(dir, name);
		writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
		utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
		return path;
	}

	it("按最新 mtime 取，且必须带 webui/bot-chat 与对应 botId", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "bot-chat-"));
		const dir = botChatSessionDir(agentDir, "bot-1");
		mkdirSync(dir, { recursive: true });
		const older = writeTranscript(
			dir,
			"2026-01-01_a.jsonl",
			[
				{ type: "session", cwd: "/w" },
				{ type: "custom", customType: BOT_CHAT_ENTRY, data: { botId: "bot-1" } },
			],
			1_000,
		);
		const newer = writeTranscript(
			dir,
			"2026-01-02_b.jsonl",
			[
				{ type: "session", cwd: "/w" },
				{ type: "custom", customType: BOT_CHAT_ENTRY, data: { botId: "bot-1" } },
			],
			2_000,
		);
		// 更新的文件但属于别的 Bot：不许冒充。
		writeTranscript(
			dir,
			"2026-01-03_c.jsonl",
			[
				{ type: "session", cwd: "/w" },
				{ type: "custom", customType: BOT_CHAT_ENTRY, data: { botId: "bot-2" } },
			],
			3_000,
		);
		expect(latestBotChatTranscript(agentDir, "bot-1")).toBe(newer);
		// Bot 的工作目录换了：旧转录记的还是旧 cwd，不认它（否则重开会撞 Bot cwd is fixed）。
		expect(latestBotChatTranscript(agentDir, "bot-1", "/other-workspace")).toBeUndefined();
		expect(latestBotChatTranscript(agentDir, "bot-1", "/w")).toBe(newer);
		expect(older).not.toBe(newer);
	});

	it("没有转录（目录不存在）时返回 undefined", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "bot-chat-empty-"));
		expect(latestBotChatTranscript(agentDir, "bot-1")).toBeUndefined();
	});
});

describe("acquireBotChatLease：私聊回合持租约", () => {
	afterEach(() => setBotChatHost(undefined as never));

	it("host 提供 acquireLease 时原样返回它的租约", async () => {
		const release = vi.fn();
		setBotChatHost({ resolve: async () => undefined, acquireLease: async () => ({ release }) });
		const lease = await acquireBotChatLease("bot-1");
		lease.release();
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("host 不支持租约时给 no-op（内存执行/单测不阻塞）", async () => {
		setBotChatHost({ resolve: async () => undefined });
		const lease = await acquireBotChatLease("bot-1");
		expect(() => lease.release()).not.toThrow();
	});
});

describe("ClientSession.openBotChat：点一行就是回到同一个私聊", () => {
	const openBotChat = protoMethod(ClientSession.prototype, "openBotChat") as unknown as (
		botId: string,
		opts?: { fresh?: boolean },
	) => Promise<boolean>;

	const bot = (): LocalBot => ({
		id: "bot-1",
		name: "爱山东",
		description: "",
		systemPrompt: "你是爱山东。",
		cwd: process.cwd(),
		tools: ["read"],
		skills: [],
		mcpServers: [],
		enabled: true,
		revision: 1,
	});

	function makeSession(
		options: {
			convs?: Array<Record<string, unknown>>;
			agentDir?: string;
			/** 当前客户端工作目录（默认 = 这个 Bot 的 cwd，即"不需要切工作区"）。 */
			cwd?: string;
			/** 覆盖 setCwd（默认真的把 cwd 改掉，模拟切成功）。 */
			setCwd?: (next: string, opts?: { forBotChat?: boolean }) => Promise<void>;
		} = {},
	) {
		const switchConversation = vi.fn(async () => {});
		const switchSession = vi.fn(async () => {});
		const newChat = vi.fn(async () => true);
		const convs = new Map<string, unknown>();
		for (const conv of options.convs ?? []) convs.set(String(conv.id), conv);
		let session: ReturnType<typeof fakeClientSession>;
		const setCwd =
			options.setCwd ??
			vi.fn(async (next: string) => {
				session.cwd = next;
			});
		session = fakeClientSession({
			activeId: "active",
			cwd: options.cwd ?? process.cwd(),
			agentDir: options.agentDir ?? mkdtempSync(join(tmpdir(), "bot-chat-agent-")),
			convs,
			switchConversation,
			switchSession,
			newChat,
			setCwd,
			emit: vi.fn(),
			pushSettings: vi.fn(),
			flushSnapshot: vi.fn(),
			quiesceBlocked: () => false,
		});
		return { session, switchConversation, switchSession, newChat, setCwd };
	}

	afterEach(() => setBotChatHost(undefined as never));

	it("内存里已经开着它的私聊：切过去，不新建、不读磁盘", async () => {
		setBotChatHost({ resolve: async () => bot() });
		const { session, switchConversation, switchSession, newChat } = makeSession({
			convs: [{ id: "conv-bot", botId: "bot-1", cwd: process.cwd(), lastActiveAt: 1 }],
		});
		await expect(openBotChat.call(session, "bot-1")).resolves.toBe(true);
		expect(switchConversation).toHaveBeenCalledWith("conv-bot");
		expect(switchSession).not.toHaveBeenCalled();
		expect(newChat).not.toHaveBeenCalled();
	});

	it("当前就停在它的私聊上：什么都不做（不重建会话）", async () => {
		setBotChatHost({ resolve: async () => bot() });
		const { session, switchConversation, switchSession, newChat } = makeSession({
			convs: [{ id: "active", botId: "bot-1", cwd: process.cwd() }],
		});
		await openBotChat.call(session, "bot-1");
		expect(switchConversation).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
		expect(newChat).not.toHaveBeenCalled();
	});

	it("内存里没有、磁盘上有最近一次转录：重新打开那一条", async () => {
		setBotChatHost({ resolve: async () => bot() });
		const agentDir = mkdtempSync(join(tmpdir(), "bot-chat-agent-"));
		const dir = botChatSessionDir(agentDir, "bot-1");
		mkdirSync(dir, { recursive: true });
		const transcript = join(dir, "2026-01-01_a.jsonl");
		writeFileSync(
			transcript,
			[
				JSON.stringify({ type: "session", cwd: process.cwd() }),
				JSON.stringify({ type: "custom", customType: BOT_CHAT_ENTRY, data: { botId: "bot-1" } }),
			].join("\n"),
			"utf8",
		);
		const { session, switchConversation, switchSession, newChat } = makeSession({ agentDir });
		await openBotChat.call(session, "bot-1");
		expect(switchSession).toHaveBeenCalledWith(transcript);
		expect(switchConversation).not.toHaveBeenCalled();
		expect(newChat).not.toHaveBeenCalled();
	});

	it("都没有才新建一条（botId 绑在会话上）", async () => {
		setBotChatHost({ resolve: async () => bot() });
		const { session, switchSession, newChat } = makeSession();
		await openBotChat.call(session, "bot-1");
		expect(newChat).toHaveBeenCalledWith(undefined, false, undefined, true, "bot-1");
		expect(switchSession).not.toHaveBeenCalled();
	});

	it("fresh:true 跳过复用，直接新建（旧记录保留）", async () => {
		setBotChatHost({ resolve: async () => bot() });
		const { session, switchConversation, switchSession, newChat } = makeSession({
			convs: [{ id: "conv-bot", botId: "bot-1", lastActiveAt: 9 }],
		});
		await openBotChat.call(session, "bot-1", { fresh: true });
		expect(newChat).toHaveBeenCalledWith(undefined, false, undefined, true, "bot-1");
		expect(switchConversation).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
	});

	it("Bot 的工作目录 != 当前项目：先切工作区，再建私聊", async () => {
		const botCwd = join(tmpdir(), "bot-workspace-elsewhere");
		setBotChatHost({ resolve: async () => ({ ...bot(), cwd: botCwd }) });
		const { session, setCwd, newChat } = makeSession({ cwd: mkdtempSync(join(tmpdir(), "other-project-")) });
		await expect(openBotChat.call(session, "bot-1")).resolves.toBe(true);
		expect(setCwd).toHaveBeenCalledWith(botCwd, { forBotChat: true });
		expect(newChat).toHaveBeenCalledWith(undefined, false, undefined, true, "bot-1");
	});

	it("切工作区失败：不建会话，给可读提示（不再只报 Bot execution cwd mismatch）", async () => {
		setBotChatHost({ resolve: async () => ({ ...bot(), cwd: join(tmpdir(), "bot-workspace-unreachable") }) });
		const { session, newChat } = makeSession({
			cwd: mkdtempSync(join(tmpdir(), "other-project-")),
			setCwd: async () => {},
		});
		await expect(openBotChat.call(session, "bot-1")).resolves.toBe(false);
		expect(newChat).not.toHaveBeenCalled();
		expect(session.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "error" }));
	});

	it("Bot 被删/停用：不建会话，只给错误提示", async () => {
		setBotChatHost({ resolve: async () => ({ ...bot(), enabled: false }) });
		const { session, switchSession, newChat } = makeSession();
		const emit = session.emit as ReturnType<typeof vi.fn>;
		await expect(openBotChat.call(session, "bot-1")).resolves.toBe(false);
		expect(newChat).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "notice", level: "error" }));
	});
});
