import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONV_TITLE } from "../../server/agent-formatters.js";
import { readSessionName, renameSessionFile } from "../../packages/keel/src/adapters/sdk/session-info.js";

/**
 * 重命名落盘（叶子适配器）：真造 jsonl 文件，验的是「标题进得了会话文件、读得回来」，
 * 标题归一与默认标题都走 kernel 的单源，用例不另立期望。
 */

const HEADER = { type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00Z", cwd: "/w" };
const TS = 1_700_000_000_000;

let dir: string;

function userLine(id: string, parentId: string | null, text: string, ts: number) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", content: text, timestamp: ts },
	};
}

function jsonl(...lines: unknown[]): string {
	return `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`;
}

async function writeSession(name: string, ...lines: unknown[]): Promise<string> {
	const file = join(dir, name);
	await writeFile(file, jsonl(HEADER, ...lines), "utf8");
	return file;
}

function records(raw: string): Record<string, unknown>[] {
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function errorOf(run: Promise<unknown>): Promise<Error> {
	try {
		await run;
	} catch (error) {
		return error as Error;
	}
	throw new Error("期望抛错，但没有抛");
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-web-session-info-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("renameSessionFile / readSessionName", () => {
	it("改名把标题写进会话文件，readSessionName 读得回来", async () => {
		const file = await writeSession("a.jsonl", userLine("u1", null, "hi", TS));
		expect(await renameSessionFile({ sessionFile: file, title: "我的会话" })).toEqual({ ok: true, title: "我的会话" });
		expect(await readSessionName(file)).toBe("我的会话");
	});

	it("改名是追加一条 session_info，原有记录与头部都不动", async () => {
		const file = await writeSession("b.jsonl", userLine("u1", null, "保留我", TS));
		await renameSessionFile({ sessionFile: file, title: "改过的名字" });
		const entries = records(await readFile(file, "utf8"));
		expect(entries[0]).toEqual(HEADER);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "session_info"]);
		expect(entries[1]).toMatchObject({ id: "u1", message: { role: "user", content: "保留我" } });
		expect(entries[2]).toMatchObject({ type: "session_info", parentId: "u1", name: "改过的名字" });
	});

	it("标题首尾空白被归一后再落盘", async () => {
		const file = await writeSession("c.jsonl", userLine("u1", null, "hi", TS));
		const result = await renameSessionFile({ sessionFile: file, title: "  我的 会话  " });
		expect(result.title).toBe("我的 会话");
		expect(await readSessionName(file)).toBe("我的 会话");
	});

	it("标题里的换行按落盘规则折成空格，返回的就是落盘后的标题", async () => {
		const file = await writeSession("d.jsonl", userLine("u1", null, "hi", TS));
		const result = await renameSessionFile({ sessionFile: file, title: "第一行\n第二行" });
		expect(result.title).toBe("第一行 第二行");
		expect(await readSessionName(file)).toBe("第一行 第二行");
	});

	it("空白标题归一成默认标题", async () => {
		const file = await writeSession("e.jsonl", userLine("u1", null, "hi", TS));
		expect(await renameSessionFile({ sessionFile: file, title: "   " })).toEqual({
			ok: true,
			title: DEFAULT_CONV_TITLE,
		});
		expect(await readSessionName(file)).toBe(DEFAULT_CONV_TITLE);
	});

	it("文件不存在时报错并带路径，且不会顺手造出转录", async () => {
		const file = join(dir, "missing.jsonl");
		const error = await errorOf(renameSessionFile({ sessionFile: file, title: "随便" }));
		expect(error.message).toContain(file);
		await expect(stat(file)).rejects.toThrow();
		expect(await readSessionName(file)).toBeUndefined();
	});

	it("转录版本比内核新时拒绝改名，且原文件一字不动", async () => {
		const file = join(dir, "future.jsonl");
		const raw = jsonl({ ...HEADER, version: 99 }, userLine("u1", null, "hi", TS));
		await writeFile(file, raw, "utf8");
		const error = await errorOf(renameSessionFile({ sessionFile: file, title: "随便" }));
		expect(error.message).toContain(file);
		expect(await readFile(file, "utf8")).toBe(raw);
		expect(await readSessionName(file)).toBeUndefined();
	});

	it("坏文件读不到名字时返回 undefined，不抛", async () => {
		const file = join(dir, "broken.jsonl");
		await writeFile(file, "这不是 json\n", "utf8");
		expect(await readSessionName(file)).toBeUndefined();
	});

	it("坏文件不许改名（打开即失败），文件保持原样", async () => {
		const file = join(dir, "broken-rename.jsonl");
		await writeFile(file, "这不是 json\n", "utf8");
		await expect(renameSessionFile({ sessionFile: file, title: "随便" })).rejects.toThrow();
		expect(await readFile(file, "utf8")).toBe("这不是 json\n");
	});

	it("连续两次改名读回最后一次", async () => {
		const file = await writeSession("f.jsonl", userLine("u1", null, "hi", TS));
		await renameSessionFile({ sessionFile: file, title: "第一次" });
		await renameSessionFile({ sessionFile: file, title: "第二次" });
		expect(await readSessionName(file)).toBe("第二次");
		const infos = records(await readFile(file, "utf8")).filter((entry) => entry.type === "session_info");
		expect(infos.map((entry) => entry.name)).toEqual(["第一次", "第二次"]);
	});

	it("路径指向目录时按「文件不存在」拒绝，不抛系统错误", async () => {
		const error = await errorOf(renameSessionFile({ sessionFile: dir, title: "随便" }));
		expect(error.message).toContain(dir);
	});
});
