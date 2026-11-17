import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeResolvedRuntime,
	parseRuntimePointer,
	readBundledProtocolVersion,
	readRuntimeProtocolVersion,
	resolveRuntime,
	runtimeEntryPath,
	runtimeVersionDir,
	isSafeRuntimeVersion,
} from "../../desktop/runtime-store.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	runtimeRootDir: string;
	bundledRoot: string;
	runtimeDir: (version: string) => string;
	writePointer: (pointer: unknown) => Promise<void>;
	addRuntime: (version: string, options?: { entry?: boolean; protocol?: number | null }) => Promise<string>;
}

/** 一套假的 `<userData>/runtime` + 假的安装包内自带运行时（真的落盘，走真 fs）。 */
async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-desktop-runtime-"));
	dirs.push(root);
	const runtimeRootDir = join(root, "userData", "runtime");
	const bundledRoot = join(root, "app");
	await mkdir(runtimeRootDir, { recursive: true });
	await mkdir(join(bundledRoot, "dist", "server"), { recursive: true });
	await writeFile(join(bundledRoot, "dist", "server", "index.js"), "// bundled\n");
	await writeFile(join(bundledRoot, "dist", "server", "protocol-version.js"), "export const PROTOCOL_VERSION = 59;\n");
	const result: Fixture = {
		root,
		runtimeRootDir,
		bundledRoot,
		runtimeDir: (version) => runtimeVersionDir(runtimeRootDir, version),
		writePointer: async (pointer) => {
			await writeFile(
				join(runtimeRootDir, "current.json"),
				typeof pointer === "string" ? pointer : JSON.stringify(pointer),
			);
		},
		addRuntime: async (version, options = {}) => {
			const dir = runtimeVersionDir(runtimeRootDir, version);
			await mkdir(join(dir, "dist", "server"), { recursive: true });
			if (options.entry !== false) await writeFile(runtimeEntryPath(dir), "// runtime\n");
			if (options.protocol !== undefined && options.protocol !== null) {
				await writeFile(
					join(dir, "dist", "server", "protocol-version.js"),
					`export const PROTOCOL_VERSION = ${options.protocol};\n`,
				);
			}
			return dir;
		},
	};
	return result;
}

function pointer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		version: "0.122.0",
		protocol: 59,
		lastGoodVersion: null,
		consecutiveFailures: 0,
		...overrides,
	};
}

function resolve(f: Fixture, bundledProtocol: number | null = 59) {
	return resolveRuntime({ runtimeRootDir: f.runtimeRootDir, bundledRoot: f.bundledRoot, bundledProtocol });
}

describe("current.json 解析（手改坏 / 路径穿越都要拦住）", () => {
	it("合法指针原样读出，缺省字段补默认值", () => {
		expect(parseRuntimePointer(pointer())).toMatchObject({
			schemaVersion: 1,
			version: "0.122.0",
			protocol: 59,
			lastGoodVersion: null,
			consecutiveFailures: 0,
			nativesVersion: null,
			installedAt: null,
		});
	});

	it("schemaVersion 不认识就整份作废", () => {
		expect(parseRuntimePointer(pointer({ schemaVersion: 2 }))).toBeNull();
		expect(parseRuntimePointer(pointer({ schemaVersion: undefined }))).toBeNull();
	});

	it("版本号只认安全字符：路径穿越、绝对路径、空值一律作废", () => {
		for (const bad of ["..", "../0.122.0", "0.122.0/../../etc", "C:\\Windows", "/etc/passwd", "", "  ", null, 122]) {
			expect(parseRuntimePointer(pointer({ version: bad })), String(bad)).toBeNull();
		}
		expect(isSafeRuntimeVersion("0.122.0-beta.1")).toBe(true);
		expect(isSafeRuntimeVersion("1234")).toBe(true);
	});

	it("lastGoodVersion 不合规时整份作废（否则会退到错目录）", () => {
		expect(parseRuntimePointer(pointer({ lastGoodVersion: "../oops" }))).toBeNull();
		expect(parseRuntimePointer(pointer({ lastGoodVersion: "0.121.0" }))).toMatchObject({ lastGoodVersion: "0.121.0" });
	});

	it("protocol 非正整数当没声明；失败计数只认正整数", () => {
		expect(parseRuntimePointer(pointer({ protocol: 0 }))?.protocol).toBeNull();
		expect(parseRuntimePointer(pointer({ protocol: -1 }))?.protocol).toBeNull();
		expect(parseRuntimePointer(pointer({ protocol: "59" }))?.protocol).toBeNull();
		expect(parseRuntimePointer(pointer({ consecutiveFailures: -3 }))?.consecutiveFailures).toBe(0);
		expect(parseRuntimePointer(pointer({ consecutiveFailures: 2.5 }))?.consecutiveFailures).toBe(0);
	});

	it("不是对象 / null 都返回 null", () => {
		for (const bad of [null, undefined, 42, "x", []]) expect(parseRuntimePointer(bad), String(bad)).toBeNull();
	});
});

describe("加载路径落盘判定（P0 只读：绝不写、绝不抛）", () => {
	it("没有 current.json → 跑安装包内自带的那份", async () => {
		const f = await fixture();
		const resolved = resolve(f);
		expect(resolved).toMatchObject({
			source: "bundled",
			reason: "no-pointer",
			entry: join(f.bundledRoot, "dist", "server", "index.js"),
		});
	});

	it("current.json 是坏 JSON → 跑自带，且理由区分于「没装过」", async () => {
		const f = await fixture();
		await f.writePointer("{ not json");
		expect(resolve(f)).toMatchObject({ source: "bundled", reason: "bad-pointer" });
	});

	it("指针合法且目录/入口/协议都对 → 跑运行时那份", async () => {
		const f = await fixture();
		const dir = await f.addRuntime("0.122.0", { protocol: 59 });
		await f.writePointer(pointer());
		expect(resolve(f)).toEqual({
			source: "runtime",
			root: dir,
			entry: runtimeEntryPath(dir),
			version: "0.122.0",
			protocol: 59,
			reason: null,
		});
	});

	it("目录被手删 → 回落自带", async () => {
		const f = await fixture();
		await f.writePointer(pointer());
		expect(resolve(f)).toMatchObject({ source: "bundled", reason: "missing-dir" });
	});

	it("目录在但 dist/server/index.js 不在（半成品）→ 绝不执行，回落自带", async () => {
		const f = await fixture();
		await f.addRuntime("0.122.0", { entry: false, protocol: 59 });
		await f.writePointer(pointer());
		expect(resolve(f)).toMatchObject({ source: "bundled", reason: "missing-entry" });
	});

	it("协议与壳自带不一致 → 回落自带（宁跑旧一体包，不要前后端对不上）", async () => {
		const f = await fixture();
		await f.addRuntime("0.122.0", { protocol: 60 });
		await f.writePointer(pointer({ protocol: 60 }));
		expect(resolve(f)).toMatchObject({ source: "bundled", reason: "protocol-mismatch" });
	});

	it("读不到壳自带协议（null）时不做闸门，避免误杀", async () => {
		const f = await fixture();
		await f.addRuntime("0.122.0", { protocol: 60 });
		await f.writePointer(pointer({ protocol: 60 }));
		expect(resolve(f, null)).toMatchObject({ source: "runtime", version: "0.122.0" });
	});

	it("current 坏掉但有 lastGood → 退 lastGood（同一份指针，不下载任何东西）", async () => {
		const f = await fixture();
		await f.addRuntime("0.121.0", { protocol: 59 });
		await f.writePointer(pointer({ lastGoodVersion: "0.121.0" }));
		expect(resolve(f)).toMatchObject({ source: "runtime", version: "0.121.0", protocol: 59 });
	});

	it("lastGood 的协议也要过闸门（现读它自己的 protocol-version.js）", async () => {
		const f = await fixture();
		await f.addRuntime("0.121.0", { protocol: 58 });
		await f.writePointer(pointer({ lastGoodVersion: "0.121.0" }));
		expect(resolve(f)).toMatchObject({ source: "bundled", reason: "protocol-mismatch" });
	});

	it("连续失败 ≥2 → current 视为隔离，直接用 lastGood", async () => {
		const f = await fixture();
		await f.addRuntime("0.122.0", { protocol: 59 });
		await f.addRuntime("0.121.0", { protocol: 59 });
		await f.writePointer(pointer({ version: "0.122.0", lastGoodVersion: "0.121.0", consecutiveFailures: 2 }));
		expect(resolve(f)).toMatchObject({ source: "runtime", version: "0.121.0" });
	});

	it("隔离状态下 lastGood 也没了 → 回落自带，理由是 quarantine-unusable", async () => {
		const f = await fixture();
		await f.addRuntime("0.122.0", { protocol: 59 });
		await f.writePointer(pointer({ lastGoodVersion: "0.121.0", consecutiveFailures: 2 }));
		expect(resolve(f)).toMatchObject({ source: "bundled", reason: "quarantine-unusable" });
	});

	it("运行时根可指到任意目录（实机测试用的 PI_DESKTOP_RUNTIME_ROOT 就走这条路径）", async () => {
		const f = await fixture();
		const custom = join(f.root, "custom-runtime");
		await mkdir(join(custom, "0.122.0", "dist", "server"), { recursive: true });
		await writeFile(runtimeEntryPath(join(custom, "0.122.0")), "// runtime\n");
		await writeFile(
			join(custom, "0.122.0", "dist", "server", "protocol-version.js"),
			"export const PROTOCOL_VERSION = 59;\n",
		);
		await writeFile(join(custom, "current.json"), JSON.stringify(pointer()));
		const resolved = resolveRuntime({ runtimeRootDir: custom, bundledRoot: f.bundledRoot, bundledProtocol: 59 });
		expect(resolved).toMatchObject({ source: "runtime", root: join(custom, "0.122.0") });
	});

	it("日志一行能看出跑了哪份、为什么回落", async () => {
		const f = await fixture();
		expect(describeResolvedRuntime(resolve(f))).toContain("source=bundled version=- reason=no-pointer");
		const dir = await f.addRuntime("0.122.0", { protocol: 59 });
		await f.writePointer(pointer());
		expect(describeResolvedRuntime(resolve(f))).toBe(`source=runtime version=0.122.0 entry=${runtimeEntryPath(dir)}`);
	});
});

describe("协议版本读取", () => {
	it("从 tsc 产物里抽常量", () => {
		expect(readRuntimeProtocolVersion(join(repoRoot, "server"), () => "export const PROTOCOL_VERSION = 59;\n")).toBe(
			59,
		);
	});

	it("壳自带运行时读不到 / 内容不对 → null（闸门放行而不是判死）", async () => {
		const empty = await mkdtemp(join(tmpdir(), "pi-desktop-protocol-empty-"));
		const garbage = await mkdtemp(join(tmpdir(), "pi-desktop-protocol-bad-"));
		const good = await mkdtemp(join(tmpdir(), "pi-desktop-protocol-ok-"));
		dirs.push(empty, garbage, good);
		expect(await readBundledProtocolVersion(empty)).toBeNull();
		await writeFile(join(garbage, "protocol-version.js"), "export const SOMETHING = 1;\n");
		expect(await readBundledProtocolVersion(garbage)).toBeNull();
		await writeFile(join(good, "protocol-version.js"), "export const PROTOCOL_VERSION = 59;\n");
		expect(await readBundledProtocolVersion(good)).toBe(59);
	});
});

describe("接线守卫：壳必须真的问过 runtime-store", () => {
	const mainSource = readFileSync(join(repoRoot, "desktop", "main.ts"), "utf8");
	const storeSource = readFileSync(join(repoRoot, "desktop", "runtime-store.ts"), "utf8");

	it("resolveServerEntry 走 resolveRuntime，并使用 userData 下的 runtime 目录", () => {
		expect(mainSource).toContain("await resolveServerEntry()");
		expect(mainSource).toContain("resolveRuntime({");
		expect(mainSource).toContain("RUNTIME_DIRNAME");
		expect(mainSource).toContain("PI_DESKTOP_RUNTIME_ROOT");
	});

	it("runtime-store 不 import electron（保持可单测、可跨平台）", () => {
		expect(storeSource).not.toMatch(/from "electron"/);
		expect(storeSource).not.toMatch(/from "electron\//);
	});
});
