import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
	join(
		homedir(),
		"AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
	),
	join(
		homedir(),
		"Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell",
	),
	join(homedir(), "Library/Caches/ms-playwright/chrome-headless-shell-1228/chrome-headless-shell"),
	join(
		homedir(),
		".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell",
	),
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium-browser",
	"/usr/bin/chromium",
];

export const CHROME_PATH = process.env.PI_WEB_CHROME ?? CANDIDATES.find((p) => existsSync(p)) ?? "";

/**
 * 浏览器型用例的预算：真起 Chrome + 真实导航，成本在进程冷启动与 fsync，不在断言。
 *
 * 写死 20s 在 CI 上会假红：4 vCPU runner 上 4 个 fork 同时冷启浏览器，实测
 * `preview-security` 卡到 20.0s 整（PR #875 分片后 shard 2 的那条红）。与
 * `vitest.config.ts` 的 `testTimeout` 对齐到 60s —— 这里只管「不要无限等」，
 * 真正的硬底是 CI job 的 `timeout-minutes` 与 `scripts/safe-exec.mjs`。
 */
export const BROWSER_TEST_TIMEOUT_MS = 60_000;

/**
 * 起浏览器本身的预算：`chromium.launch({ timeout })` 管的是「Chrome 进程起不来之前等多久」。
 * Playwright 默认 30s，但仓里有两处写死 15s —— 4 vCPU runner 上冷启（外加同片另外几个
 * fork 也在启浏览器）实测会撞线（PR #876 的 device-center-desktop 用例就是这么红的）。
 */
export const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
