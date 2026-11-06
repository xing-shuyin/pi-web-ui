import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeGrantPath, PluginGrantsStore } from "../../server/plugin-grants.js";

const dirs: string[] = [];
function tmpDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pgrants-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { store: PluginGrantsStore; dir: string; file: string } {
	const dir = tmpDataDir();
	return { store: new PluginGrantsStore(dir), dir, file: join(dir, "plugin-grants.json") };
}

const WIN = process.platform === "win32";

describe("normalizeGrantPath", () => {
	it("绝对路径 resolve 后原样返回（去掉尾部分隔符）", () => {
		const base = tmpDataDir();
		expect(normalizeGrantPath(base)).toBe(resolve(base));
		expect(normalizeGrantPath(`${base}${sep}`)).toBe(resolve(base));
		expect(normalizeGrantPath(join(base, "a", "..", "b"))).toBe(resolve(base, "b"));
	});

	it("空 / 非字符串 / 含 NUL 一律 null", () => {
		expect(normalizeGrantPath("")).toBeNull();
		expect(normalizeGrantPath("   ")).toBeNull();
		expect(normalizeGrantPath("a\0b")).toBeNull();
		expect(normalizeGrantPath(undefined as unknown as string)).toBeNull();
		expect(normalizeGrantPath(null as unknown as string)).toBeNull();
	});

	it("相对路径一律拒绝（相对谁是个隐藏上下文，落盘后会读出别的目录）", () => {
		for (const p of ["relative/dir", "./x", "..", "../sibling", "dir"]) {
			expect(normalizeGrantPath(p)).toBeNull();
		}
	});

	it("win32：怪盘符（C:relative / 1:\\x）拒绝；根 C:\\ 保留分隔符", () => {
		if (!WIN) {
			expect(normalizeGrantPath("C:\\Temp")).toBeNull();
			expect(normalizeGrantPath("/")).toBe("/");
			return;
		}
		expect(normalizeGrantPath("C:relative")).toBeNull();
		expect(normalizeGrantPath("1:\\x")).toBeNull();
		expect(normalizeGrantPath("C:\\")).toBe("C:\\");
	});
});

describe("PluginGrantsStore 基本行为", () => {
	it("grant → has/list/get 反映；同一目录重复 grant 幂等", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "proj");
		expect(store.has("demo", proj)).toBe(false);
		expect(store.get("demo")).toEqual([]);
		expect(store.list()).toEqual([]);

		expect(store.grant("demo", proj)).toBe(true);
		expect(store.has("demo", proj)).toBe(true);
		expect(store.get("demo")).toEqual([resolve(proj)]);
		expect(store.list()).toEqual([{ pluginId: "demo", paths: [resolve(proj)] }]);

		expect(store.grant("demo", proj)).toBe(false);
		expect(store.grant("demo", `${proj}${sep}`)).toBe(false);
		expect(store.get("demo")).toHaveLength(1);
	});

	it("list 按 pluginId 排序、get/list 返回副本（外部改动不影响内部）", () => {
		const { store, dir } = makeStore();
		store.grant("beta", join(dir, "b"));
		store.grant("alpha", join(dir, "a"));
		expect(store.list().map((g) => g.pluginId)).toEqual(["alpha", "beta"]);
		const copy = store.get("alpha");
		copy.push("/injected");
		expect(store.get("alpha")).toHaveLength(1);
	});

	it("显式授权过的子目录留痕：父目录授权后单独 grant 子目录仍记一条", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "proj");
		store.grant("demo", proj);
		expect(store.grant("demo", join(proj, "src"))).toBe(true);
		expect(store.get("demo")).toHaveLength(2);
	});
});

describe("父子目录包含关系（授权 /proj 就等于 /proj/a）", () => {
	it("父目录授权覆盖任意深度子目录", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "proj");
		store.grant("demo", proj);
		expect(store.has("demo", join(proj, "a"))).toBe(true);
		expect(store.has("demo", join(proj, "a", "b", "c"))).toBe(true);
		expect(store.has("demo", proj)).toBe(true);
	});

	it("反向不成立：只授权子目录时父目录仍未授权", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "proj");
		store.grant("demo", join(proj, "a"));
		expect(store.has("demo", join(proj, "a"))).toBe(true);
		expect(store.has("demo", join(proj, "a", "b"))).toBe(true);
		expect(store.has("demo", proj)).toBe(false);
		expect(store.has("demo", join(proj, "b"))).toBe(false);
	});

	it("按分段边界判定，不做裸前缀匹配：/proj 不覆盖 /project", () => {
		const { store, dir } = makeStore();
		store.grant("demo", join(dir, "proj"));
		expect(store.has("demo", join(dir, "project"))).toBe(false);
		expect(store.has("demo", join(dir, "proj-x"))).toBe(false);
		expect(store.has("demo", join(dir, "proj", "x"))).toBe(true);
	});

	it("授权不依赖磁盘现状（目录不存在也算已授权）", () => {
		const { store, dir } = makeStore();
		const nowhere = join(dir, "does", "not", "exist");
		expect(existsSync(nowhere)).toBe(false);
		store.grant("demo", nowhere);
		expect(store.has("demo", nowhere)).toBe(true);
	});
});

describe("win32 大小写 / 尾部分隔符归一", () => {
	it("win32 忽略大小写；其他平台区分大小写", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "Workspace");
		expect(store.grant("demo", proj)).toBe(true);
		if (WIN) {
			expect(store.has("demo", proj.toUpperCase())).toBe(true);
			expect(store.has("demo", join(proj.toUpperCase(), "sub"))).toBe(true);
			expect(store.grant("demo", proj.toUpperCase())).toBe(false);
			expect(store.get("demo")).toHaveLength(1);
			expect(store.get("demo")[0]).toBe(resolve(proj));
			expect(store.get("demo")[0]).toMatch(/[A-Z]/);
		} else {
			expect(store.has("demo", proj.toUpperCase())).toBe(false);
			expect(store.grant("demo", proj.toUpperCase())).toBe(true);
			expect(store.get("demo")).toHaveLength(2);
		}
	});

	it("尾部分隔符在两种平台都算同一目录（正斜杠形式也归一）", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "proj");
		store.grant("demo", proj);
		expect(store.has("demo", `${proj}${sep}`)).toBe(true);
		expect(store.grant("demo", `${proj}${sep}${sep}`)).toBe(false);
		if (WIN) {
			expect(store.has("demo", proj.replace(/\\/g, "/"))).toBe(true);
			expect(store.grant("demo", proj.replace(/\\/g, "/"))).toBe(false);
			expect(store.get("demo")).toHaveLength(1);
		}
	});
});

describe("非法输入拒绝", () => {
	it("非法 pluginId（路径穿越 / 空格 / 空）一律拒绝且不落盘", () => {
		const { store, dir, file } = makeStore();
		const proj = join(dir, "proj");
		for (const id of ["", "bad/id", "..", "../up", "a b", "a.b", "a\\b", "插件"]) {
			expect(store.grant(id, proj)).toBe(false);
			expect(store.has(id, proj)).toBe(false);
			expect(store.get(id)).toEqual([]);
			expect(store.revoke(id)).toBe(0);
		}
		expect(store.list()).toEqual([]);
		expect(existsSync(file)).toBe(false);
	});

	it("空路径 / 相对路径拒绝（grant false、has false），且不创建文件", () => {
		const { store, file } = makeStore();
		for (const p of ["", "   ", "relative/dir", "./x", ".."]) {
			expect(store.grant("demo", p)).toBe(false);
			expect(store.has("demo", p)).toBe(false);
		}
		expect(store.get("demo")).toEqual([]);
		expect(existsSync(file)).toBe(false);
	});
});

describe("revoke 三种粒度", () => {
	it("按目录撤销：只删该条，其他目录与其他插件不受影响", () => {
		const { store, dir } = makeStore();
		const d1 = join(dir, "d1");
		const d2 = join(dir, "d2");
		store.grant("alpha", d1);
		store.grant("alpha", d2);
		store.grant("beta", d1);

		expect(store.revoke("alpha", d1)).toBe(1);
		expect(store.has("alpha", d1)).toBe(false);
		expect(store.has("alpha", d2)).toBe(true);
		expect(store.has("beta", d1)).toBe(true);
		expect(store.revoke("alpha", d1)).toBe(0);
		expect(store.revoke("alpha", WIN ? d2.toUpperCase() : d2)).toBe(1);
		expect(store.get("alpha")).toEqual([]);
	});

	it("按插件撤销：清掉该插件全部，返回条数", () => {
		const { store, dir } = makeStore();
		store.grant("alpha", join(dir, "a"));
		store.grant("alpha", join(dir, "b"));
		store.grant("beta", join(dir, "c"));
		expect(store.revoke("alpha")).toBe(2);
		expect(store.get("alpha")).toEqual([]);
		expect(store.list()).toEqual([{ pluginId: "beta", paths: [resolve(join(dir, "c"))] }]);
		expect(store.revoke("alpha")).toBe(0);
	});

	it("清空整张表：返回总条数；只给 dir 的非法用法不动表", () => {
		const { store, dir } = makeStore();
		store.grant("alpha", join(dir, "a"));
		store.grant("beta", join(dir, "b"));
		store.grant("beta", join(dir, "c"));
		expect(store.revoke(undefined, join(dir, "a"))).toBe(0);
		expect(store.list()).toHaveLength(2);
		expect(store.revoke()).toBe(3);
		expect(store.list()).toEqual([]);
		expect(store.revoke()).toBe(0);
	});

	it("按目录撤销不会连带删除其子目录的独立条目", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "proj");
		store.grant("demo", proj);
		store.grant("demo", join(proj, "src"));
		expect(store.revoke("demo", proj)).toBe(1);
		expect(store.has("demo", join(proj, "src"))).toBe(true);
		expect(store.get("demo")).toEqual([resolve(join(proj, "src"))]);
	});
});

describe("坏文件 / 边界持久化", () => {
	it("JSON 坏 → 视为空表（list 空 / has false / get 空），且文件内容未被改写", () => {
		const { store, dir, file } = makeStore();
		const broken = "{ this is not json\n";
		writeFileSync(file, broken);

		expect(store.list()).toEqual([]);
		expect(store.get("demo")).toEqual([]);
		expect(store.has("demo", join(dir, "x"))).toBe(false);
		expect(store.revoke()).toBe(0);
		expect(store.revoke("demo")).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(broken);

		expect(store.grant("demo", join(dir, "x"))).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ grants: { demo: [resolve(join(dir, "x"))] } });
	});

	it("形状不对（数组 / grants 非对象 / 条目非法）→ 空表，非法条目被净化", () => {
		const { dir, file } = makeStore();
		const base = join(dir, "ok");
		writeFileSync(file, JSON.stringify([1, 2, 3]));
		expect(new PluginGrantsStore(dir).list()).toEqual([]);

		writeFileSync(file, JSON.stringify({ grants: "nope" }));
		expect(new PluginGrantsStore(dir).list()).toEqual([]);

		writeFileSync(file, JSON.stringify({ grants: { "bad/id": [base], good: ["relative/dir", base] } }));
		const store = new PluginGrantsStore(dir);
		expect(store.list()).toEqual([{ pluginId: "good", paths: [resolve(base)] }]);
	});

	it("文件里的重复条目 / 尾分隔符等价形式被去重", () => {
		const { dir, file } = makeStore();
		const base = join(dir, "dup");
		writeFileSync(file, JSON.stringify({ grants: { demo: [base, `${base}${sep}`, base] } }));
		expect(new PluginGrantsStore(dir).get("demo")).toEqual([resolve(base)]);
	});

	it("持久化：新建 store 读回同一 dataDir 的授权", () => {
		const { store, dir } = makeStore();
		const proj = join(dir, "proj");
		store.grant("demo", proj);

		const again = new PluginGrantsStore(dir);
		expect(again.has("demo", join(proj, "sub"))).toBe(true);
		expect(again.list()).toEqual([{ pluginId: "demo", paths: [resolve(proj)] }]);

		expect(again.revoke("demo", proj)).toBe(1);
		expect(store.has("demo", proj)).toBe(true);
		store.reload();
		expect(store.has("demo", proj)).toBe(false);
		expect(store.list()).toEqual([]);
	});

	it("reload() 重新读盘（手工写入的新授权生效）", () => {
		const { store, dir, file } = makeStore();
		const proj = join(dir, "proj");
		expect(store.has("demo", proj)).toBe(false);
		writeFileSync(file, JSON.stringify({ grants: { demo: [proj] } }));
		expect(store.has("demo", proj)).toBe(false);
		store.reload();
		expect(store.has("demo", proj)).toBe(true);
	});

	it("dataDir 不存在时也能写（自动建目录），磁盘不可写时不抛异常", () => {
		const dir = tmpDataDir();
		const nested = join(dir, "nested", "deeper");
		const store = new PluginGrantsStore(nested);
		expect(store.grant("demo", join(dir, "proj"))).toBe(true);
		expect(existsSync(join(nested, "plugin-grants.json"))).toBe(true);

		const badDir = tmpDataDir();
		store.reload();
		const bad = new PluginGrantsStore(badDir);
		mkdirSync(join(badDir, "plugin-grants.json"), { recursive: true });
		expect(() => bad.grant("demo", join(badDir, "proj"))).not.toThrow();
		expect(bad.has("demo", join(badDir, "proj"))).toBe(true);
	});
});
