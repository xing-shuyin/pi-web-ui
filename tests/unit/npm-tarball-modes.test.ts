import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { afterAll, describe, expect, it } from "vitest";
import { publishArgv } from "../../scripts/lib/npm-cli.mjs";
import {
	describeNpmTarball,
	inspectNpmTarball,
	normalizeNpmTarball,
	readTarballEntry,
} from "../../scripts/lib/npm-tarball.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SHEBANG = '#!/usr/bin/env node\nconsole.log("demo");\n';
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

const workdir = mkdtempSync(join(tmpdir(), "pi-npm-tarball-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

let archives = 0;

/**
 * 按 npm 包的布局（package/ 前缀 + portable 权限归一）打一个 .tgz：Windows 打包机上文件只能写成
 * 0644，正好复刻线上产物的形态（tar/mode-fix.js 的 (mode|0o600) & ~0o22）。
 */
async function pack(files: Record<string, string | Buffer>): Promise<Buffer> {
	const root = join(workdir, `src-${archives++}`);
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	const archive = join(workdir, `pack-${archives}.tgz`);
	await tar.create({ cwd: root, gzip: true, portable: true, prefix: "package/", file: archive }, Object.keys(files));
	return readFileSync(archive);
}

/** 用 tar 自己（而不是被测的解析器）读权限位；strict 会把校验和错误升级成异常。 */
async function listModes(archive: Buffer): Promise<Map<string, number>> {
	const file = join(workdir, `list-${archives++}.tgz`);
	writeFileSync(file, archive);
	const modes = new Map<string, number>();
	await tar.t({
		file,
		strict: true,
		onReadEntry: (entry) => {
			if (entry.type === "File") modes.set(entry.path, entry.mode ?? 0);
			entry.resume();
		},
	});
	return modes;
}

const manifest = (bin: unknown) => JSON.stringify({ name: "demo", version: "1.2.3", bin });

describe("npm tarball 的 bin 可执行位", () => {
	it("打包机没有 x 位时，把 bin/ 入口归一化成 0755，其余条目一个字节不动", async () => {
		const archive = await pack({
			"package.json": manifest({ demo: "bin/demo.mjs" }),
			"bin/demo.mjs": SHEBANG,
			"bin/lib/helper.mjs": "export const helper = 1;\n",
			"bin/device-p2p/linux-x64": ELF,
		});
		expect((await listModes(archive)).get("package/bin/demo.mjs")).toBe(0o644);

		const { buffer, changes } = normalizeNpmTarball(archive);

		expect(changes.map((change) => [change.name, change.from, change.to])).toEqual([
			["package/bin/demo.mjs", 0o644, 0o755],
			["package/bin/device-p2p/linux-x64", 0o644, 0o755],
		]);
		const modes = await listModes(buffer);
		expect(modes.get("package/bin/demo.mjs")).toBe(0o755);
		expect(modes.get("package/bin/device-p2p/linux-x64")).toBe(0o755);
		expect(modes.get("package/bin/lib/helper.mjs")).toBe(0o644);
		expect(modes.get("package/package.json")).toBe(0o644);
		expect(readTarballEntry(buffer, "package/bin/demo.mjs")?.toString()).toBe(SHEBANG);
	});

	it("重复归一化没有改动（幂等，可以直接跳过重写）", async () => {
		const archive = await pack({ "package.json": manifest({ demo: "bin/demo.mjs" }), "bin/demo.mjs": SHEBANG });
		const first = normalizeNpmTarball(archive);
		const second = normalizeNpmTarball(first.buffer);
		expect(second.changes).toEqual([]);
		expect(second.buffer).toBe(first.buffer);
	});

	it("pax 长路径（超 100 字节）的 bin 入口同样被识别", async () => {
		const longPath = `bin/${"deep-".repeat(24)}demo.mjs`;
		const archive = await pack({ "package.json": manifest({ demo: longPath }), [longPath]: SHEBANG });

		const { buffer, changes } = normalizeNpmTarball(archive);

		expect(changes).toEqual([{ name: `package/${longPath}`, from: 0o644, to: 0o755 }]);
		expect(readTarballEntry(buffer, `package/${longPath}`)?.toString()).toBe(SHEBANG);
	});
});

describe("npm tarball 发布前复查", () => {
	it("0644 的 bin 会被指出来（就是线上 0.120.0 的形态），归一化后干净", async () => {
		const archive = await pack({ "package.json": manifest({ demo: "bin/demo.mjs" }), "bin/demo.mjs": SHEBANG });

		const before = inspectNpmTarball(archive);
		expect(before.problems.join("\n")).toContain("缺可执行位");
		expect(before.bins).toEqual([{ command: "demo", path: "bin/demo.mjs", mode: 0o644 }]);

		const after = inspectNpmTarball(normalizeNpmTarball(archive).buffer);
		expect(after.problems).toEqual([]);
		expect(after.bins).toEqual([{ command: "demo", path: "bin/demo.mjs", mode: 0o755 }]);
		expect(describeNpmTarball({ inspection: after }).join("\n")).toContain("bin/demo.mjs 0755");
	});

	it("声明的 bin 缺失或没有 shebang 都要在发布前失败", async () => {
		const missing = await pack({ "package.json": manifest({ demo: "bin/ghost.mjs" }), "bin/demo.mjs": SHEBANG });
		expect(inspectNpmTarball(missing).problems.join("\n")).toContain("不在包里");

		const noShebang = await pack({
			"package.json": manifest({ demo: "bin/demo.mjs" }),
			"bin/demo.mjs": "console.log(1);\n",
		});
		expect(inspectNpmTarball(noShebang).problems.join("\n")).toContain("没有 shebang");
	});
});

describe("发布链路", () => {
	it("npm publish 只接受归一化后的 tarball（禁裸发目录，否则 npm 会重新打包丢掉权限位）", () => {
		const source = readFileSync(join(ROOT, "scripts", "publish-npm.mjs"), "utf8");
		expect(source).toContain("packAndNormalize(");
		expect(source).toContain("publishArgv(");
		expect(source).not.toMatch(/\[\s*"publish"\s*\]/);
		expect(publishArgv("/tmp/demo-1.0.0.tgz", { otp: "123456" })).toEqual([
			"publish",
			"/tmp/demo-1.0.0.tgz",
			"--otp=123456",
		]);
		expect(publishArgv("/tmp/demo-1.0.0.tgz", { dryRun: true })).toEqual([
			"publish",
			"/tmp/demo-1.0.0.tgz",
			"--dry-run",
		]);
	});
});
