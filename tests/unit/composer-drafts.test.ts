import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ComposerDraftsStore,
	DRAFT_TEXT_MAX,
	normalizeDraftText,
	sessionIdFromTranscriptPath,
} from "../../server/composer-drafts.js";

describe("sessionIdFromTranscriptPath", () => {
	it("标准转录文件名取首个 _ 之后", () => {
		expect(sessionIdFromTranscriptPath("/s/2026-09-15T15-55-19-123Z_0199abcd-uuid.jsonl")).toBe("0199abcd-uuid");
	});
	it("形状对不上返回 undefined（不剪枝、不崩）", () => {
		expect(sessionIdFromTranscriptPath("/s/nope.txt")).toBeUndefined();
		expect(sessionIdFromTranscriptPath("/s/nounderscore.jsonl")).toBeUndefined();
		expect(sessionIdFromTranscriptPath("/s/.jsonl")).toBeUndefined();
	});
});

describe("normalizeDraftText", () => {
	it("纯空白 → undefined（按删除处理）", () => {
		expect(normalizeDraftText("   \n\t ")).toBeUndefined();
		expect(normalizeDraftText("")).toBeUndefined();
	});
	it("超长截断到上限", () => {
		expect(normalizeDraftText("x".repeat(DRAFT_TEXT_MAX + 100))?.length).toBe(DRAFT_TEXT_MAX);
	});
});

describe("ComposerDraftsStore", () => {
	const fresh = () => new ComposerDraftsStore(join(mkdtempSync(join(tmpdir(), "drafts-")), "composer-drafts.json"));

	it("存取 round-trip；空文本删 key", () => {
		const s = fresh();
		expect(s.get("abc")).toBeUndefined();
		s.save("abc", "hello", 100);
		expect(s.get("abc")).toEqual({ text: "hello", ts: 100 });
		s.save("abc", "   ", 101);
		expect(s.get("abc")).toBeUndefined();
	});

	it("last-write-wins：旧 ts 不覆盖新内容", () => {
		const s = fresh();
		s.save("abc", "new", 200);
		s.save("abc", "stale", 100);
		expect(s.get("abc")).toEqual({ text: "new", ts: 200 });
	});

	it("clear / pruneSessionFile 只动目标 key", () => {
		const s = fresh();
		s.save("aaa", "x", 1);
		s.save("bbb", "y", 1);
		s.pruneSessionFile("/s/2026-09-15T00-00-00-000Z_aaa.jsonl");
		expect(s.get("aaa")).toBeUndefined();
		expect(s.get("bbb")).toEqual({ text: "y", ts: 1 });
		s.clear("bbb");
		expect(s.get("bbb")).toBeUndefined();
	});

	it("clear 水位：旧 ts 的迟到 save 不复活（reload-resurrect）", () => {
		const s = fresh();
		s.save("s", "typed", 1000);
		s.clear("s");
		expect(s.get("s")).toBeUndefined();
		s.save("s", "stale", 1000);
		expect(s.get("s")).toBeUndefined();
		s.save("s", "older", 999);
		expect(s.get("s")).toBeUndefined();
		s.save("s", "new", Date.now() + 60_000);
		expect(s.get("s")?.text).toBe("new");
	});

	it("clear 水位跨实例共享：他 tab 的陈旧写同样丢弃", () => {
		const file = join(mkdtempSync(join(tmpdir(), "drafts-")), "composer-drafts.json");
		const a = new ComposerDraftsStore(file);
		const b = new ComposerDraftsStore(file);
		a.save("s", "typed", 1000);
		a.clear("s");
		b.save("s", "stale-from-other-tab", 1000);
		expect(a.get("s")).toBeUndefined();
		expect(b.get("s")).toBeUndefined();
	});

	it("文件损坏/脏条目不崩，读到即清扫", () => {
		const dir = mkdtempSync(join(tmpdir(), "drafts-"));
		const file = join(dir, "composer-drafts.json");
		const store = new ComposerDraftsStore(file);
		store.save("ok", "v", Date.now());
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		raw.junk = 42;
		raw.old = { text: "o", ts: 1, updatedAt: 1 };
		writeFileSync(file, JSON.stringify(raw));
		const s2 = new ComposerDraftsStore(file);
		expect(s2.get("ok")).toEqual({ text: "v", ts: expect.any(Number) });
		expect(s2.get("junk" as string)).toBeUndefined();
		expect(s2.get("old")).toBeUndefined();
	});

	it("解析失败的坏文件改名留存（.corrupt-<ts>），不被空表覆盖", () => {
		const dir = mkdtempSync(join(tmpdir(), "drafts-"));
		const file = join(dir, "composer-drafts.json");
		writeFileSync(file, "{not-valid-json");
		const store = new ComposerDraftsStore(file);
		expect(store.get("any")).toBeUndefined();
		const leftovers = readdirSync(dir).filter((f) => f.startsWith("composer-drafts.json.corrupt-"));
		expect(leftovers.length).toBe(1);
		expect(existsSync(file)).toBe(false);
		store.save("new", "fresh", Date.now());
		expect(store.get("new")?.text).toBe("fresh");
	});
});
