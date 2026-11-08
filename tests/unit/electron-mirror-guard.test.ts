import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR,
	DEFAULT_ELECTRON_MIRROR,
	withElectronMirror,
} from "../../scripts/lib/electron-mirror.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** npm 11 起，`.npmrc` 里的自定义键会被当成未识别配置告警，npm 12 起不再透传成 `npm_config_*`。 */
const DEPRECATED_NPMRC_KEYS =
	/^\s*(electron[_-]?mirror|electron[_-]?builder[_-]?binaries[_-]?mirror|electron[_-]?custom[_-]\w+)\s*=/im;

describe("electron 镜像配置", () => {
	it("默认补上 npmmirror 的两个镜像地址，并尊重用户覆盖", () => {
		const merged = withElectronMirror({ ELECTRON_MIRROR: "https://proxy.local/electron/" });
		expect(merged.ELECTRON_MIRROR).toBe("https://proxy.local/electron/");
		expect(merged.ELECTRON_BUILDER_BINARIES_MIRROR).toBe(DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR);

		const fresh = withElectronMirror({});
		expect(fresh.ELECTRON_MIRROR).toBe(DEFAULT_ELECTRON_MIRROR);
		expect(fresh.ELECTRON_MIRROR).toMatch(/^https:\/\//);
		expect(fresh.ELECTRON_BUILDER_BINARIES_MIRROR).toMatch(/^https:\/\//);
	});

	it("空值回落默认镜像，且不污染传入的 env 对象", () => {
		const source: NodeJS.ProcessEnv = { ELECTRON_MIRROR: "   " };
		expect(withElectronMirror(source).ELECTRON_MIRROR).toBe(DEFAULT_ELECTRON_MIRROR);
		expect(source.ELECTRON_MIRROR).toBe("   ");
	});

	it("仓库根不放带自定义键的 .npmrc（npm run 会逐条告警）", () => {
		const npmrcPath = join(root, ".npmrc");
		if (!existsSync(npmrcPath)) return;
		expect(readFileSync(npmrcPath, "utf8")).not.toMatch(DEPRECATED_NPMRC_KEYS);
	});

	it("打包入口统一走 run-electron-builder 包装器", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
		expect(pkg.scripts["desktop:dist"]).toContain("scripts/run-electron-builder.mjs");

		const portable = readFileSync(join(root, "scripts", "make-portable.mjs"), "utf8");
		expect(portable).toContain("scripts/run-electron-builder.mjs");
		expect(portable).not.toMatch(/npx electron-builder/);
	});
});
