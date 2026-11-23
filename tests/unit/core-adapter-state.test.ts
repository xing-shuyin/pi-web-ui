import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileStatePort, type FileStatePort } from "../../packages/keel/src/adapters/state/file-state-port.js";
import {
	createFileStatePort as createFromBarrel,
	type FileStateSnapshot,
} from "../../packages/keel/src/adapters/state/index.js";
import {
	resetStorageIntegrityForTests,
	StorageBlockedError,
	storageIntegritySnapshot,
} from "../../server/versioned-doc.js";

function readDoc(file: string): { version: number; entries: Record<string, unknown> } {
	return JSON.parse(readFileSync(file, "utf8")) as { version: number; entries: Record<string, unknown> };
}

function caughtBy(run: () => void): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("StatePort 的文件实现（adapters/state）", () => {
	let dir: string;
	let file: string;
	const opened: FileStatePort[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "core-adapter-state-"));
		file = join(dir, "state.json");
		resetStorageIntegrityForTests();
	});

	afterEach(() => {
		for (const port of opened.splice(0)) port.close();
		rmSync(dir, { recursive: true, force: true });
		resetStorageIntegrityForTests();
	});

	function open(namespace: string, target = file): FileStatePort {
		const port = createFileStatePort({ file: target, namespace });
		opened.push(port);
		return port;
	}

	it("写后立即可读（StatePort 同步语义），落盘带版本与 namespace 真键", async () => {
		const port = open("client-a");
		expect(port.read("theme")).toBeUndefined();
		port.write("theme", "dark");
		expect(port.read("theme")).toBe("dark");
		await port.flush();
		expect(readDoc(file)).toEqual({ version: 1, entries: { "client-a:theme": "dark" } });
	});

	it("未知键返回 undefined", () => {
		const port = open("unknown");
		port.write("known", 1);
		expect(port.read("missing")).toBeUndefined();
		expect(port.read("__proto__")).toBeUndefined();
		expect(port.read("constructor")).toBeUndefined();
		expect(port.snapshot().keys).toEqual(["known"]);
	});

	it("write(key, undefined) 删除该键（内存与磁盘都删）", async () => {
		const port = open("del");
		port.write("a", 1);
		port.write("b", 2);
		await port.flush();
		port.write("a", undefined);
		expect(port.read("a")).toBeUndefined();
		expect(port.snapshot().keys).toEqual(["b"]);
		await port.flush();
		expect(readDoc(file).entries).toEqual({ "del:b": 2 });
	});

	it("null 与嵌套结构往返保真（不是删除）", async () => {
		const port = open("shape");
		const value = { nested: { list: [1, "two", null] }, empty: null, flag: false };
		port.write("obj", value);
		port.write("nil", null);
		await port.flush();
		expect(port.read("obj")).toEqual(value);
		expect(port.read("nil")).toBeNull();
		const reopened = open("shape");
		expect(reopened.read("obj")).toEqual(value);
		expect(reopened.read("nil")).toBeNull();
	});

	it("同一 namespace 的多次写入互不覆盖", async () => {
		const port = open("merge");
		port.write("one", 1);
		port.write("two", 2);
		port.write("three", 3);
		await port.flush();
		expect(readDoc(file).entries).toEqual({ "merge:one": 1, "merge:two": 2, "merge:three": 3 });
		expect(port.snapshot().keys).toEqual(["one", "three", "two"]);
	});

	it("namespace 隔离：同文件两个 port 各自只看自己的裸键", async () => {
		const a = open("a");
		const b = open("b");
		a.write("shared", "from-a");
		b.write("shared", "from-b");
		expect(a.read("shared")).toBe("from-a");
		expect(b.read("shared")).toBe("from-b");
		await Promise.all([a.flush(), b.flush()]);
		expect(readDoc(file).entries).toEqual({ "a:shared": "from-a", "b:shared": "from-b" });
		expect(open("c").read("shared")).toBeUndefined();
	});

	it("重启后仍能读出（同一文件重新 create）", async () => {
		const first = open("restart");
		first.write("count", 7);
		await first.flush();
		first.close();
		const second = open("restart");
		expect(second.read("count")).toBe(7);
		expect(second.snapshot()).toEqual({ state: "ready", keys: ["count"] } satisfies FileStateSnapshot);
	});

	it("snapshot：文件不存在 = absent，写入后 = ready，keys 排序", async () => {
		const port = open("snap");
		expect(port.snapshot()).toEqual({ state: "absent", keys: [] } satisfies FileStateSnapshot);
		port.write("b", 2);
		port.write("a", 1);
		await port.flush();
		expect(port.snapshot()).toEqual({ state: "ready", keys: ["a", "b"] } satisfies FileStateSnapshot);
	});

	it("版本不认识 = foreign：写入当场抛 StorageBlockedError，原文件一字节不动", async () => {
		const original = JSON.stringify({ version: 2, entries: { "ver:keep": 1 } });
		writeFileSync(file, original, "utf8");
		const port = open("ver");
		expect(port.read("keep")).toBeUndefined();
		expect(port.snapshot().state).toBe("foreign");
		const error = caughtBy(() => port.write("keep", 2));
		expect(error).toBeInstanceOf(StorageBlockedError);
		expect((error as StorageBlockedError).state).toBe("foreign");
		await expect(port.flush()).resolves.toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(readdirSync(dir)).toEqual([basename(file)]);
		expect(storageIntegritySnapshot().blocked.map((issue) => issue.file)).toEqual([basename(file)]);
	});

	it("版本对得上但形状不认识 = foreign：同样拒写、不放生", async () => {
		const original = JSON.stringify({ version: 1, entries: [] });
		writeFileSync(file, original, "utf8");
		const port = open("shaped");
		const error = caughtBy(() => port.write("k", 1));
		expect(error).toBeInstanceOf(StorageBlockedError);
		expect((error as StorageBlockedError).state).toBe("foreign");
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(readdirSync(dir)).toEqual([basename(file)]);
	});

	it("外部把文件换成更新版本后，下一次写入立刻被拒（判态不在创建时缓存）", async () => {
		const port = open("ext");
		port.write("a", 1);
		await port.flush();
		writeFileSync(file, JSON.stringify({ version: 7, entries: {} }), "utf8");
		const error = caughtBy(() => port.write("b", 2));
		expect(error).toBeInstanceOf(StorageBlockedError);
		expect(port.snapshot().state).toBe("foreign");
	});

	it("坏 JSON = damaged：改名放生一次后按空库可写，原内容留在 .corrupt-*", async () => {
		writeFileSync(file, "{not json", "utf8");
		const port = open("damaged");
		port.write("after", true);
		await port.flush();
		expect(readDoc(file).entries).toEqual({ "damaged:after": true });
		const quarantined = readdirSync(dir).filter((name) => name.startsWith(`${basename(file)}.corrupt-`));
		expect(quarantined).toHaveLength(1);
		expect(readFileSync(join(dir, quarantined[0]), "utf8")).toBe("{not json");
	});

	it("并发两个 namespace 写同一文件不互相丢键", async () => {
		const left = open("left");
		const right = open("right");
		for (let i = 0; i < 5; i += 1) {
			left.write(`k${i}`, i);
			right.write(`k${i}`, i + 100);
		}
		await Promise.all([left.flush(), right.flush()]);
		const entries = readDoc(file).entries;
		expect(Object.keys(entries)).toHaveLength(10);
		for (let i = 0; i < 5; i += 1) {
			expect(entries[`left:k${i}`]).toBe(i);
			expect(entries[`right:k${i}`]).toBe(i + 100);
		}
		const reopened = open("left");
		expect(reopened.read("k3")).toBe(3);
		expect(reopened.snapshot().keys).toEqual(["k0", "k1", "k2", "k3", "k4"]);
	});

	it("close 之后拒绝写入，读仍然可用", async () => {
		const port = open("closed");
		port.write("kept", 1);
		await port.flush();
		port.close();
		expect(() => port.write("late", 2)).toThrow(/已关闭/);
		expect(port.read("kept")).toBe(1);
	});

	it("不同文件的 port 互不影响", async () => {
		const otherFile = join(dir, "other.json");
		const one = open("iso", file);
		const two = open("iso", otherFile);
		one.write("only", "one");
		two.write("only", "two");
		await Promise.all([one.flush(), two.flush()]);
		expect(readDoc(file).entries).toEqual({ "iso:only": "one" });
		expect(readDoc(otherFile).entries).toEqual({ "iso:only": "two" });
		expect(existsSync(otherFile)).toBe(true);
	});

	it("barrel 导出同一个工厂", () => {
		expect(createFromBarrel).toBe(createFileStatePort);
	});
});
