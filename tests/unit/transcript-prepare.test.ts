import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findDanglingToolCalls,
	healDanglingToolCallsInText,
	tailAssistantToolCallIds,
} from "../../server/dangling-tools.js";
import { prepareTranscriptForOpen } from "../../server/transcript-prepare.js";

const header = (id = "s1") => JSON.stringify({ type: "session", id, cwd: "/tmp" });
const msg = (id: string, parentId: string | null, message: unknown) =>
	JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (calls: string[], opts: { stopReason?: string; pad?: number } = {}) => ({
	role: "assistant",
	...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
	content: [
		...(opts.pad ? [{ type: "text", text: "x".repeat(opts.pad) }] : []),
		...calls.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
	],
});
const toolResult = (id: string, pad = 0) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: `ok${"y".repeat(pad)}` }],
	isError: false,
});

function tmpFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "transcript-prepare-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, content, "utf8");
	return file;
}

function legacyDanglingCount(raw: string): number {
	const entries: unknown[] = [];
	let lastId: string | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			entries.push(parsed);
			if (typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string") {
				lastId = (parsed as { id: string }).id;
			}
		} catch {}
	}
	if (entries.length === 0 || !lastId) return 0;
	const tailIds = tailAssistantToolCallIds(entries, lastId);
	if (tailIds.size === 0) return 0;
	return findDanglingToolCalls(entries).filter((d) => tailIds.has(d.toolCallId)).length;
}

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomTranscript(seed: number): string {
	const r = rng(seed);
	const lines = [header()];
	const ids: string[] = [];
	let callSeq = 0;
	const openCalls: string[] = [];
	const n = 3 + Math.floor(r() * 25);
	for (let i = 0; i < n; i++) {
		const id = `e${i}`;
		const parent = ids.length === 0 ? null : r() < 0.85 ? ids[ids.length - 1] : ids[Math.floor(r() * ids.length)];
		const pad = r() < 0.3 ? 600 + Math.floor(r() * 3000) : 0;
		const kind = r();
		if (kind < 0.25) {
			lines.push(msg(id, parent, user(`u${i}`)));
		} else if (kind < 0.6) {
			const k = Math.floor(r() * 3);
			const calls = Array.from({ length: k }, () => `c${callSeq++}`);
			openCalls.push(...calls);
			const stop = r() < 0.15 ? (r() < 0.5 ? "aborted" : "error") : undefined;
			lines.push(msg(id, parent, assistant(calls, { stopReason: stop, pad })));
		} else if (openCalls.length > 0 && kind < 0.9) {
			const call = openCalls.splice(Math.floor(r() * openCalls.length), 1)[0];
			lines.push(msg(id, parent, toolResult(call, pad)));
		} else {
			lines.push(JSON.stringify({ type: "custom", id, parentId: parent, customType: "x", data: { id: "nested" } }));
		}
		ids.push(id);
	}
	let text = `${lines.join("\n")}\n`;
	if (r() < 0.2) text += msg("trunc", ids[ids.length - 1], assistant(["cz"], { pad: 900 })).slice(0, 700);
	return text;
}

describe("healDanglingToolCallsInText（按需解析）与原全量算法等价", () => {
	it("400 个随机转录（分支 / aborted / 长行 / 半截尾行）结果一致", () => {
		let nonZero = 0;
		for (let seed = 1; seed <= 400; seed++) {
			const raw = randomTranscript(seed);
			const expected = legacyDanglingCount(raw);
			if (expected > 0) nonZero++;
			const file = tmpFile(raw);
			const got = healDanglingToolCallsInText(file, raw);
			expect({ seed, got }).toEqual({ seed, got: expected });
		}
		expect(nonZero).toBeGreaterThan(20);
		expect(nonZero).toBeLessThan(380);
	});

	it("长行里嵌套对象的 id 不会被误当成顶层 id", () => {
		const nestedFirst = JSON.stringify({
			type: "custom",
			data: { id: "fake" },
			id: "real",
			parentId: "a1",
			pad: "z".repeat(1000),
		});
		const raw = [header(), msg("u1", null, user("go")), msg("a1", "u1", assistant(["c1"])), nestedFirst, ""].join("\n");
		expect(legacyDanglingCount(raw)).toBe(1);
		expect(healDanglingToolCallsInText(tmpFile(raw), raw)).toBe(1);
	});
});

describe("prepareTranscriptForOpen", () => {
	it("健康文件：首次读盘，指纹命中后不再读盘", async () => {
		const file = tmpFile(`${[header(), msg("u1", null, user("hi")), msg("a1", "u1", assistant([]))].join("\n")}\n`);
		const first = await prepareTranscriptForOpen(file);
		expect(first.read).toBe(true);
		expect(first.repair?.changed).toBe(false);
		expect(first.healed).toBe(0);
		const second = await prepareTranscriptForOpen(file);
		expect(second.read).toBe(false);
	});

	it("尾部悬空调用：一次读盘完成修复，追加后指纹刷新，下次不读盘", async () => {
		const raw = `${[header(), msg("u1", null, user("go")), msg("a1", "u1", assistant(["c1", "c2"], { pad: 2000 }))].join("\n")}\n`;
		const file = tmpFile(raw);
		const r = await prepareTranscriptForOpen(file, "restart");
		expect(r.read).toBe(true);
		expect(r.healed).toBe(2);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(5);
		expect(JSON.parse(lines[3]).parentId).toBe("a1");
		expect(JSON.parse(lines[4]).parentId).toBe(JSON.parse(lines[3]).id);
		const again = await prepareTranscriptForOpen(file);
		expect(again.read).toBe(false);
		expect(again.healed).toBe(0);
	});

	it("链损坏（重复 id）：修复并写 .bak，本次不做悬空修复", async () => {
		const raw = `${[
			header(),
			msg("u1", null, user("a")),
			msg("dup", "u1", assistant([])),
			msg("dup", "dup", user("b")),
			msg("a2", "dup", assistant(["c9"])),
		].join("\n")}\n`;
		const file = tmpFile(raw);
		const r = await prepareTranscriptForOpen(file);
		expect(r.repair?.changed).toBe(true);
		expect(r.repair?.renamedIds).toBeGreaterThan(0);
		expect(r.healed).toBe(0);
		expect(existsSync(`${file}.bak`)).toBe(true);
		const next = await prepareTranscriptForOpen(file);
		expect(next.repair?.changed).toBe(false);
		expect(next.healed).toBe(1);
	});

	it("文件不存在：不抛错，返回 repair=null", async () => {
		const r = await prepareTranscriptForOpen(join(tmpdir(), "definitely-missing-transcript.jsonl"));
		expect(r).toEqual({ repair: null, healed: 0, read: false });
	});
});
