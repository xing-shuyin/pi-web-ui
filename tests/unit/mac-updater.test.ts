import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildMacQuitInstallScript,
	compareSemver,
	createMacCancelToken,
	createMacSelfUpdaterAdapter,
	escapeShSingleQuoted,
	parseLatestMacYml,
	resolveMacAppBundlePath,
	validateMacSelfUpdateTarget,
} from "../../desktop/mac-updater.js";
import { createUpdaterController } from "../../desktop/updater.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		try {
			chmodSync(dir, 0o755);
		} catch {
			// ignore
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("desktop/mac-updater", () => {
	it("resolveMacAppBundlePath parses .app bundle from execPath", () => {
		expect(resolveMacAppBundlePath("/Applications/keel.app/Contents/MacOS/keel")).toBe("/Applications/keel.app");
		expect(
			resolveMacAppBundlePath("/Applications/My App.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"),
		).toBe("/Applications/My App.app/Contents/Frameworks/Helper.app");
		expect(resolveMacAppBundlePath("/usr/local/bin/node")).toBeNull();
	});

	it("validateMacSelfUpdateTarget rejects AppTranslocation and unwritable dirs", () => {
		expect(() => validateMacSelfUpdateTarget("/private/var/folders/xx/AppTranslocation/abc/d/keel.app")).toThrow(
			/App Translocation/i,
		);

		const dir = makeTempDir("mac-updater-perm-");
		const appDir = join(dir, "keel.app");
		mkdirSync(appDir);
		validateMacSelfUpdateTarget(appDir);

		chmodSync(dir, 0o555);
		try {
			expect(() => validateMacSelfUpdateTarget(appDir)).toThrow(/permission denied/i);
		} finally {
			chmodSync(dir, 0o755);
		}
	});

	it("parseLatestMacYml selects matching arch zip", () => {
		const yml = [
			"version: 0.125.0",
			"files:",
			"  - url: keel-0.125.0-mac.zip",
			"    sha512: x64hash==",
			"    size: 100",
			"  - url: keel-0.125.0-arm64-mac.zip",
			"    sha512: armhash==",
			"    size: 101",
			"  - url: keel-0.125.0-arm64.dmg",
			"    sha512: dmghash==",
		].join("\n");

		const arm = parseLatestMacYml(yml, "arm64");
		expect(arm.version).toBe("0.125.0");
		expect(arm.file.url).toBe("keel-0.125.0-arm64-mac.zip");
		expect(arm.file.sha512).toBe("armhash==");

		const x64 = parseLatestMacYml(yml, "x64");
		expect(x64.file.url).toBe("keel-0.125.0-mac.zip");
		expect(x64.file.sha512).toBe("x64hash==");
	});

	it("compareSemver orders versions accurately", () => {
		expect(compareSemver("0.125.0", "0.123.0")).toBe(1);
		expect(compareSemver("0.123.0", "0.125.0")).toBe(-1);
		expect(compareSemver("0.125.0", "0.125.0")).toBe(0);
		expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
	});

	it("buildMacQuitInstallScript escapes paths and contains rollback logic", () => {
		expect(escapeShSingleQuoted("/tmp/a'b/keel.app")).toBe("/tmp/a'\\''b/keel.app");
		const script = buildMacQuitInstallScript({
			appPath: "/Applications/keel's.app",
			stagedAppPath: "/tmp/staged/keel.app",
			cleanupDir: "/tmp/staged",
			appPid: 4242,
		});
		expect(script).toContain("APP_PID=4242");
		expect(script).toContain("TARGET='/Applications/keel'\\''s.app'");
		expect(script).toContain('mv "$BACKUP" "$TARGET"');
		expect(script).toContain('open -n "$TARGET"');
	});

	it.skipIf(process.platform !== "darwin")(
		"end-to-end check -> download -> sha512 -> ditto extract via local HTTP feed",
		async () => {
			const root = makeTempDir("mac-updater-e2e-");
			const currentApp = join(root, "Applications", "keel.app");
			const currentBin = join(currentApp, "Contents", "MacOS", "keel");
			mkdirSync(join(currentApp, "Contents", "MacOS"), { recursive: true });
			writeFileSync(currentBin, "old-version", "utf8");

			// 构造新版 .app 并用 ditto 打成 zip
			const buildDir = join(root, "build");
			const nextApp = join(buildDir, "keel.app");
			mkdirSync(join(nextApp, "Contents", "MacOS"), { recursive: true });
			writeFileSync(join(nextApp, "Contents", "MacOS", "keel"), "new-version-0.125.0", "utf8");
			writeFileSync(join(nextApp, "Contents", "Info.plist"), "<plist>0.125.0</plist>", "utf8");

			const feedDir = join(root, "feed");
			mkdirSync(feedDir, { recursive: true });
			const zipName = `keel-0.125.0-${process.arch === "arm64" ? "arm64-" : ""}mac.zip`;
			const zipPath = join(feedDir, zipName);
			const dittoRes = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", nextApp, zipPath]);
			expect(dittoRes.status).toBe(0);

			const zipBytes = readFileSync(zipPath);
			const sha512 = createHash("sha512").update(zipBytes).digest("base64");
			const yml = [
				"version: 0.125.0",
				"files:",
				`  - url: ${zipName}`,
				`    sha512: ${sha512}`,
				`    size: ${zipBytes.length}`,
			].join("\n");
			writeFileSync(join(feedDir, "latest-mac.yml"), yml, "utf8");

			const server = createServer((req, res) => {
				if (req.url === "/latest-mac.yml") {
					res.writeHead(200, { "content-type": "text/yaml" });
					res.end(yml);
					return;
				}
				if (req.url === `/${zipName}`) {
					res.writeHead(200, {
						"content-type": "application/zip",
						"content-length": String(zipBytes.length),
					});
					res.end(zipBytes);
					return;
				}
				res.writeHead(404);
				res.end("not found");
			});
			await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
			const port = (server.address() as { port: number }).port;

			try {
				let quitCalled = false;
				const states: string[] = [];
				const adapter = createMacSelfUpdaterAdapter({
					currentVersion: "0.123.0",
					feedBaseUrl: `http://127.0.0.1:${port}`,
					execPath: currentBin,
					quitApp: () => {
						quitCalled = true;
					},
				});
				const controller = createUpdaterController({
					mode: { mode: "auto", reason: "ready" },
					currentVersion: "0.123.0",
					createCancelToken: () => createMacCancelToken().token,
					publish: (s) => states.push(s.phase),
				});
				controller.attach(adapter);

				expect(await controller.check({ manual: true })).toBe(true);
				expect(controller.getState().phase).toBe("available");
				expect(controller.getState().targetVersion).toBe("0.125.0");

				expect(await controller.download()).toBe(true);
				expect(controller.getState().phase).toBe("downloaded");
				expect(controller.getState().percent).toBe(100);
			} finally {
				server.close();
			}
		},
	);

	it.skipIf(process.platform !== "darwin")("swap script replaces .app bundle after pid exits", () => {
		const root = makeTempDir("mac-updater-swap-");
		const targetApp = join(root, "keel.app");
		const stagedDir = join(root, "staged");
		const stagedApp = join(stagedDir, "keel.app");
		mkdirSync(join(targetApp, "Contents", "MacOS"), { recursive: true });
		mkdirSync(join(stagedApp, "Contents", "MacOS"), { recursive: true });
		writeFileSync(join(targetApp, "Contents", "MacOS", "keel"), "old-0.123.0", "utf8");
		writeFileSync(join(stagedApp, "Contents", "MacOS", "keel"), "new-0.125.0", "utf8");

		// 起一个立即退出的短命进程，拿到已退出的 PID
		const sleeper = spawnSync("/bin/sh", ["-c", "exit 0"]);
		expect(sleeper.status).toBe(0);

		const script = buildMacQuitInstallScript({
			appPath: targetApp,
			stagedAppPath: stagedApp,
			cleanupDir: stagedDir,
			appPid: sleeper.pid!,
		}).replace('open -n "$TARGET" || true', "true");

		const scriptPath = join(root, "swap.sh");
		writeFileSync(scriptPath, script, { mode: 0o700 });
		const res = spawnSync("/bin/sh", [scriptPath]);
		expect(res.status).toBe(0);
		expect(readFileSync(join(targetApp, "Contents", "MacOS", "keel"), "utf8")).toBe("new-0.125.0");
		expect(existsSync(stagedDir)).toBe(false);
	});

	it("supports ETag 304 cache and mirror fallback on checkForUpdates", async () => {
		const yml = ["version: 0.126.0", "files:", "  - url: keel-0.126.0-arm64-mac.zip", "    sha512: abc=="].join("\n");
		let hits = 0;
		const server = createServer((req, res) => {
			hits += 1;
			if (req.url !== "/latest-mac.yml") {
				res.writeHead(404);
				res.end();
				return;
			}
			if (req.headers["if-none-match"] === '"etag-v1"') {
				res.writeHead(304);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "text/yaml", etag: '"etag-v1"' });
			res.end(yml);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		try {
			const adapter = createMacSelfUpdaterAdapter({
				currentVersion: "0.125.0",
				feedBaseUrl: `http://127.0.0.1:${port}`,
				arch: "arm64",
				quitApp: () => {},
			});
			const first = (await adapter.checkForUpdates()) as { updateInfo: { version: string } };
			expect(first.updateInfo.version).toBe("0.126.0");
			const second = (await adapter.checkForUpdates()) as { updateInfo: { version: string } };
			expect(second.updateInfo.version).toBe("0.126.0");
			expect(hits).toBe(2);
		} finally {
			server.close();
		}
	});
});
