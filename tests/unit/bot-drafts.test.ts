import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BOT_DRAFT_MAX_PENDING,
	BOT_DRAFT_TTL_MS,
	createBotDraftStore,
	normalizeBotDraft,
} from "../../server/device-center/bot-drafts.js";

const dirs: string[] = [];

async function storeAt(clock = { now: Date.UTC(2026, 1, 11) }) {
	const dir = await mkdtemp(join(tmpdir(), "pi-bot-drafts-"));
	dirs.push(dir);
	return { store: createBotDraftStore(dir, () => clock.now), clock, dir };
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const allowed = new Set(["bash", "read", "write", "memory", "web_fetch"]);
const draftInput = {
	name: "Issue 管家",
	description: "盯着 GitHub issue 并写回复草稿",
	systemPrompt: "你负责整理 issue，回复简短、有依据。",
	cwd: "/work/issue-bot",
	tools: ["read", "memory"],
};

describe("一句话创建的草案层", () => {
	it("模型只能写草案：草案不是 Bot，高权限工具需要人工批准", async () => {
		const { store } = await storeAt();
		const normalized = normalizeBotDraft({ ...draftInput, tools: ["read", "bash"] }, allowed, "model");
		expect(normalized.tools).toEqual(["read", "bash"]);
		const draft = await store.create(normalized, "model");
		expect(draft.status).toBe("pending");
		expect(draft.highPrivilegeTools).toEqual(["bash"]);
		await expect(store.approve(draft.id, ["read"])).rejects.toThrow(/explicit approval/);
		const approved = await store.approve(draft.id, ["read", "bash"]);
		expect(approved.status).toBe("approved");
		expect(await store.list()).toHaveLength(0);
	});

	it("拒绝目录外工具、伪造字段与模型自封常驻", () => {
		expect(() => normalizeBotDraft({ ...draftInput, tools: ["rm_rf"] }, allowed, "model")).toThrow(/Unknown tools/);
		expect(() => normalizeBotDraft({ ...draftInput, name: "" }, allowed, "model")).toThrow(/name/);
		expect(() => normalizeBotDraft({ ...draftInput, systemPrompt: "x".repeat(9 * 1024) }, allowed, "model")).toThrow(
			/systemPrompt/,
		);
		expect(() => normalizeBotDraft({ ...draftInput, trigger: "always_on" }, allowed, "model")).toThrow(/always on/i);
		expect(normalizeBotDraft({ ...draftInput, trigger: "always_on" }, allowed, "human").trigger).toBe("always_on");
	});

	it("待确认数量有上限，丢弃后不再出现", async () => {
		const { store } = await storeAt();
		for (let i = 0; i < BOT_DRAFT_MAX_PENDING; i++)
			await store.create(normalizeBotDraft({ ...draftInput, name: `Bot ${i}` }, allowed, "model"), "model");
		await expect(
			store.create(normalizeBotDraft({ ...draftInput, name: "溢出" }, allowed, "model"), "model"),
		).rejects.toThrow(/pending Bot drafts/);
		const [first] = await store.list();
		await store.discard(first.id);
		expect((await store.list()).some((draft) => draft.id === first.id)).toBe(false);
		expect(await store.get(first.id)).toBeUndefined();
	});

	it("草案会过期：默认 7 天后不再计入待确认", async () => {
		const clock = { now: Date.UTC(2026, 1, 1) };
		const { store } = await storeAt(clock);
		const draft = await store.create(normalizeBotDraft(draftInput, allowed, "model"), "model");
		clock.now += BOT_DRAFT_TTL_MS + 1;
		expect(await store.list()).toHaveLength(0);
		await expect(store.approve(draft.id, ["read", "memory"])).rejects.toThrow(/expired/);
	});

	it("批准后草案不可重复使用", async () => {
		const { store } = await storeAt();
		const draft = await store.create(normalizeBotDraft(draftInput, allowed, "model"), "model");
		await store.approve(draft.id, ["read", "memory"]);
		await expect(store.approve(draft.id, ["read", "memory"])).rejects.toThrow(/not found or expired/);
	});
});
