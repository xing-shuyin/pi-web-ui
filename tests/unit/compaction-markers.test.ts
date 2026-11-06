import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_DONE_TYPE,
	COMPACTION_PENDING_TYPE,
	looksLikeChainCorruption,
	makeCompactionMarkerId,
	repairSessionFile,
	repairSessionTranscript,
} from "../../server/compaction-markers.js";

const HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "s1",
	timestamp: "2026-09-19T00:00:00.000Z",
	cwd: "/x",
});
const msg = (id: string, parentId: string | null) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-19T00:00:01.000Z",
		message: { role: "user", content: "hi" },
	});
const doneMarker = (id: string, parentId: string | null) =>
	JSON.stringify({
		type: "custom",
		id,
		parentId,
		timestamp: "2026-09-19T00:00:02.000Z",
		customType: COMPACTION_DONE_TYPE,
		data: { reason: "manual", status: "completed" },
	});
const pendingMarker = (id: string, parentId: string | null) =>
	JSON.stringify({
		type: "custom",
		id,
		parentId,
		timestamp: "2026-09-19T00:00:03.000Z",
		customType: COMPACTION_PENDING_TYPE,
		data: { reason: "manual" },
	});

function walkChain(raw: string, fromId: string, maxSteps: number): { visited: string[]; cycled: boolean } {
	const byId = new Map<string, string | null>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as { id?: unknown; parentId?: unknown };
			if (typeof e.id === "string") byId.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
		} catch {}
	}
	const visited: string[] = [];
	let cur: string | null = fromId;
	for (let i = 0; i < maxSteps; i++) {
		if (cur === null || !byId.has(cur)) return { visited, cycled: false };
		if (visited.includes(cur)) return { visited, cycled: true };
		visited.push(cur);
		cur = byId.get(cur) ?? null;
	}
	return { visited, cycled: true };
}

describe("makeCompactionMarkerId", () => {
	it("每次唯一、前缀可辨", () => {
		const a = makeCompactionMarkerId("pending");
		const b = makeCompactionMarkerId("pending");
		const c = makeCompactionMarkerId("done");
		expect(a).not.toBe(b);
		expect(a.startsWith("pi-web-ui-compaction-pending-")).toBe(true);
		expect(c.startsWith("pi-web-ui-compaction-done-")).toBe(true);
	});
});

describe("repairSessionTranscript", () => {
	it("健康文件原样返回（text 全等、changed=false）", () => {
		const raw = [HEADER, msg("a", null), msg("b", "a")].join("\n") + "\n";
		const r = repairSessionTranscript(raw);
		expect(r.changed).toBe(false);
		expect(r.text).toBe(raw);
	});

	it.each([1000, 4000])("健康 %i 节点长链原样返回且 Map 查找次数线性有界", (size) => {
		const raw =
			[HEADER, ...Array.from({ length: size }, (_, i) => msg(`n${i}`, i === 0 ? null : `n${i - 1}`))].join("\n") + "\n";
		const get = vi.spyOn(Map.prototype, "get");
		let lookups: number;
		let result: ReturnType<typeof repairSessionTranscript>;
		try {
			result = repairSessionTranscript(raw);
			lookups = get.mock.calls.length;
		} finally {
			get.mockRestore();
		}
		expect(result.changed).toBe(false);
		expect(result.text).toBe(raw);
		expect(result.cyclesBroken).toBe(0);
		expect(lookups).toBeLessThan(size * 20);
	});

	it("长前向路径进入真正环时仅截断原算法选择的边，保留长正文", () => {
		const size = 4000;
		const rows = Array.from({ length: size }, (_, i) =>
			JSON.parse(msg(`n${i}`, i === size - 1 ? "n2000" : `n${i + 1}`)),
		);
		rows[size - 1].message.content = "z".repeat(1200);
		const raw = [HEADER, ...rows.map((row) => JSON.stringify(row))].join("\n") + "\n";
		const get = vi.spyOn(Map.prototype, "get");
		let lookups: number;
		let result: ReturnType<typeof repairSessionTranscript>;
		try {
			result = repairSessionTranscript(raw);
			lookups = get.mock.calls.length;
		} finally {
			get.mockRestore();
		}
		expect(lookups).toBeLessThan(size * 20);
		expect(result.cyclesBroken).toBe(1);
		expect(result.removedPending).toBe(0);
		expect(result.renamedIds).toBe(0);
		expect(result.rewiredParents).toBe(0);
		const actual = new Map(
			result.text
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const row = JSON.parse(line);
					return [row.id, row];
				}),
		);
		rows[size - 1].parentId = null;
		for (const row of rows) expect(actual.get(row.id)).toEqual(row);
		expect(repairSessionTranscript(result.text).changed).toBe(false);
	});

	it("穷举四节点父图，与旧逐节点回溯的断边和次数一致", () => {
		const ids = ["a", "b", "c", "d"];
		const targets = [null, "missing", ...ids];
		for (let code = 0; code < targets.length ** ids.length; code++) {
			let digits = code;
			const rows = ids.map((id) => {
				const parent = targets[digits % targets.length];
				digits = Math.floor(digits / targets.length);
				return JSON.parse(msg(id, parent));
			});
			const raw = [HEADER, ...rows.map((row) => JSON.stringify(row))].join("\n") + "\n";
			const byId = new Map(rows.map((row) => [row.id, row]));
			let cycles = 0;
			for (const row of rows) {
				const seen = new Set([row.id]);
				let prev = row;
				let cur = row.parentId;
				while (cur !== null) {
					if (seen.has(cur)) {
						prev.parentId = null;
						cycles++;
						break;
					}
					seen.add(cur);
					const next = byId.get(cur);
					if (!next) break;
					prev = next;
					cur = next.parentId;
				}
			}
			const result = repairSessionTranscript(raw);
			expect(result.cyclesBroken, `graph ${code}`).toBe(cycles);
			const repaired = new Map(
				result.text
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const row = JSON.parse(line);
						return [row.id, row];
					}),
			);
			for (const row of rows) expect(repaired.get(row.id), `graph ${code}`).toEqual(row);
		}
	});

	it("移除残留 pending：子节点旁路到 pending 的 parent，interrupted=true", () => {
		const raw = [HEADER, msg("a", null), pendingMarker("p1", "a"), msg("b", "p1")].join("\n") + "\n";
		const r = repairSessionTranscript(raw);
		expect(r.changed).toBe(true);
		expect(r.removedPending).toBe(1);
		expect(r.interrupted).toBe(true);
		expect(r.rewiredParents).toBe(1);
		expect(r.text.includes("compaction-pending")).toBe(false);
		const lines = r.text.split("\n").filter(Boolean);
		const b = JSON.parse(lines[2]) as { id: string; parentId: string };
		expect(b.id).toBe("b");
		expect(b.parentId).toBe("a");
	});

	it("重复 done id：首个保留、其余改名，引用改指最近前序同名", () => {
		const D = "pi-web-ui-compaction-done";
		const raw =
			[HEADER, msg("a", null), doneMarker(D, "x1"), msg("m1", "a"), doneMarker(D, "x2"), msg("m2", D)].join("\n") +
			"\n";
		const r = repairSessionTranscript(raw);
		expect(r.changed).toBe(true);
		expect(r.renamedIds).toBe(1);
		const lines = r.text.split("\n").filter(Boolean);
		const dones = lines.map((l) => JSON.parse(l)).filter((e) => e.customType === COMPACTION_DONE_TYPE);
		expect(dones).toHaveLength(2);
		expect(dones[0].id).toBe(D);
		expect(dones[1].id.startsWith(`${D}--dup-`)).toBe(true);
		const m2 = lines.map((l) => JSON.parse(l)).find((e) => e.id === "m2");
		expect(m2.parentId).toBe(dones[1].id);
	});

	it("手造 A↔B 环必终止且被截断", () => {
		const raw = [HEADER, msg("a", "b"), msg("b", "a")].join("\n") + "\n";
		const r = repairSessionTranscript(raw);
		expect(r.cyclesBroken).toBeGreaterThan(0);
		const w = walkChain(r.text, "a", 100);
		expect(w.cycled).toBe(false);
	});

	it("脏行原样保留", () => {
		const raw = [HEADER, "not json at all", msg("a", null)].join("\n") + "\n";
		const r = repairSessionTranscript(raw);
		expect(r.changed).toBe(false);
		expect(r.text).toBe(raw);
	});

	it("超长 message 行（>512 字节）走头部快速提取且在旁路改写时仍完整保留正文", () => {
		const bigMsg = JSON.stringify({
			type: "message",
			id: "big-b",
			parentId: "p1",
			timestamp: "2026-09-19T00:00:05.000Z",
			message: { role: "assistant", content: "z".repeat(1200) },
		});
		const raw = [HEADER, msg("a", null), pendingMarker("p1", "a"), bigMsg].join("\n") + "\n";
		const r = repairSessionTranscript(raw);
		expect(r.changed).toBe(true);
		expect(r.rewiredParents).toBe(1);
		const lines = r.text.split("\n").filter(Boolean);
		const parsedBig = JSON.parse(lines[2]) as {
			id: string;
			parentId: string;
			message: { content: string };
		};
		expect(parsedBig.id).toBe("big-b");
		expect(parsedBig.parentId).toBe("a");
		expect(parsedBig.message.content).toBe("z".repeat(1200));
	});
});

describe("issue #235 原场景", () => {
	const DUP = "pi-web-ui-compaction-done";
	const corrupt = [
		HEADER,
		msg("a", null),
		doneMarker(DUP, "x1"),
		msg("x1", DUP),
		doneMarker(DUP, "x1"),
		msg("m", DUP),
	].join("\n");

	it("坏文件确有环（SDK 语义下回溯走不出来）", () => {
		const w = walkChain(corrupt, "m", 1000);
		expect(w.cycled).toBe(true);
	});

	it("repair 后环消失，且真 SDK 能 open + getBranch", () => {
		const r = repairSessionTranscript(corrupt);
		expect(r.changed).toBe(true);
		expect(r.renamedIds).toBe(1);
		const w = walkChain(r.text, "m", 1000);
		expect(w.cycled).toBe(false);

		const dir = mkdtempSync(join(tmpdir(), "session-repair-"));
		const file = join(dir, "2026-09-19T00-00-00-000Z_s1.jsonl");
		writeFileSync(file, r.text, "utf8");
		const mgr = SessionManager.open(file);
		const branch = mgr.getBranch();
		expect(branch.length).toBeGreaterThan(0);
		expect(mgr.buildContextEntries().length).toBeGreaterThan(0);
	});
});

describe("looksLikeChainCorruption", () => {
	it("识别 V8 环报错，普通错误放行", () => {
		expect(looksLikeChainCorruption(new RangeError("Invalid array length"))).toBe(true);
		expect(looksLikeChainCorruption(new Error("Maximum call stack size exceeded"))).toBe(true);
		expect(looksLikeChainCorruption(new Error("Session file is not a valid pi session"))).toBe(false);
		expect(looksLikeChainCorruption("boom")).toBe(false);
	});
});

describe("repairSessionFile", () => {
	it("健康文件只读不写（无 .bak）", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-repair-"));
		const file = join(dir, "s.jsonl");
		const raw = [HEADER, msg("a", null)].join("\n") + "\n";
		writeFileSync(file, raw, "utf8");
		const r = repairSessionFile(file);
		expect(r?.changed).toBe(false);
		expect(r?.backup).toBeNull();
		expect(existsSync(`${file}.bak`)).toBe(false);
	});

	it("坏文件写回＋留 .bak（已有 .bak 不覆盖，保最早现场）", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-repair-"));
		const file = join(dir, "s.jsonl");
		const corrupt = [HEADER, msg("a", null), pendingMarker("p1", "a"), msg("b", "p1")].join("\n") + "\n";
		writeFileSync(file, corrupt, "utf8");
		writeFileSync(`${file}.bak`, "ORIGINAL", "utf8");
		const r = repairSessionFile(file);
		expect(r?.changed).toBe(true);
		expect(r?.backup).toBe(`${file}.bak`);
		expect(readFileSync(`${file}.bak`, "utf8")).toBe("ORIGINAL");
		expect(readFileSync(file, "utf8").includes("compaction-pending")).toBe(false);
	});

	it("修剪被陈旧元数据侧枝劫持的转录拓扑（issue #567）", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-repair-567-"));
		const file = join(dir, "s567.jsonl");
		const custom1 = JSON.stringify({
			type: "custom",
			customType: "plannotator",
			id: "plan-1",
			parentId: "8775fb27",
			timestamp: "2026-10-08T11:53:01.000Z",
		});
		const custom2 = JSON.stringify({
			type: "custom",
			customType: "plannotator",
			id: "plan-2",
			parentId: "plan-1",
			timestamp: "2026-10-08T11:53:02.000Z",
		});
		const transcript = [
			HEADER,
			msg("m1", null),
			msg("8775fb27", "m1"),
			msg("m3", "8775fb27"),
			msg("c9560bdb", "m3"),
			custom1,
			custom2,
		].join("\n");
		writeFileSync(file, transcript, "utf8");

		const beforeSm = SessionManager.open(file);
		expect(beforeSm.getLeafId()).toBe("plan-2");
		expect(beforeSm.getBranch().filter((e) => e.type === "message")).toHaveLength(2);

		const r = repairSessionFile(file);
		expect(r?.changed).toBe(true);
		expect(r?.reorderedBranches).toBe(true);
		expect(r?.backup).toBe(`${file}.bak`);

		const afterSm = SessionManager.open(file);
		expect(afterSm.getLeafId()).toBe("c9560bdb");
		expect(afterSm.getBranch().filter((e) => e.type === "message")).toHaveLength(4);
		expect(afterSm.getEntry("plan-1")).toBeDefined();
		expect(afterSm.getEntry("plan-2")).toBeDefined();
	});
});
