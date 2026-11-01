import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	runtimeBaseFor,
	getDshFamily,
	getExpectedDshVersion,
	checkDshRuntimeCompatibility,
	parseNpmrcPrefix,
	findLocalPackageRoot,
	resolveRuntimeBaseWithDetails,
} from "../../server/dsh/runtime/runtime-root.mjs";

describe("runtime-root resolution and version compatibility", () => {
	const tempDirs: string[] = [];
	const createTempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "dsh-rt-test-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const d of tempDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {}
		}
		tempDirs.length = 0;
	});

	describe("runtimeBaseFor", () => {
		it("returns null for null or invalid root", () => {
			expect(runtimeBaseFor(null)).toBeNull();
			expect(runtimeBaseFor(undefined)).toBeNull();
			const emptyDir = createTempDir();
			expect(runtimeBaseFor(emptyDir)).toBeNull();
		});

		it("detects flat layout with dsh-base and dsh-app-boot", () => {
			const root = createTempDir();
			const baseDir = join(root, "@deepseek-ai", "dsh-base");
			const bootDir = join(root, "@deepseek-ai", "dsh-app-boot", "lib");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(bootDir, { recursive: true });
			writeFileSync(join(baseDir, "cordis.patch.yml"), "# patch");
			writeFileSync(join(bootDir, "index.js"), "// boot");

			const detected = runtimeBaseFor(root);
			expect(detected).toBe(resolve(root));
		});

		it("detects nested layout under @deepseek-ai/dsh/node_modules", () => {
			const root = createTempDir();
			const nestedRoot = join(root, "@deepseek-ai", "dsh", "node_modules");
			const baseDir = join(nestedRoot, "@deepseek-ai", "dsh-base");
			const bootDir = join(nestedRoot, "@deepseek-ai", "dsh-app-boot", "lib");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(bootDir, { recursive: true });
			writeFileSync(join(baseDir, "cordis.patch.yml"), "# patch");
			writeFileSync(join(bootDir, "index.js"), "// boot");

			const detected = runtimeBaseFor(root);
			expect(detected).toBe(resolve(nestedRoot));
		});

		it("returns null if cordis.patch.yml or boot index.js is missing", () => {
			const root = createTempDir();
			const baseDir = join(root, "@deepseek-ai", "dsh-base");
			mkdirSync(baseDir, { recursive: true });
			writeFileSync(join(baseDir, "cordis.patch.yml"), "# patch");
			// 缺少 dsh-app-boot
			expect(runtimeBaseFor(root)).toBeNull();
		});
	});

	describe("getDshFamily", () => {
		it("extracts major.minor for 0.x pre-releases", () => {
			expect(getDshFamily("0.1.5-rc.3")).toBe("0.1");
			expect(getDshFamily("0.1.5")).toBe("0.1");
			expect(getDshFamily("^0.1.5-rc.3")).toBe("0.1");
			expect(getDshFamily("v0.1.5-rc.2")).toBe("0.1");
			expect(getDshFamily("~0.2.1-rc.2")).toBe("0.2");
			expect(getDshFamily("0.2.1")).toBe("0.2");
			expect(getDshFamily("0.2.2")).toBe("0.2");
		});

		it("extracts major for >= 1.0 releases", () => {
			expect(getDshFamily("1.0.0")).toBe("1");
			expect(getDshFamily("1.2.3")).toBe("1");
			expect(getDshFamily("2.0.0-beta.1")).toBe("2");
		});

		it("handles invalid or empty inputs gracefully", () => {
			expect(getDshFamily("")).toBe("");
			expect(getDshFamily(null as unknown as string)).toBe("");
			expect(getDshFamily(undefined as unknown as string)).toBe("");
			expect(getDshFamily("invalid")).toBe("invalid");
		});
	});

	describe("checkDshRuntimeCompatibility", () => {
		it("marks compatible when families match", () => {
			const root = createTempDir();
			const basePkgDir = join(root, "@deepseek-ai", "dsh-base");
			mkdirSync(basePkgDir, { recursive: true });
			writeFileSync(join(basePkgDir, "package.json"), JSON.stringify({ version: "0.2.1-rc.2" }));

			const compat = checkDshRuntimeCompatibility(root, "0.2.1-rc.2");
			expect(compat.compatible).toBe(true);
			expect(compat.runtimeVersion).toBe("0.2.1-rc.2");
			expect(compat.runtimeFamily).toBe("0.2");
			expect(compat.expectedFamily).toBe("0.2");
		});

		it("marks compatible across minor patch/rc versions in the same 0.x family", () => {
			const root = createTempDir();
			const basePkgDir = join(root, "@deepseek-ai", "dsh-base");
			mkdirSync(basePkgDir, { recursive: true });
			writeFileSync(join(basePkgDir, "package.json"), JSON.stringify({ version: "0.2.2" }));

			const compat = checkDshRuntimeCompatibility(root, "0.2.1-rc.2");
			expect(compat.compatible).toBe(true);
		});

		it("marks incompatible when 0.x minor differs (e.g. 0.2.1 vs 0.1.5)", () => {
			const root = createTempDir();
			const basePkgDir = join(root, "@deepseek-ai", "dsh-base");
			mkdirSync(basePkgDir, { recursive: true });
			writeFileSync(join(basePkgDir, "package.json"), JSON.stringify({ version: "0.2.1-rc.2" }));

			const compat = checkDshRuntimeCompatibility(root, "0.1.5-rc.3");
			expect(compat.compatible).toBe(false);
			expect(compat.runtimeVersion).toBe("0.2.1-rc.2");
			expect(compat.runtimeFamily).toBe("0.2");
			expect(compat.expectedFamily).toBe("0.1");
		});

		it("handles missing package.json as incompatible", () => {
			const root = createTempDir();
			const compat = checkDshRuntimeCompatibility(root, "0.1.5-rc.3");
			expect(compat.compatible).toBe(false);
			expect(compat.runtimeVersion).toBeNull();
		});
	});

	describe("parseNpmrcPrefix", () => {
		it("extracts plain prefix", () => {
			const content = "prefix=/root/.local/npm\nregistry=https://registry.npmjs.org/";
			expect(parseNpmrcPrefix(content)).toBe(resolve("/root/.local/npm"));
		});

		it("extracts quoted prefix and ignores whitespace", () => {
			const content = '  prefix = "/custom/npm/path"  \n';
			expect(parseNpmrcPrefix(content)).toBe(resolve("/custom/npm/path"));
		});

		it("ignores commented lines", () => {
			const content = "# prefix=/ignored/comment\n; prefix=/also/ignored\nprefix=/real/prefix";
			expect(parseNpmrcPrefix(content)).toBe(resolve("/real/prefix"));
		});

		it("resolves tilde to user homedir", () => {
			const content = "prefix=~/my-npm";
			expect(parseNpmrcPrefix(content)).toBe(resolve(join(homedir(), "my-npm")));
		});

		it("returns null when no prefix key exists", () => {
			const content = "registry=https://registry.npmjs.org/\naudit=false\n";
			expect(parseNpmrcPrefix(content)).toBeNull();
			expect(parseNpmrcPrefix("")).toBeNull();
			expect(parseNpmrcPrefix(null as unknown as string)).toBeNull();
		});
	});

	describe("findLocalPackageRoot and getExpectedDshVersion", () => {
		it("locates the repository package root", () => {
			const pkgRoot = findLocalPackageRoot();
			expect(pkgRoot).toBeTruthy();
			expect(pkgRoot).toContain("pi-web-ui");
		});

		it("reads expected DSH version from package dependencies or fallback", () => {
			const expected = getExpectedDshVersion();
			expect(expected).toBeTruthy();
			expect(getDshFamily(expected)).toBe("0.2");
		});
	});

	describe("resolveRuntimeBaseWithDetails", () => {
		it("respects PI_WEB_DSH_RUNTIME explicit override", async () => {
			const root = createTempDir();
			const baseDir = join(root, "@deepseek-ai", "dsh-base");
			const bootDir = join(root, "@deepseek-ai", "dsh-app-boot", "lib");
			mkdirSync(baseDir, { recursive: true });
			mkdirSync(bootDir, { recursive: true });
			writeFileSync(join(baseDir, "cordis.patch.yml"), "# patch");
			writeFileSync(join(bootDir, "index.js"), "// boot");
			const expectedVer = getExpectedDshVersion();
			writeFileSync(join(baseDir, "package.json"), JSON.stringify({ version: expectedVer }));

			const oldEnv = process.env.PI_WEB_DSH_RUNTIME;
			process.env.PI_WEB_DSH_RUNTIME = root;
			try {
				const result = await resolveRuntimeBaseWithDetails();
				expect(result.base).toBe(resolve(root));
				expect(result.compatibility?.compatible).toBe(true);
				const explicitScanned = result.scannedPaths.find((s) => s.source === "env:PI_WEB_DSH_RUNTIME");
				expect(explicitScanned).toBeDefined();
				expect(explicitScanned?.exists).toBe(true);
				expect(explicitScanned?.validRuntime).toBe(true);
			} finally {
				if (oldEnv !== undefined) {
					process.env.PI_WEB_DSH_RUNTIME = oldEnv;
				} else {
					delete process.env.PI_WEB_DSH_RUNTIME;
				}
			}
		});

		it("records scanned paths when a candidate does not exist or lacks runtime packages", async () => {
			const nonExistent = join(createTempDir(), "not-exists");
			const oldEnv = process.env.PI_WEB_DSH_RUNTIME;
			process.env.PI_WEB_DSH_RUNTIME = nonExistent;
			try {
				const result = await resolveRuntimeBaseWithDetails();
				const explicitScanned = result.scannedPaths.find((s) => s.source === "env:PI_WEB_DSH_RUNTIME");
				expect(explicitScanned).toBeDefined();
				expect(explicitScanned?.exists).toBe(false);
			} finally {
				if (oldEnv !== undefined) {
					process.env.PI_WEB_DSH_RUNTIME = oldEnv;
				} else {
					delete process.env.PI_WEB_DSH_RUNTIME;
				}
			}
		});
	});
});
