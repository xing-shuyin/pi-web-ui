import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINK_UNSUPPORTED_CODES, publishFileExclusive, publishFileExclusiveSync } from "../../server/atomic-file.js";

/**
 * 守卫：独占发布只能有一份实现（issues/933）。
 *
 * 事故形态：`link(temp, dest)` 被抄在五个地方实现「目标已存在则失败」的原子发布。硬链接在不支持它的
 * 文件系统（Android/Termux 的 /data、FAT32/exFAT、部分网络/容器 fs）上直接被拒，于是上传、文件传输、
 * 证据快照、发布日志、设备文件同步**同时**挂掉；后来有人在 `desktop-files-fs.ts` 又补了一份私货降级表，
 * 漏掉 EACCES —— Termux 上文件同步照旧失败，而补丁「看起来已经修过了」。
 *
 * 所以：裸 `link` / `COPYFILE_EXCL` 只许出现在 `server/atomic-file.ts`，其余调用点一律走
 * `publishFileExclusive*`。码表也只有一份（`LINK_UNSUPPORTED_CODES`）。
 */

const SERVER = fileURLToPath(new URL("../../server", import.meta.url));
const OWNER = join(SERVER, "atomic-file.ts");

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

const files = walk(SERVER).filter((file) => file !== OWNER);

/** 去掉注释，只留代码：注释里写 `link(2)` 是在解释根因，不该算违规。 */
function codeOf(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("独占发布单源（issues/933）", () => {
	it("裸 link / linkSync 只出现在 atomic-file.ts", () => {
		const offenders = files
			.filter((file) => /\blinkSync?\s*\(/.test(codeOf(readFileSync(file, "utf8"))))
			.map((file) => file.slice(SERVER.length + 1));
		expect(
			offenders,
			`这些地方自己调 link 而没有走 publishFileExclusive*（不支持硬链接的 fs 上会直接失败）：${offenders.join(", ")}`,
		).toEqual([]);
	});

	it("没有第二份手写降级表：既试 link 又回退 COPYFILE 的地方只能是 atomic-file.ts", () => {
		// 单纯用 COPYFILE_EXCL 做「快照拷贝不缺盖」是正当的（file-archives / skill-maintenance）；
		// 违规形态是「先 link、失败了再 copy」这套降级被抄了第二份（码表往往还漏码）。
		const offenders = files
			.filter((file) => {
				const code = codeOf(readFileSync(file, "utf8"));
				return /COPYFILE_EXCL/.test(code) && /(?<![\w$])linkSync?\s*\(/.test(code);
			})
			.map((file) => file.slice(SERVER.length + 1));
		expect(offenders, `这些地方自己抄了「link 失败就 copyFile」的降级表：${offenders.join(", ")}`).toEqual([]);
	});

	it("会用独占发布的调用点全都用同一份实现", () => {
		const expected = [
			"uploads.ts",
			"file-transfer-routes.ts",
			"context-evidence.ts",
			join("device-center", "publication-journal.ts"),
			join("device-center", "desktop-files-fs.ts"),
		];
		const missing = expected.filter((rel) => {
			const source = readFileSync(join(SERVER, rel), "utf8");
			return !/publishFileExclusive(Sync)?\(/.test(source);
		});
		expect(missing, `这些调用点还没收敛到 publishFileExclusive*：${missing.join(", ")}`).toEqual([]);
	});

	it("降级码表覆盖「不支持硬链接」的那类错误，且不吞真故障", () => {
		for (const code of ["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]) {
			expect(LINK_UNSUPPORTED_CODES as readonly string[], `码表漏了 ${code}`).toContain(code);
		}
		// 真故障（ENOENT/ENOSPC/EIO）不在表里：降级只会掩盖它们，让排查失去线索。
		for (const code of ["ENOENT", "ENOSPC", "EIO", "EEXIST"]) {
			expect(LINK_UNSUPPORTED_CODES as readonly string[]).not.toContain(code);
		}
		expect(typeof publishFileExclusive).toBe("function");
		expect(typeof publishFileExclusiveSync).toBe("function");
	});
});
