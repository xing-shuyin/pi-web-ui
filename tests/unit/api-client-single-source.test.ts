/**
 * 前端 HTTP 单源守卫（细则见 `docs/architecture-ui.md`「HTTP 请求」与 `web/src/api-client.ts` 头注释）。
 *
 * 判据三条：
 *   1. `web/src/api-client.ts` 是唯一知道「URL 怎么拼（appUrl + 口令）」与「失败回执怎么读」的模块。
 *   2. 其它模块不许再手搓「先 `json().catch()`、再自己拼错误文案」这套失败解读——
 *      一旦各处自写，同一种失败就会在不同面板显示成 `500` / `HTTP 500` / `Request failed (500)`。
 *   3. 直接 `fetch(withToken(appUrl(...)))` 的存量只许变短（下面这份名单），新增要走 `apiFetch`。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 仍然直接发请求的文件（二进制 / EventSource / 媒体等非 JSON 场景）。只许删，不许加。 */
const RAW_FETCH_ALLOWLIST = new Set([
	"web/src/components/BrandDeviceMenu.tsx",
	"web/src/components/DesktopDevicePicker.tsx",
	"web/src/components/DeviceCenter.tsx",
	"web/src/components/DeviceDirectory.tsx",
	"web/src/components/DeviceGroupMembers.tsx",
	"web/src/components/GroupBotPresets.tsx",
	"web/src/components/GroupCanvasBinding.tsx",
	"web/src/components/GroupDesktopPreview.tsx",
	"web/src/components/GroupRouterSettings.tsx",
	"web/src/components/GroupWorkItems.tsx",
	"web/src/components/LocalBots.tsx",
	"web/src/components/LocaleModal.tsx",
	"web/src/device-access.ts",
	"web/src/i18n.tsx",
	"web/src/theme.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) walk(path, out);
		else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
	}
	return out;
}

const sources = walk("web/src");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("前端 HTTP 单源", () => {
	it("api-client.ts 自带 URL 拼接与失败解读", () => {
		const client = read("web/src/api-client.ts");
		expect(client).toContain('from "./auth-token"');
		expect(client).toContain('from "./base-url"');
		for (const name of ["export function apiUrl", "export function apiFetch", "export async function requestJson"]) {
			expect(client, name).toContain(name);
		}
	});

	it("只有 api-client.ts 手写失败回执解读", () => {
		const offenders = sources.filter(
			(path) => path !== "web/src/api-client.ts" && /json\(\)\.catch\(\s*\(\)\s*=>/.test(read(path)),
		);
		expect(offenders).toEqual([]);
	});

	it("直接 fetch(withToken(...)) 的存量只许变短", () => {
		const raw = sources
			.filter((path) => path !== "web/src/api-client.ts" && /fetch\(\s*\n?\s*withToken\(/.test(read(path)))
			.map((path) => path.replace(/\\/g, "/"))
			.sort();
		const unexpected = raw.filter((path) => !RAW_FETCH_ALLOWLIST.has(path));
		expect(unexpected).toEqual([]);
	});
});
