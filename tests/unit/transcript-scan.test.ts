import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_PENDING_TYPE, repairSessionTranscript } from "../../server/compaction-markers.js";
import { healDanglingToolCallsInText, probeTailDangling } from "../../server/dangling-tools.js";
import { prepareTranscriptForOpen } from "../../server/transcript-prepare.js";
import { scanTranscriptForRepair } from "../../server/transcript-scan.js";

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
const pendingMarker = (id: string, parentId: string | null) =>
	JSON.stringify({
		type: "custom",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: COMPACTION_PENDING_TYPE,
		data: { reason: "manual" },
	});

function tmpFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "transcript-scan-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, content, "utf8");
	return file;
}

async function scanText(content: string) {
	return scanTranscriptForRepair(tmpFile(content));
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

/** 随机转录：分支、环、重复 id、pending 标记、长行、坏行、半截尾行、无 id 条目都有机会出现 */
function randomTranscript(seed: number): string {
	const r = rng(seed);
	const lines = [header()];
	const ids: string[] = [];
	let callSeq = 0;
	const openCalls: string[] = [];
	const n = 3 + Math.floor(r() * 25);
	for (let i = 0; i < n; i++) {
		const reuseId = r() < 0.06 && ids.length > 0;
		const id = reuseId ? ids[Math.floor(r() * ids.length)] : `e${i}`;
		let parent: string | null;
		if (ids.length === 0) parent = null;
		else if (r() < 0.78) parent = ids[ids.length - 1];
		else if (r() < 0.9) parent = ids[Math.floor(r() * ids.length)];
		else parent = `e${i + 1}`; // 前向引用：可能成环
		const pad = r() < 0.3 ? 600 + Math.floor(r() * 3000) : 0;
		const kind = r();
		if (kind < 0.05) {
			lines.push(pendingMarker(`p${i}`, parent));
		} else if (kind < 0.1) {
			lines.push(JSON.stringify({ type: "custom", customType: "x", data: { id: "nested" }, pad: "z".repeat(800) }));
		} else if (kind < 0.14) {
			lines.push(r() < 0.5 ? "not json at all" : "");
		} else if (kind < 0.2) {
			lines.push(JSON.stringify({ type: "session", id: `h${i}`, cwd: "/tmp" }));
		} else if (kind < 0.45) {
			lines.push(msg(id, parent, user(`u${i}`)));
		} else if (kind < 0.75) {
			const k = Math.floor(r() * 3);
			const calls = Array.from({ length: k }, () => `c${callSeq++}`);
			openCalls.push(...calls);
			const stop = r() < 0.15 ? (r() < 0.5 ? "aborted" : "error") : undefined;
			lines.push(msg(id, parent, assistant(calls, { stopReason: stop, pad })));
		} else if (openCalls.length > 0 && kind < 0.95) {
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

describe("scanTranscriptForRepair（打开前修复判定的流式扫描）", () => {
	it("400 个随机转录上「判定无操作」从不误判成需要修复", async () => {
		let clean = 0;
		for (let seed = 1; seed <= 400; seed++) {
			const raw = randomTranscript(seed);
			const scan = await scanText(raw);
			const changed = repairSessionTranscript(raw).changed;
			expect({ seed, misjudged: scan.clean && changed }).toEqual({ seed, misjudged: false });
			if (scan.clean) clean++;
		}
		// 快路径不能是死代码（这个生成器故意掺入大量分支 / 环 / 重复 id，多数会保守回退）
		expect(clean).toBeGreaterThan(10);
		expect(clean).toBeLessThan(400);
	});

	it("300 个真实形态单链转录（分支缺省）一律判为无操作且修复不动文件", async () => {
		for (let seed = 1; seed <= 300; seed++) {
			const r = rng(seed * 7919);
			const lines = [header()];
			let parent: string | null = null;
			let callSeq = 0;
			const n = 2 + Math.floor(r() * 20);
			for (let i = 0; i < n; i++) {
				const userId = `u${i}`;
				lines.push(msg(userId, parent, user(`prompt ${i}`)));
				parent = userId;
				const callIds = Array.from({ length: Math.floor(r() * 3) }, () => `c${callSeq++}`);
				const assistantId = `a${i}`;
				// 一半的 assistant 行做成 > 512 字符的长行
				lines.push(msg(assistantId, parent, assistant(callIds, { pad: r() < 0.5 ? 300 + Math.floor(r() * 4000) : 0 })));
				parent = assistantId;
				for (const c of callIds) {
					const resultId = `r${i}-${c}`;
					lines.push(msg(resultId, parent, toolResult(c, r() < 0.3 ? 500 : 0)));
					parent = resultId;
				}
			}
			const raw = `${lines.join("\n")}\n`;
			const scan = await scanText(raw);
			expect({ seed, scan: scan.clean }).toEqual({ seed, scan: true });
			expect(repairSessionTranscript(raw).changed).toBe(false);
		}
	});

	it("健康单链（含长行、坏行、半截尾行）判为无操作", async () => {
		const raw = [
			header(),
			msg("u1", null, user("go")),
			msg("a1", "u1", assistant(["c1"], { pad: 4000 })),
			"",
			msg("r1", "a1", toolResult("c1", 2000)),
			"not json at all",
			msg("a2", "r1", assistant([], { pad: 900 })),
		].join("\n");
		const mixed = `${raw}\n${msg("trunc", "a2", assistant(["cz"], { pad: 900 })).slice(0, 600)}`;
		const scan = await scanText(mixed);
		expect(scan).toEqual({ clean: true, reason: "clean" });
		expect(repairSessionTranscript(mixed).changed).toBe(false);
	});

	it("单条条目 / 只有文件头都算无操作", async () => {
		expect(await scanText(`${header()}\n`)).toEqual({ clean: true, reason: "clean" });
		expect(await scanText(`${[header(), msg("u1", null, user("hi"))].join("\n")}\n`)).toEqual({
			clean: true,
			reason: "clean",
		});
	});

	it("残留 pending 标记要求整份修复（子节点要改 parent）", async () => {
		const raw = `${[header(), msg("a", null, user("x")), pendingMarker("p1", "a"), msg("b", "p1", user("y"))].join("\n")}\n`;
		expect(await scanText(raw)).toEqual({ clean: false, reason: "pending-marker" });
		expect(repairSessionTranscript(raw).changed).toBe(true);
	});

	it("重复 id 要求整份修复（改名 + 引用改指）", async () => {
		const raw = `${[header(), msg("a", null, user("x")), msg("dup", "a", user("y")), msg("dup", "dup", user("z"))].join("\n")}\n`;
		expect(await scanText(raw)).toEqual({ clean: false, reason: "duplicate-id" });
		expect(repairSessionTranscript(raw).changed).toBe(true);
	});

	it("父链成环要求整份修复（只扫元数据也能发现）", async () => {
		const raw = `${[header(), msg("a", "b", user("x")), msg("b", "a", user("y"))].join("\n")}\n`;
		expect(await scanText(raw)).toEqual({ clean: false, reason: "cycle" });
		expect(repairSessionTranscript(raw).changed).toBe(true);
	});

	it("分支顺序需要重排时要求整份修复（issue #567 形态）", async () => {
		const raw = [
			header(),
			msg("m1", null, user("x")),
			msg("8775fb27", "m1", user("y")),
			msg("m3", "8775fb27", user("z")),
			msg("c9560bdb", "m3", user("w")),
			JSON.stringify({ type: "custom", customType: "plannotator", id: "plan-1", parentId: "8775fb27" }),
			JSON.stringify({ type: "custom", customType: "plannotator", id: "plan-2", parentId: "plan-1" }),
		].join("\n");
		expect(await scanText(raw)).toEqual({ clean: false, reason: "branch-order" });
		expect(repairSessionTranscript(raw).changed).toBe(true);
	});

	it("文件头后面又出现 session 条目：顺序会被重排，不判无操作", async () => {
		const raw = `${[header(), msg("a", null, user("x")), header("s2")].join("\n")}\n`;
		expect((await scanText(raw)).clean).toBe(false);
	});

	it("超长行里 id 出现在行首窗口之外时与修复同样整行解析", async () => {
		const longLine = JSON.stringify({
			type: "message",
			pad: "z".repeat(5000),
			id: "late",
			parentId: "a1",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		});
		const raw = `${[header(), msg("a1", null, user("x")), longLine].join("\n")}\n`;
		expect(await scanText(raw)).toEqual({ clean: true, reason: "clean" });
		expect(repairSessionTranscript(raw).changed).toBe(false);
		// 同样的行补上重复 id 时也必须被发现
		const dupRaw = `${[header(), msg("a1", null, user("x")), msg("a1", "a1", user("y")), longLine].join("\n")}\n`;
		expect(await scanText(dupRaw)).toEqual({ clean: false, reason: "duplicate-id" });
	});
});

describe("probeTailDangling（只读尾部判定悬空调用）", () => {
	it("尾部没有工具调用时不出追加", async () => {
		const raw = `${[header(), msg("u1", null, user("go")), msg("a1", "u1", assistant(["c1"])), msg("r1", "a1", toolResult("c1"))].join("\n")}\n`;
		const file = tmpFile(raw);
		expect(await probeTailDangling(file)).toEqual({ lastId: "r1", dangling: [] });
	});

	it("尾部 assistant 的未回填调用与整份算法结果一致", async () => {
		const raw = `${[header(), msg("u1", null, user("go")), msg("a1", "u1", assistant(["c1", "c2"]))].join("\n")}\n`;
		const file = tmpFile(raw);
		const copy = join(mkdtempSync(join(tmpdir(), "tail-probe-")), "s.jsonl");
		writeFileSync(copy, raw, "utf8");
		const probe = await probeTailDangling(file);
		expect(probe?.lastId).toBe("a1");
		expect(probe?.dangling).toEqual([
			{ toolCallId: "c1", toolName: "bash" },
			{ toolCallId: "c2", toolName: "bash" },
		]);
		expect(healDanglingToolCallsInText(copy, raw)).toBe(2);
	});

	it("尾部 assistant 行比初始窗口还大时放大窗口仍能判定", async () => {
		const bigAssistant = msg("a1", "u1", assistant(["c1"], { pad: 400 * 1024 }));
		const raw = `${[header(), msg("u1", null, user("go")), bigAssistant].join("\n")}\n`;
		const file = tmpFile(raw);
		const probe = await probeTailDangling(file);
		expect(probe?.lastId).toBe("a1");
		expect(probe?.dangling).toEqual([{ toolCallId: "c1", toolName: "bash" }]);
	});

	it("aborted 的尾部 assistant 不算悬空", async () => {
		const raw = `${[header(), msg("u1", null, user("go")), msg("a1", "u1", assistant(["c1"], { stopReason: "aborted" }))].join("\n")}\n`;
		expect(await probeTailDangling(tmpFile(raw))).toEqual({ lastId: "a1", dangling: [] });
	});

	it("空文件判定不了，交回整份读取", async () => {
		const file = tmpFile("");
		expect(await probeTailDangling(file)).toBeNull();
		const missing = join(mkdtempSync(join(tmpdir(), "tail-probe-")), "nope.jsonl");
		expect(await probeTailDangling(missing)).toBeNull();
	});
});

describe("prepareTranscriptForOpen 的路径判定（issue #945）", () => {
	it("健康单链：冷路径走「元数据扫描 + 尾部检查」，不整份读取", async () => {
		const raw = `${[
			header(),
			msg("u1", null, user("go")),
			msg("a1", "u1", assistant(["c1"], { pad: 3000 })),
			msg("r1", "a1", toolResult("c1", 3000)),
			msg("a2", "r1", assistant([])),
		].join("\n")}\n`;
		const file = tmpFile(raw);
		const first = await prepareTranscriptForOpen(file);
		expect(first.path).toBe("fast");
		expect(first.read).toBe(true);
		expect(first.repair?.changed).toBe(false);
		expect(first.healed).toBe(0);
		// 指纹记过后连扫描都不做
		const second = await prepareTranscriptForOpen(file);
		expect(second.path).toBe("fast");
		expect(second.read).toBe(false);
	});

	it("需要重排的分支转录仍整份读取并修复", async () => {
		const raw = [
			header(),
			msg("m1", null, user("x")),
			msg("m2", "m1", user("y")),
			msg("m3", "m2", user("z")),
			JSON.stringify({ type: "custom", customType: "plannotator", id: "plan-1", parentId: "m1" }),
		].join("\n");
		const file = tmpFile(`${raw}\n`);
		const result = await prepareTranscriptForOpen(file);
		expect(result.path).toBe("full");
		expect(result.repair?.changed).toBe(true);
		expect(repairSessionTranscript(`${raw}\n`).changed).toBe(true);
	});
});
