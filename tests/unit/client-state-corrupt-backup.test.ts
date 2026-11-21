import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

	it("JSON 截断：不抛异常、按空库启动，原文件被完整留存", () => {
		const broken = '{"clientA":{"projects":[';
		writeFileSync(file, broken, "utf8");
		const store = new ClientStateStore(file);

		expect(store.get("clientA").projects).toEqual([]);
		const files = backups();
		expect(files).toHaveLength(1);
		expect(readFileSync(join(dir, files[0]!), "utf8")).toBe(broken);
		expect(existsSync(file)).toBe(false);
	});

	it("坏文件只留一份副本：下一次启动读不到原文件，不再造第二份", () => {
		writeFileSync(file, "{ broken", "utf8");
		expect(new ClientStateStore(file).get("clientA").projects).toEqual([]);
		expect(new ClientStateStore(file).get("clientA").projects).toEqual([]);

		expect(backups()).toHaveLength(1);
	});

	it("损坏降级后仍可写：备份落盘，不让整个设置面板跟着失效", () => {
		writeFileSync(file, "{ broken", "utf8");
		const store = new ClientStateStore(file);

		store.remember("clientA", "C:/proj");

		const saved = JSON.parse(readFileSync(file, "utf8")) as { clientA?: { projects: { path: string }[] } };
		expect(saved.clientA?.projects.map((p) => p.path)).toEqual(["C:/proj"]);
	});

	it("文件读不出来（非 ENOENT）：按空设置启动，但拒绝覆盖且如实报错", () => {
		// 目录占位是跨平台的「存在但读不出内容」：Linux/Windows 都是 EISDIR
		mkdirSync(file);
		const store = new ClientStateStore(file);

		expect(store.get("clientA").projects).toEqual([]);
		expect(() => store.remember("clientA", "C:/proj")).toThrow(/不写盘以避免覆盖/);
		expect(statSync(file).isDirectory()).toBe(true);
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

	it("空文件不产生备份，随后可正常写入（没有内容可救）", () => {
		writeFileSync(file, "", "utf8");
		const store = new ClientStateStore(file);

		expect(store.get("clientA").projects).toEqual([]);
		expect(backups()).toHaveLength(0);
		store.remember("clientA", "C:/proj");
		expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("clientA");
	});

	it("文件不存在时不报错也不产生备份", () => {
		const store = new ClientStateStore(join(dir, "missing.json"));

		expect(store.get("clientA").projects).toEqual([]);
		expect(backups()).toHaveLength(0);
	});
});
