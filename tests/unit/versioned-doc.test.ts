import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import {
	openVersionedDoc,
	resetStorageIntegrityForTests,
	StorageBlockedError,
	storageIntegritySnapshot,
} from "../../server/versioned-doc.js";
import { PluginLedgerStore } from "../../server/plugin-ledger.js";
import { RemoteSshService } from "../../server/remote-ssh-service.js";
import { PartitionedAppendLog } from "../../server/device-center/partition-log.js";
import {
	assertSupportedTranscriptVersion,
	openSessionManagerAsync,
	UnsupportedTranscriptVersionError,
} from "../../server/session-open.js";

/**
 * issues #982：「文件完好，但格式/版本我不认识」必须与「文件不存在」区分开，并且拒绝写盘。
 * 判据的四态归属在 `server/versioned-doc.ts`，本文件守住它和五个迁移过的存储。
 */
describe("versioned-doc 四态", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "versioned-doc-"));
		resetStorageIntegrityForTests();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetStorageIntegrityForTests();
	});

	const doc = (file: string) =>
		openVersionedDoc<{ items: string[] }>({
			file,
			label: "test",
			versions: [1],
			parse: (value) => (Array.isArray(value.items) ? { items: value.items as string[] } : null),
			serialize: (value) => ({ version: 1, items: value.items }),
			empty: () => ({ items: [] }),
		});

	it("文件不存在 = absent，可写", async () => {
		const file = join(dir, "absent.json");
		const handle = doc(file);
		expect(handle.read()).toEqual({ items: [] });
		expect(handle.state).toBe("absent");
		await handle.write({ items: ["a"] });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, items: ["a"] });
	});

	it("版本不认识 = foreign：原文件一字节不动，写入抛错", async () => {
		const file = join(dir, "foreign.json");
		const original = '{"version":2,"items":["keep"]}';
		writeFileSync(file, original, "utf8");
		const handle = doc(file);
		expect(handle.read()).toEqual({ items: [] });
		expect(handle.state).toBe("foreign");
		await expect(handle.write({ items: ["clobber"] })).rejects.toThrow(StorageBlockedError);
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(readdirSync(dir)).toEqual(["foreign.json"]);
	});

	it("形状不认识（版本对得上）= foreign：不覆盖、不放生", async () => {
		const file = join(dir, "shape.json");
		const original = '{"version":1,"items":{"a":1}}';
		writeFileSync(file, original, "utf8");
		const handle = doc(file);
		expect(handle.read()).toEqual({ items: [] });
		expect(handle.state).toBe("foreign");
		await expect(handle.write({ items: [] })).rejects.toThrow(StorageBlockedError);
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("解析不了 = damaged：改名留存一次，本次按空库启动、可继续写", async () => {
		const file = join(dir, "broken.json");
		writeFileSync(file, '{"version":1,"items":[', "utf8");
		const handle = doc(file);
		expect(handle.read()).toEqual({ items: [] });
		expect(handle.state).toBe("absent");
		const backups = readdirSync(dir).filter((name) => name.startsWith("broken.json.corrupt-"));
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe('{"version":1,"items":[');
		await handle.write({ items: ["fresh"] });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, items: ["fresh"] });
		// 再开一次不会留第二份副本（改名而不是拷贝）。
		expect(doc(file).read()).toEqual({ items: ["fresh"] });
		expect(readdirSync(dir).filter((name) => name.startsWith("broken.json.corrupt-"))).toHaveLength(1);
	});

	it("被挡住的文档进 health 投影，且只给文件名不给路径", async () => {
		const file = join(dir, "secret-dir-name.json");
		writeFileSync(file, '{"version":9,"items":[]}', "utf8");
		const handle = doc(file);
		handle.read();
		const snapshot = storageIntegritySnapshot();
		expect(snapshot.blocked).toHaveLength(1);
		expect(snapshot.blocked[0]).toMatchObject({ file: "secret-dir-name.json", state: "foreign", label: "test" });
		expect(JSON.stringify(snapshot)).not.toContain(dir);
	});
});

describe("#982 第 2 条：SSH 主机与密封口令不被空库覆盖", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "versioned-ssh-"));
		resetStorageIntegrityForTests();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetStorageIntegrityForTests();
	});

	it("global-hosts.json 是更高版本：列表空、保存抛错、磁碟原样", async () => {
		const file = join(dir, "global-hosts.json");
		const original = JSON.stringify({ version: 2, profiles: { work: { name: "work", host: "example.com" } } });
		writeFileSync(file, original, "utf8");
		const service = new RemoteSshService(dir);

		expect(await service.listProfiles()).toEqual([]);
		await expect(
			service.saveProfile("work", { host: "example.com", username: "root", auth: { type: "agent" } }),
		).rejects.toThrow(StorageBlockedError);

		expect(readFileSync(file, "utf8")).toBe(original);
		expect(storageIntegritySnapshot().blocked.map((entry) => entry.file)).toEqual(["global-hosts.json"]);
		expect(service.profilesStorageIssue()).toContain("版本不认识");
	});

	it("旧命名 ssh-profiles.json 认不出时也不新建主文件把它遮住", async () => {
		const legacy = join(dir, "ssh-profiles.json");
		const original = JSON.stringify({ version: 3, profiles: { work: { name: "work" } } });
		writeFileSync(legacy, original, "utf8");
		const service = new RemoteSshService(dir);

		expect(await service.listProfiles()).toEqual([]);
		await expect(service.saveProfile("new", { host: "h", username: "u", auth: { type: "agent" } })).rejects.toThrow(
			StorageBlockedError,
		);
		expect(readFileSync(legacy, "utf8")).toBe(original);
		expect(readdirSync(dir)).toEqual(["ssh-profiles.json"]);
	});
});

describe("#982 第 3 条：幂等账本不被清空", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "versioned-ledger-"));
		resetStorageIntegrityForTests();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetStorageIntegrityForTests();
	});

	it("账本文件是更高版本：不覆盖、原样保留，内存里照常记", async () => {
		const file = join(dir, "plugin-inbox", "demo.json");
		mkdirSync(join(dir, "plugin-inbox"), { recursive: true });
		const original = JSON.stringify({ v: 2, records: [{ key: "m1", state: "claimed", direction: "in" }] });
		writeFileSync(file, original, "utf8");

		const store = new PluginLedgerStore({ dataDir: dir, pluginId: "demo", flushDelayMs: 0 });
		store.put(store.newRecord({ key: "m2", direction: "in" }));

		expect(readFileSync(file, "utf8")).toBe(original);
		expect(store.get("m2", "in")?.state).toBe("claimed");
		expect(storageIntegritySnapshot().blocked[0]).toMatchObject({ state: "foreign" });
		store.dispose();
		expect(readFileSync(file, "utf8")).toBe(original);
	});
});

describe("#982 第 1 条：分区日志不把认不出的行重写掉", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "versioned-partition-"));
		resetStorageIntegrityForTests();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetStorageIntegrityForTests();
	});

	it("含未知版本行的分区被冻结：只追加，不 rewrite", async () => {
		const file = join(dir, "room.jsonl");
		const foreignLine = `${JSON.stringify({ v: 2, op: "upsert", value: { id: "old", room: "room" } })}\n`;
		const liveLine = `${JSON.stringify({ v: 1, op: "upsert", value: { id: "new", room: "room" } })}\n`;
		writeFileSync(file, foreignLine + liveLine, "utf8");
		const log = new PartitionedAppendLog<{ id: string; room: string }>({
			dir,
			partition: (row) => row.room,
			id: (row) => row.id,
			maxDeletes: 0,
		});

		expect(await log.load(["room"])).toEqual([{ id: "new", room: "room" }]);
		expect(readFileSync(file, "utf8")).toBe(foreignLine + liveLine);

		await log.commit([{ id: "brand-new", room: "room" }], new Set(["room"]));
		const after = readFileSync(file, "utf8");
		expect(after.startsWith(foreignLine + liveLine)).toBe(true);
		expect(after).toContain('"brand-new"');
		expect(storageIntegritySnapshot().blocked.map((entry) => entry.file)).toContain("room.jsonl");
	});

	it("末尾半行可以重写（那不是认不出的记录，只是被中断的 append）", async () => {
		const file = join(dir, "room.jsonl");
		const full = `${JSON.stringify({ v: 1, op: "upsert", value: { id: "a", room: "room" } })}\n`;
		const partial = JSON.stringify({ v: 1, op: "upsert", value: { id: "b", room: "room" } }).slice(0, 20);
		writeFileSync(file, full + partial, "utf8");
		const log = new PartitionedAppendLog<{ id: string; room: string }>({
			dir,
			partition: (row) => row.room,
			id: (row) => row.id,
		});

		expect(await log.load(["room"])).toEqual([{ id: "a", room: "room" }]);
		expect(readFileSync(file, "utf8")).toBe(full);
		expect(storageIntegritySnapshot().blocked).toEqual([]);
	});
});

describe("#982 第 5 条：转录版本门禁", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "versioned-transcript-"));
		resetStorageIntegrityForTests();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetStorageIntegrityForTests();
	});

	const transcript = (version: number) =>
		[
			JSON.stringify({
				type: "session",
				version,
				id: "0191a07a-32d0-7208-b133-cf7870ab850e",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: dir,
			}),
			JSON.stringify({
				type: "message",
				id: "a",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			}),
			"",
		].join("\n");

	it("版本比当前内核新：拒绝打开与追加，文件保持原样", async () => {
		const file = join(dir, "future.jsonl");
		const original = transcript(CURRENT_SESSION_VERSION + 1);
		writeFileSync(file, original, "utf8");

		expect(() => assertSupportedTranscriptVersion(file)).toThrow(UnsupportedTranscriptVersionError);
		await expect(openSessionManagerAsync(file)).rejects.toThrow(UnsupportedTranscriptVersionError);
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(storageIntegritySnapshot().blocked[0]).toMatchObject({
			label: "session-transcript",
			state: "foreign",
			foundVersion: CURRENT_SESSION_VERSION + 1,
		});
	});

	it("当前版本照旧打开", async () => {
		const file = join(dir, "current.jsonl");
		writeFileSync(file, transcript(CURRENT_SESSION_VERSION), "utf8");
		expect(() => assertSupportedTranscriptVersion(file)).not.toThrow();
		const manager = await openSessionManagerAsync(file);
		expect(manager.getEntries()).toHaveLength(1);
	});
});
