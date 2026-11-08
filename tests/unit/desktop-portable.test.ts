import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyPortableEnvironment,
	detectPortableRoot,
	findPortableGit,
	findPortableNode,
	hasPortableMarkers,
	resolvePortablePaths,
	type PortablePaths,
} from "../../desktop/portable.js";

describe("desktop/portable.ts 便携模式纯逻辑", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-portable-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	describe("hasPortableMarkers", () => {
		it("空目录返回 false", () => {
			expect(hasPortableMarkers(tempDir)).toBe(false);
		});

		it("包含 Portable.flag 时返回 true", () => {
			writeFileSync(join(tempDir, "Portable.flag"), "");
			expect(hasPortableMarkers(tempDir)).toBe(true);
		});

		it("包含 data/ 目录时返回 true", () => {
			mkdirSync(join(tempDir, "data"));
			expect(hasPortableMarkers(tempDir)).toBe(true);
		});

		it("包含 runtime/git 目录时返回 true", () => {
			mkdirSync(join(tempDir, "runtime", "git"), { recursive: true });
			expect(hasPortableMarkers(tempDir)).toBe(true);
		});

		it("包含 runtime/node 目录时返回 true", () => {
			mkdirSync(join(tempDir, "runtime", "node"), { recursive: true });
			expect(hasPortableMarkers(tempDir)).toBe(true);
		});
	});

	describe("detectPortableRoot", () => {
		it("PI_PORTABLE_ROOT 环境变量优先生效", () => {
			const customRoot = join(tempDir, "custom-root");
			mkdirSync(customRoot);
			const detected = detectPortableRoot(join(tempDir, "app", "pi.exe"), {
				PI_PORTABLE_ROOT: customRoot,
			});
			expect(detected).toBe(customRoot);
		});

		it("PORTABLE_EXECUTABLE_DIR（electron-builder便携变量）生效", () => {
			const ebRoot = join(tempDir, "eb-root");
			mkdirSync(ebRoot);
			const detected = detectPortableRoot(join(tempDir, "app", "pi.exe"), {
				PORTABLE_EXECUTABLE_DIR: ebRoot,
			});
			expect(detected).toBe(ebRoot);
		});

		it("标准目录结构：exe 位于 app/ 且父级包含 Portable.flag 时解析父级为根", () => {
			writeFileSync(join(tempDir, "Portable.flag"), "");
			const appDir = join(tempDir, "app");
			mkdirSync(appDir);
			const exePath = join(appDir, "pi-web-ui-desktop.exe");

			const detected = detectPortableRoot(exePath, {});
			expect(detected).toBe(tempDir);
		});

		it("扁平结构：exe 与 Portable.flag 同级时解析同级为根", () => {
			writeFileSync(join(tempDir, "Portable.flag"), "");
			const exePath = join(tempDir, "pi-web-ui-desktop.exe");

			const detected = detectPortableRoot(exePath, {});
			expect(detected).toBe(tempDir);
		});

		it("无便携标记且无环境变量时返回 null", () => {
			const appDir = join(tempDir, "app");
			mkdirSync(appDir);
			const exePath = join(appDir, "pi-web-ui-desktop.exe");

			expect(detectPortableRoot(exePath, {})).toBeNull();
		});
	});

	describe("findPortableGit", () => {
		it("在 runtime/git/cmd/git.exe 存在时能正确返回路径", () => {
			const gitDir = join(tempDir, "runtime", "git");
			mkdirSync(join(gitDir, "cmd"), { recursive: true });
			writeFileSync(join(gitDir, "cmd", "git.exe"), "");

			expect(findPortableGit(tempDir, join(tempDir, "app"))).toBe(gitDir);
		});

		it("不存在 git.exe 时返回 null", () => {
			expect(findPortableGit(tempDir, join(tempDir, "app"))).toBeNull();
		});
	});

	describe("findPortableNode", () => {
		it("在 runtime/node/node.exe 存在时能正确返回路径", () => {
			const nodeDir = join(tempDir, "runtime", "node");
			mkdirSync(nodeDir, { recursive: true });
			writeFileSync(join(nodeDir, "node.exe"), "");

			expect(findPortableNode(tempDir, join(tempDir, "app"))).toBe(nodeDir);
		});

		it("不存在 node.exe 时返回 null", () => {
			expect(findPortableNode(tempDir, join(tempDir, "app"))).toBeNull();
		});
	});

	describe("resolvePortablePaths", () => {
		it("完整解析便携路径并尊重默认值与自定义覆盖", () => {
			writeFileSync(join(tempDir, "Portable.flag"), "");
			const exePath = join(tempDir, "app", "pi.exe");

			const paths = resolvePortablePaths(exePath, {});
			expect(paths).not.toBeNull();
			expect(paths!.isPortable).toBe(true);
			expect(paths!.portableRoot).toBe(tempDir);
			expect(paths!.dataRoot).toBe(join(tempDir, "data"));
			expect(paths!.electronDataDir).toBe(join(tempDir, "data", "electron"));
			expect(paths!.webDataDir).toBe(join(tempDir, "data", "web"));
			expect(paths!.agentDir).toBe(join(tempDir, "data", "agent"));
			expect(paths!.workspaceDir).toBe(join(tempDir, "data", "workspace"));
			expect(paths!.gitDir).toBeNull();
			expect(paths!.nodeDir).toBeNull();
			expect(paths!.npmGlobalDir).toBe(join(tempDir, "data", "npm-global"));
			expect(paths!.npmCacheDir).toBe(join(tempDir, "data", "npm-cache"));
			expect(paths!.gitConfigGlobal).toBe(join(tempDir, "data", "git", ".gitconfig"));
			expect(paths!.userHome).toBe(join(tempDir, "data", "home"));

			const customPaths = resolvePortablePaths(exePath, {
				PI_PORTABLE_ROOT: tempDir,
				PI_WEB_DATA_DIR: join(tempDir, "custom-web"),
				PI_CODING_AGENT_DIR: join(tempDir, "custom-agent"),
				NPM_CONFIG_PREFIX: join(tempDir, "custom-npm-global"),
				NPM_CONFIG_CACHE: join(tempDir, "custom-npm-cache"),
			});
			expect(customPaths!.webDataDir).toBe(join(tempDir, "custom-web"));
			expect(customPaths!.agentDir).toBe(join(tempDir, "custom-agent"));
			expect(customPaths!.npmGlobalDir).toBe(join(tempDir, "custom-npm-global"));
			expect(customPaths!.npmCacheDir).toBe(join(tempDir, "custom-npm-cache"));
		});
	});

	describe("applyPortableEnvironment", () => {
		it("创建必要目录、注入环境变量并调用 app.setPath", () => {
			const setPaths: Record<string, string> = {};
			const mockApp = {
				setPath(name: string, path: string) {
					setPaths[name] = path;
				},
			};

			const gitDir = join(tempDir, "runtime", "git");
			mkdirSync(join(gitDir, "cmd"), { recursive: true });
			mkdirSync(join(gitDir, "usr", "bin"), { recursive: true });
			writeFileSync(join(gitDir, "cmd", "git.exe"), "");
			writeFileSync(join(gitDir, "usr", "bin", "bash.exe"), "");

			const nodeDir = join(tempDir, "runtime", "node");
			mkdirSync(nodeDir, { recursive: true });
			writeFileSync(join(nodeDir, "node.exe"), "");

			const paths: PortablePaths = {
				isPortable: true,
				portableRoot: tempDir,
				dataRoot: join(tempDir, "data"),
				electronDataDir: join(tempDir, "data", "electron"),
				webDataDir: join(tempDir, "data", "web"),
				agentDir: join(tempDir, "data", "agent"),
				workspaceDir: join(tempDir, "data", "workspace"),
				gitDir,
				nodeDir,
				npmGlobalDir: join(tempDir, "data", "npm-global"),
				npmCacheDir: join(tempDir, "data", "npm-cache"),
				gitConfigGlobal: join(tempDir, "data", "git", ".gitconfig"),
				userHome: join(tempDir, "data", "home"),
			};

			const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
			applyPortableEnvironment(paths, env, mockApp);

			expect(setPaths.userData).toBe(join(tempDir, "data", "electron"));
			expect(setPaths.sessionData).toBe(join(tempDir, "data", "electron", "session"));
			expect(setPaths.home).toBe(join(tempDir, "data", "home"));
			expect(setPaths.desktop).toBe(join(tempDir, "data", "home", "Desktop"));
			expect(setPaths.documents).toBe(join(tempDir, "data", "home", "Documents"));
			expect(setPaths.downloads).toBe(join(tempDir, "data", "home", "Downloads"));

			expect(env.PI_PORTABLE).toBe("1");
			expect(env.PI_PORTABLE_ROOT).toBe(tempDir);
			expect(env.PI_WEB_DATA_DIR).toBe(join(tempDir, "data", "web"));
			expect(env.PI_CODING_AGENT_DIR).toBe(join(tempDir, "data", "agent"));
			expect(env.PI_WEB_CWD).toBe(join(tempDir, "data", "workspace"));
			expect(env.GIT_CONFIG_GLOBAL).toBe(join(tempDir, "data", "git", ".gitconfig"));
			expect(env.HOME).toBe(join(tempDir, "data", "home"));
			expect(env.USERPROFILE).toBe(join(tempDir, "data", "home"));

			expect(env.SHELL).toBe(join(gitDir, "usr", "bin", "bash.exe"));
			expect(env.PI_WEB_SHELL).toBe(join(gitDir, "usr", "bin", "bash.exe"));
			expect(env.PATH).toContain(join(gitDir, "cmd"));
			expect(env.PATH).toContain(join(gitDir, "usr", "bin"));

			expect(env.NPM_CONFIG_PREFIX).toBe(join(tempDir, "data", "npm-global"));
			expect(env.NPM_CONFIG_CACHE).toBe(join(tempDir, "data", "npm-cache"));
			expect(env.PATH).toContain(join(tempDir, "data", "npm-global"));
			expect(env.PATH).toContain(nodeDir);
			const npmGlobalIdx = env.PATH!.indexOf(join(tempDir, "data", "npm-global"));
			const nodeIdx = env.PATH!.indexOf(nodeDir);
			expect(npmGlobalIdx).toBeLessThan(nodeIdx);
		});

		it("重定向的 HOME 里建出标准外壳目录（桌面/文档/下载…），否则系统选文件对话框报「位置不可用」", () => {
			const paths = resolvePortablePaths(join(tempDir, "app", "pi.exe"), { PI_PORTABLE_ROOT: tempDir })!;
			applyPortableEnvironment(paths, {}, { setPath() {} });
			for (const name of ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]) {
				expect(existsSync(join(paths.userHome, name)), name).toBe(true);
			}
		});
	});
});
