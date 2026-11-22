/**
 * `server-config.json` 落盘守卫：状态可表达（不存在 / 合法 / 损坏）+ 权限位 0600/0700（issue #969 第 2 条）。
 *
 * 为什么不放在 `setup-config.test.ts`：那份测「/setup 保存的事务性」，这里测「文件本身长什么样、
 * 坏了之后服务还认不认证」。落盘（write + mode）与读判据都只由 `server/server-config.ts` 提供。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { blankNonCode } from "../helpers/code-scan.js";
import {
	CONFIG_FILE_MODE,
	DATA_DIR_MODE,
	configFilePath,
	ensurePrivateDataDir,
	loadServerFileConfig,
	readServerFileConfig,
	saveServerFileConfig,
} from "../../server/server-config.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const POSIX = process.platform !== "win32";
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-server-config-"));
	dirs.push(dir);
	return dir;
}

function backupsIn(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.startsWith("server-config.json.corrupt-"));
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server-config 状态可表达", () => {
	it("从未配置：absent + 空配置，不是损坏", async () => {
		expect(readServerFileConfig(tempDir())).toEqual({ state: "absent", config: {}, error: "" });
	});

	it("合法配置：ok", async () => {
		const dir = tempDir();
		await saveServerFileConfig(dir, { token: "abc", port: 9001 });
		expect(readServerFileConfig(dir)).toEqual({ state: "ok", config: { token: "abc", port: 9001 }, error: "" });
	});

	it("合法空配置（{}）是 ok，不是损坏", async () => {
		const dir = tempDir();
		writeFileSync(configFilePath(dir), "{}\n", "utf8");
		expect(readServerFileConfig(dir)).toEqual({ state: "ok", config: {}, error: "" });
	});

	it("字段类型不对只是忽略字段，不算损坏", async () => {
		const dir = tempDir();
		writeFileSync(configFilePath(dir), JSON.stringify({ token: 42, port: "9001", host: " 127.0.0.1 " }), "utf8");
		expect(readServerFileConfig(dir)).toEqual({ state: "ok", config: { host: "127.0.0.1" }, error: "" });
	});

	it("损坏：fail-closed 到临时口令，原文件原样保留并另存备份", async () => {
		const dir = tempDir();
		const broken = '{ "token": "truncated';
		writeFileSync(configFilePath(dir), broken, "utf8");
		const loaded = readServerFileConfig(dir);
		expect(loaded.state).toBe("corrupt");
		// 绝不返回空口令：空口令 = 服务不再要求认证（fail-open）
		expect(loaded.config.token).toMatch(/^[0-9a-f]{48}$/);
		expect(loaded.error).toContain("JSON 解析失败");
		expect(loaded.error).toContain("server-config.json.corrupt-");
		// 原文件不被改写、不被删
		expect(readFileSync(configFilePath(dir), "utf8")).toBe(broken);
		const backups = backupsIn(dir);
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(broken);
	});

	it("顶层不是对象一律按损坏处理（null / 数组 / 裸字符串）", async () => {
		for (const raw of ["null", "[]", '"pi"']) {
			const dir = tempDir();
			writeFileSync(configFilePath(dir), raw, "utf8");
			expect(readServerFileConfig(dir).state).toBe("corrupt");
		}
	});

	it("同一份坏内容只留一份备份（反复重启不堆文件）", async () => {
		const dir = tempDir();
		writeFileSync(configFilePath(dir), "oops", "utf8");
		readServerFileConfig(dir);
		readServerFileConfig(dir);
		expect(backupsIn(dir)).toHaveLength(1);
	});

	it("每次读损坏文件都给新的临时口令，且临时口令不落盘", async () => {
		const dir = tempDir();
		writeFileSync(configFilePath(dir), "not json", "utf8");
		const first = loadServerFileConfig(dir).token;
		const second = loadServerFileConfig(dir).token;
		expect(first).toMatch(/^[0-9a-f]{48}$/);
		expect(first).not.toBe(second);
		expect(readFileSync(configFilePath(dir), "utf8")).toBe("not json");
	});
});

describe("server-config 权限位", () => {
	it("文件 0600 / 目录 0700 是常量单源", async () => {
		expect(CONFIG_FILE_MODE).toBe(0o600);
		expect(DATA_DIR_MODE).toBe(0o700);
	});

	it.runIf(POSIX)("新建的 server-config.json 落盘为 0600", async () => {
		const dir = tempDir();
		await saveServerFileConfig(dir, { token: "secret-token" });
		expect(statSync(configFilePath(dir)).mode & 0o777).toBe(0o600);
	});

	it.runIf(POSIX)("原文件是 0644 的老安装被收紧为 0600", async () => {
		const dir = tempDir();
		writeFileSync(configFilePath(dir), '{"token":"old"}\n', "utf8");
		chmodSync(configFilePath(dir), 0o644);
		expect(statSync(configFilePath(dir)).mode & 0o777).toBe(0o644);
		await saveServerFileConfig(dir, { token: "new-token" });
		expect(statSync(configFilePath(dir)).mode & 0o777).toBe(0o600);
		expect(loadServerFileConfig(dir)).toEqual({ token: "new-token" });
	});

	it.runIf(POSIX)("数据目录 0755 收紧为 0700，新建目录直接 0700", async () => {
		const existing = join(tempDir(), "data");
		mkdirSync(existing);
		chmodSync(existing, 0o755);
		await saveServerFileConfig(existing, { token: "t" });
		expect(statSync(existing).mode & 0o777).toBe(0o700);

		const fresh = join(tempDir(), "fresh");
		ensurePrivateDataDir(fresh);
		expect(statSync(fresh).mode & 0o777).toBe(0o700);
	});

	it("写入仍然是原子的：不复用旧文件的 mode 覆盖，也不留下临时文件", async () => {
		const dir = tempDir();
		await saveServerFileConfig(dir, { token: "a" });
		await saveServerFileConfig(dir, { token: "b" });
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(loadServerFileConfig(dir)).toEqual({ token: "b" });
	});

	// POSIX 断言在 Windows 上跑不了，这条在所有平台跑：把「光传 mode 不够、必须显式 chmod」钉在源码里。
	it("落盘路径既传 mode 又显式 chmod（writeAtomic 不沿用旧 mode，0600 靠这两手）", async () => {
		const source = readFileSync(join(ROOT, "server/server-config.ts"), "utf8");
		expect(source).toMatch(/writeAtomic\(file,[\s\S]{0,200}\{ mode: CONFIG_FILE_MODE \}/);
		expect(source).toMatch(/chmod\(file, CONFIG_FILE_MODE\)/);
	});
});

describe("server-config 落盘单源守卫", () => {
	it("server-config.json 只由 server/server-config.ts 写", async () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
				if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
				if (path === "server/server-config.ts") continue;
				const code = blankNonCode(readFileSync(join(ROOT, path), "utf8"));
				// 另起一条写路径 = 不会再经过 0600/原子写；只允许读（bin/pi-web-ui.mjs 复用读取）。
				if (/server-config\.json/.test(code) && /writeAtomicSync|writeFileSync|writeFile\(|renameSync/.test(code))
					offenders.push(path);
			}
		};
		for (const dir of ["server", "web/src", "bin", "shared"]) walk(dir);
		expect(offenders).toEqual([]);
	});
});
