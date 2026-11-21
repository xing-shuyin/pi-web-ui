import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

describe("#967 client-state 读坏时先备份再降级", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-state-corrupt-"));
		file = join(dir, "client-state.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const backups = (): string[] => readdirSync(dir).filter((name) => name.startsWith("client-state.json.corrupt-"));

	it("JSON 截断：不抛异常、按空库启动，原文件被完整备份", () => {
		const broken = '{"clientA":{"projects":[';
		writeFileSync(file, broken, "utf8");
		const store = new ClientStateStore(file);

		expect(store.get("clientA").projects).toEqual([]);
		const files = backups();
		expect(files).toHaveLength(1);
		expect(readFileSync(join(dir, files[0]!), "utf8")).toBe(broken);
	});

	it("顶层是数组：同样视为读坏，不用下标当 clientId", () => {
		const broken = JSON.stringify([{ projects: [] }]);
		writeFileSync(file, broken, "utf8");
		const store = new ClientStateStore(file);

		expect(store.get("0").projects).toEqual([]);
		expect(backups()).toHaveLength(1);
	});

	it("正常文件不产生备份", () => {
		writeFileSync(file, JSON.stringify({ clientA: { projects: [] } }), "utf8");
		const store = new ClientStateStore(file);

		expect(store.get("clientA").projects).toEqual([]);
		expect(backups()).toHaveLength(0);
	});

	it("空文件不产生备份（没有内容可救）", () => {
		writeFileSync(file, "", "utf8");
		const store = new ClientStateStore(file);

		expect(store.get("clientA").projects).toEqual([]);
		expect(backups()).toHaveLength(0);
	});

	it("文件不存在时不报错也不产生备份", () => {
		const store = new ClientStateStore(join(dir, "missing.json"));

		expect(store.get("clientA").projects).toEqual([]);
		expect(backups()).toHaveLength(0);
	});
});
