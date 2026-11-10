import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extensionDisplayName } from "../../server/settings-service.js";

describe("extensionDisplayName", () => {
	it("以目录名命名手动放进 extensions 目录的扩展，而不是入口文件名", () => {
		// Build the path with `join` so this asserts the same thing on win32 and POSIX:
		// the helper resolves separators through `node:path`, which is platform-bound, so a
		// hard-coded `C:\\...` literal would only parse on Windows.
		const entry = join("/home/alice/.pi/agent/extensions/openviking", "index.ts");
		expect(
			extensionDisplayName({ path: entry, sourceInfo: { origin: "top-level", source: "auto", path: entry } }),
		).toBe("openviking");
	});

	it("POSIX 路径下同样取目录名", () => {
		expect(
			extensionDisplayName({
				path: "/home/alice/.pi/agent/extensions/openviking/index.js",
				sourceInfo: {
					origin: "top-level",
					source: "auto",
					path: "/home/alice/.pi/agent/extensions/openviking/index.js",
				},
			}),
		).toBe("openviking");
	});

	it("其他入口文件名变体也取目录名", () => {
		for (const entry of ["index.mjs", "index.cjs", "index.mts", "index.cts"]) {
			expect(
				extensionDisplayName({
					path: `/home/alice/.pi/agent/extensions/thing/${entry}`,
					sourceInfo: { origin: "top-level", path: `/home/alice/.pi/agent/extensions/thing/${entry}` },
				}),
			).toBe("thing");
		}
	});

	it("单文件扩展保留自己的文件名", () => {
		expect(
			extensionDisplayName({
				path: "/home/alice/.pi/agent/extensions/my-hook.ts",
				sourceInfo: { origin: "top-level", source: "auto", path: "/home/alice/.pi/agent/extensions/my-hook.ts" },
			}),
		).toBe("my-hook.ts");
	});

	it("npm 与 git 包沿用 source 规格", () => {
		expect(
			extensionDisplayName({
				path: "/home/alice/.pi/agent/npm/node_modules/cc-safety-net/dist/pi/index.js",
				sourceInfo: {
					origin: "package",
					source: "npm:cc-safety-net",
					path: "/home/alice/.pi/agent/npm/node_modules/cc-safety-net/dist/pi/index.js",
				},
			}),
		).toBe("npm:cc-safety-net");
		expect(
			extensionDisplayName({
				path: "/home/alice/.pi/agent/git/github.com/NVlabs/SoL-Pi/src/sol-pi/index.ts",
				sourceInfo: { origin: "package", source: "git:github.com/NVlabs/SoL-Pi" },
			}),
		).toBe("git:github.com/NVlabs/SoL-Pi");
	});

	it("缺少 sourceInfo 时用 extension.path 兜底", () => {
		expect(extensionDisplayName({ path: "/home/alice/.pi/agent/extensions/openviking/index.ts" })).toBe("openviking");
	});

	it("没有目录可退时不返回空串", () => {
		expect(extensionDisplayName({ path: "index.ts" })).toBe("index.ts");
	});
});
