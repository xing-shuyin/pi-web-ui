import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as claude from "../../plugins/quota-watch/providers/claude.mjs";
import * as codex from "../../plugins/quota-watch/providers/codex.mjs";
import * as deepseek from "../../plugins/quota-watch/providers/deepseek.mjs";
import * as opencode from "../../plugins/quota-watch/providers/opencode.mjs";
import {
	formatBadge,
	formatHint,
	providerFromModel,
	resolveActiveProvider,
	tightestWindow,
} from "../../plugins/quota-watch/badge.mjs";
import { isNetworkError, needsReauth } from "../../plugins/quota-watch/providers/util.mjs";
import { collectActive, toText } from "../../plugins/quota-watch/providers/index.mjs";
import plugin from "../../plugins/quota-watch/index.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "quota-watch");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

const homes: string[] = [];
afterEach(() => {
	while (homes.length) {
		const dir = homes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "quota-watch-test-"));
	homes.push(dir);
	return dir;
}

function writeJson(file: string, value: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value), "utf8");
}

type Route = (init: any) => unknown;

/** 假宿主：按 URL 片段路由的 fetch，记录每次请求。 */
function fakeHost(routes: Record<string, Route>, secrets: Record<string, string> = {}) {
	const calls: Array<{ url: string; init: any }> = [];
	const host = {
		net: {
			fetch: vi.fn(async (url: string, init: any) => {
				calls.push({ url, init });
				const key = Object.keys(routes).find((fragment) => url.includes(fragment));
				if (!key) return { ok: false, status: 404, text: "not found" };
				const value = routes[key](init);
				if (value instanceof Error) throw value;
				return { ok: true, status: 200, text: JSON.stringify(value) };
			}),
		},
		secrets: { get: (key: string) => secrets[key] },
		log: vi.fn(),
		getSettings: () => ({}),
	} as any;
	return { host, calls };
}

describe("quota-watch manifest", () => {
	it("没有视图页，只靠底栏内置槽 + 跟随小弹窗，声明 net 白名单与设置", () => {
		expect(manifest.id).toBe("quota-watch");
		expect(manifest.apiVersion).toBe(2);
		// 不再有 ui.modal / 顶栏视图 tab：全部 UI 就是一个贴着底栏的小卡片
		expect(manifest.view).toBe(false);
		expect(manifest.ui).toBeUndefined();
		// view:false 也需要客户端 bundle：preload 是它被加载的唯一理由
		expect(manifest.preload).toBe(true);
		for (const need of ["ui", "http", "net"]) expect(manifest.permissions).toContain(need);
		for (const hostname of ["api.anthropic.com", "chatgpt.com", "api.deepseek.com"]) {
			expect(manifest.netAllowlist).toContain(hostname);
		}
		expect(manifest.settings.map((s: { key: string }) => s.key)).toEqual([
			"claudeEnabled",
			"codexEnabled",
			"deepseekEnabled",
			"deepseekKey",
			"opencodeEnabled",
			"opencodeKey",
			"refreshMinutes",
		]);
		// 只查当前供应商 → 不再提供「全部来源并排」这类模式开关
		expect(manifest.settings.some((s: { key: string }) => s.key === "badgeMode")).toBe(false);
	});
});

describe("claude provider", () => {
	it("解析 5 小时 / 每周窗口的 utilization", async () => {
		const home = makeHome();
		writeJson(join(home, ".claude", ".credentials.json"), {
			claudeAiOauth: {
				accessToken: "sk-ant-oat01-token",
				refreshToken: "sk-ant-ort01-token",
				expiresAt: Date.now() + 3_600_000,
				subscriptionType: "max",
			},
		});
		const { host, calls } = fakeHost({
			"api.anthropic.com/api/oauth/usage": () => ({
				five_hour: { utilization: 42, resets_at: "2099-01-01T01:00:00Z" },
				seven_day: { utilization: 12.5, resets_at: "2099-01-05T00:00:00Z" },
			}),
		});

		const result = await claude.collect({ host, home });
		expect(result.status).toBe("ok");
		expect(result.plan).toBe("max");
		expect(result.windows.map((w: any) => w.remainingPercent)).toEqual([58, 87.5]);
		expect(calls[0].init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
	});

	it("access token 过期时按官方 CLI 的形状续期（form-urlencoded + platform 主域名）", async () => {
		const home = makeHome();
		writeJson(join(home, ".claude", ".credentials.json"), {
			claudeAiOauth: {
				accessToken: "stale",
				refreshToken: "refresh-1",
				expiresAt: Date.now() - 60_000,
				subscriptionType: "max",
			},
		});
		const { host, calls } = fakeHost({
			"platform.claude.com/v1/oauth/token": () => ({ access_token: "fresh", expires_in: 3600 }),
			"api.anthropic.com/api/oauth/usage": () => ({ five_hour: { utilization: 5 } }),
		});

		const result = await claude.collect({ host, home });
		expect(result.status).toBe("ok");
		const refresh = calls[0];
		expect(refresh.url).toContain("platform.claude.com/v1/oauth/token");
		expect(refresh.init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
		const body = new URLSearchParams(refresh.init.body);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
		expect(body.get("client_secret")).toBeNull();
		expect(calls[1].init.headers.authorization).toBe("Bearer fresh");
	});

	it("没有凭据文件时回到 signed-out", async () => {
		const home = makeHome();
		const { host } = fakeHost({});
		expect((await claude.collect({ host, home })).status).toBe("signed-out");
	});
});

describe("codex provider", () => {
	it("解析 rate_limit 的两个窗口并按窗口秒数命名", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), {
			tokens: { access_token: "codex-access", account_id: "acct-1" },
		});
		const { host, calls } = fakeHost({
			"/backend-api/wham/usage": () => ({
				plan_type: "pro",
				rate_limit: {
					primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 4_000_000_000 },
					secondary_window: { used_percent: 80, limit_window_seconds: 604_800, reset_at: 4_000_100_000 },
				},
				credits: { has_credits: true, balance: "12.50" },
			}),
		});

		const result = await codex.collect({ host, home });
		expect(result.status).toBe("ok");
		expect(result.plan).toBe("pro");
		expect(result.windows[0].label).toBe("5 小时窗口");
		expect(result.windows[0].remainingPercent).toBe(70);
		expect(result.windows[1].label).toBe("每周窗口");
		expect(result.windows[1].remainingPercent).toBe(20);
		expect(result.extra[0].value).toBe("12.50");
		expect(calls[0].init.headers["chatgpt-account-id"]).toBe("acct-1");
	});

	it("401 时用 refresh_token 续期后重试一次", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), {
			tokens: { access_token: "stale", refresh_token: "refresh-1", account_id: "acct-1" },
		});
		let usageHits = 0;
		const { host, calls } = fakeHost({
			"auth.openai.com/oauth/token": () => ({ access_token: "fresh", expires_in: 3600 }),
			"/backend-api/wham/usage": () => {
				usageHits += 1;
				if (usageHits === 1) {
					const err: any = new Error("unauthorized");
					err.status = 401;
					throw err;
				}
				return { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } };
			},
		});

		const result = await codex.collect({ host, home });
		expect(result.status).toBe("ok");
		expect(result.windows[0].remainingPercent).toBe(90);
		expect(calls.some((call) => call.url.includes("auth.openai.com"))).toBe(true);
	});
});

describe("deepseek provider", () => {
	it("没有 key 时 signed-out，有 key 时解析余额", async () => {
		const home = makeHome();
		const empty = fakeHost({});
		expect((await deepseek.collect({ host: empty.host, apiKey: "" })).status).toBe("signed-out");

		const { host, calls } = fakeHost({
			"api.deepseek.com/user/balance": () => ({
				is_available: true,
				balance_infos: [
					{ currency: "CNY", total_balance: "95.50", granted_balance: "5.50", topped_up_balance: "100.00" },
				],
			}),
		});
		const result = await deepseek.collect({ host, apiKey: "sk-deepseek" });
		expect(result.status).toBe("ok");
		expect(result.balance).toMatchObject({ amount: 95.5, currency: "CNY", text: "¥95.50" });
		expect(result.windows).toEqual([]);
		expect(result.extra.map((item: any) => item.value)).toEqual(["¥5.50", "¥100.00"]);
		expect(calls[0].init.headers.authorization).toBe("Bearer sk-deepseek");
	});
});

describe("opencode provider", () => {
	it("go/status 的三档用量计换算成剩余百分比 + 重置时间", async () => {
		const home = makeHome();
		writeJson(join(home, ".pi", "agent", "provider-keys.json"), {
			"opencode-go": { activeKeyName: "pi", keys: [{ name: "pi", apiKey: "oc_sk_test" }] },
		});
		writeJson(join(home, ".local", "share", "opencode", "auth.json"), {
			"opencode-go": { type: "api", key: "sk-local" },
		});
		const { host } = fakeHost({
			"opencode.ai/console/api/go/status": () => ({
				product: "go",
				access: {
					endsAt: "2026-12-02T09:23:11.000Z",
					meters: {
						fiveHour: {
							startsAt: "2026-11-09T06:45:28.000Z",
							resetsAt: "2026-11-09T11:45:28.000Z",
							limitMicroCents: "1200000000",
							usedMicroCents: "10122818",
						},
						week: {
							startsAt: "2026-11-09T00:00:00.000Z",
							resetsAt: "2026-11-16T00:00:00.000Z",
							limitMicroCents: "3000000000",
							usedMicroCents: "10122818",
						},
						month: {
							resetsAt: "2026-12-02T09:23:11.000Z",
							limitMicroCents: "6000000000",
							usedMicroCents: "71660699",
						},
					},
				},
			}),
		});
		const result = await opencode.collect({ host, settings: {}, home });
		expect(result.status).toBe("ok");
		expect(result.plan).toContain("Go");
		expect(result.windows.map((w: any) => w.id)).toEqual(["five-hour", "weekly", "monthly"]);
		// 1 - 10122818/1200000000 ≈ 99.16%，1 - 71660699/6000000000 ≈ 98.81%
		expect(result.windows[0].remainingPercent).toBeCloseTo(99.16, 1);
		expect(result.windows[2].remainingPercent).toBeCloseTo(98.81, 1);
		expect(result.windows[0].resetAt).toBe("2026-11-09T11:45:28.000Z");
		// 本机登录态列表照样附上
		expect(result.extra.map((e: any) => e.label)).toContain("opencode-go");
	});

	it("没有 Key 也没有本机登录态时 signed-out，有登录态无 Key 时只读本地", async () => {
		const bare = makeHome();
		const { host } = fakeHost({});
		expect((await opencode.collect({ host, settings: {}, home: bare })).status).toBe("signed-out");

		const home = makeHome();
		writeJson(join(home, ".local", "share", "opencode", "auth.json"), {
			"opencode-go": { type: "api", key: "sk-local" },
		});
		const { host: host2 } = fakeHost({});
		const local = await opencode.collect({ host: host2, settings: {}, home });
		expect(local.status).toBe("ok");
		expect(local.windows).toEqual([]);
		expect(local.extra.length).toBe(1);
	});
});

describe("登录态失效判定（用厂商错误码当证据）", () => {
	it("认得 invalid_grant / token_expired / invalid_client / 401，不把网络错误当过期", () => {
		expect(
			needsReauth(
				Object.assign(new Error("Refresh token not found or invalid"), { status: 400, code: "invalid_grant" }),
			),
		).toBe(true);
		expect(
			needsReauth(Object.assign(new Error("Could not validate your token"), { status: 401, code: "token_expired" })),
		).toBe(true);
		expect(
			needsReauth(Object.assign(new Error("Invalid client specified."), { status: 401, code: "invalid_client" })),
		).toBe(true);
		expect(needsReauth(Object.assign(new Error("OAuth access token is invalid."), { status: 401 }))).toBe(true);
		expect(needsReauth(Object.assign(new Error("请求超时：api.anthropic.com"), {}))).toBe(false);
		expect(needsReauth(Object.assign(new Error("HTTP 502"), { status: 502 }))).toBe(false);
	});
});

describe("网络失败 ≠ 登录失效", () => {
	it("isNetworkError 认 DNS/TLS/超时，不抢 invalid_grant 的判定", () => {
		expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
		expect(isNetworkError(new Error("请求超时：api.anthropic.com"))).toBe(true);
		const tls = new TypeError("fetch failed");
		tls.cause = { message: "Client network socket disconnected before secure TLS connection was established" };
		expect(isNetworkError(tls)).toBe(true);
		expect(
			isNetworkError(Object.assign(new Error("Refresh token not found or invalid"), { code: "invalid_grant" })),
		).toBe(false);
		expect(isNetworkError(Object.assign(new Error("OAuth access token is invalid."), { status: 401 }))).toBe(false);
	});

	it("网络挂了时 Claude 归为 network 并提示开代理（不是让你重新登录）", async () => {
		const home = makeHome();
		writeJson(join(home, ".claude", ".credentials.json"), {
			claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
		});
		const { host } = fakeHost({
			"api.anthropic.com/api/oauth/usage": () => new TypeError("fetch failed"),
		});
		const result = await claude.collect({ host, home });
		expect(result.status).toBe("network");
		expect(result.hint).toContain("代理");
	});

	it("网络不可达在徽标里是 ⇅", () => {
		// collectActive() 只会给出当前供应商这一条，所以徽标也只讲它
		const snap = { providers: [{ id: "codex", name: "CX", status: "network", windows: [] }] };
		expect(formatBadge(snap, "codex", true)).toEqual({ label: "CX", badge: "⇅" });
		expect(formatHint(snap, "codex", true)).toContain("网络不可达");
	});
});

describe("凭据位置兼容", () => {
	it("Claude 支持 CLAUDE_CONFIG_DIR 与 CLAUDE_CODE_OAUTH_TOKEN", async () => {
		const home = makeHome();
		const cfgDir = join(home, "claude-cfg");
		writeJson(join(cfgDir, ".credentials.json"), {
			claudeAiOauth: {
				accessToken: "tok-cfg",
				refreshToken: "r",
				expiresAt: Date.now() + 3_600_000,
				rateLimitTier: "default_max",
			},
		});
		const { host, calls } = fakeHost({
			"api.anthropic.com/api/oauth/usage": () => ({ five_hour: { utilization: 1 } }),
		});
		process.env.CLAUDE_CONFIG_DIR = cfgDir;
		try {
			const result = await claude.collect({ host, home });
			expect(result.status).toBe("ok");
			expect(result.plan).toBe("default_max");
			expect(calls[0].init.headers.authorization).toBe("Bearer tok-cfg");
		} finally {
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	it("Codex 支持 CODEX_HOME，且纯 API Key 账号说明没有订阅窗口", async () => {
		const home = makeHome();
		const codexHome = join(home, "codex-home");
		writeJson(join(codexHome, "auth.json"), { OPENAI_API_KEY: "sk-openai" });
		process.env.CODEX_HOME = codexHome;
		const { host, calls } = fakeHost({});
		try {
			const result = await codex.collect({ host, home });
			expect(result.status).toBe("empty");
			expect(result.hint).toContain("API Key");
			expect(calls).toHaveLength(0);
		} finally {
			delete process.env.CODEX_HOME;
		}
	});

	it("Codex 的模型专属限额（additional_rate_limits）也上一张进度条", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), { tokens: { access_token: "a" } });
		const { host } = fakeHost({
			"/backend-api/wham/usage": () => ({
				plan_type: "pro",
				rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
				additional_rate_limits: [
					{
						limit_name: "GPT-5.3-Codex-Spark",
						rate_limit: { secondary_window: { used_percent: 75, limit_window_seconds: 604_800 } },
					},
				],
			}),
		});
		const result = await codex.collect({ host, home });
		expect(result.windows).toHaveLength(2);
		expect(result.windows[1].label).toBe("GPT-5.3-Codex-Spark · 每周窗口");
		expect(result.windows[1].remainingPercent).toBe(25);
	});

	it("Codex 换了外层字段名也能扫出窗口（结构漂移兜底）", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), { tokens: { access_token: "a" } });
		const { host } = fakeHost({
			"/backend-api/wham/usage": () => ({
				limits: { weekly_window: { used_percent: 40, limit_window_seconds: 604_800 } },
			}),
		});
		const result = await codex.collect({ host, home });
		expect(result.windows).toHaveLength(1);
		expect(result.windows[0].label).toBe("每周窗口");
		expect(result.windows[0].remainingPercent).toBe(60);
	});

	it("Codex 的历史 window_minutes 字段也能算出 5 小时窗口", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), { tokens: { access_token: "a", account_id: "acct" } });
		const { host } = fakeHost({
			"/backend-api/wham/usage": () => ({ rate_limit: { primary_window: { used_percent: 5, window_minutes: 300 } } }),
		});
		const result = await codex.collect({ host, home });
		expect(result.windows[0].label).toBe("5 小时窗口");
	});
});

describe("/summary 给底栏的内置槽载荷", () => {
	it("footer.text 与 badge 同源，footer.tip 是完整 tooltip", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), { tokens: { access_token: "a" } });
		const { host } = fakeHost({
			"/backend-api/wham/usage": () => ({
				rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
			}),
		});
		const snapshot = await collectActive({ host, settings: {}, home, id: "codex" });
		const activeId = resolveActiveProvider("codex-mini-latest", snapshot);
		const parts = formatBadge(snapshot, activeId, true);
		const tip = formatHint(snapshot, activeId, true);
		// 服务端拼的就是这一行（index.mjs 的 footerPayload 与它同构）
		expect(`${parts.label} ${parts.badge}`.trim()).toBe("CX 75%");
		expect(tip.split(String.fromCharCode(10))[0]).toContain("当前供应商：Codex");
	});
});

describe("底栏徽标与当前供应商识别", () => {
	const modelCases: Array<[string, string]> = [
		["auto/deepseek-v4.1-flash", "deepseek"],
		["deepseek/deepseek-chat", "deepseek"],
		["anthropic/claude-sonnet-4", "claude"],
		["auto/claude-opus-4-1", "claude"],
		["openai/gpt-5.1-codex", "codex"],
		// OpenCode：模型名五花八门，只看 `/` 前的供应商段（含 opencode 即命中，与个人配置无关）
		["opencode/kimi-k2.6", "opencode"],
		["opencode-go/kimi-k3", "opencode"],
		["opencode-go/grok-4.7", "opencode"],
		["opencode-go-2/hy3", "opencode"],
		// OpenCode 网关透出的订阅模型名里没有 opencode 字样，兜底识别（见 badge.mjs）
		["Iceman Contributor Free", "opencode"],
		["iceman-contributor-free", "opencode"],
		["my-opencode/some-model", "opencode"],
		["codex-mini-latest", "codex"],
		["auto/o3-mini", "codex"],
		["magpie/qwen3-coder", ""],
		["", ""],
	];

	it.each(modelCases)("模型 %s → 供应商 %s", (model, expected) => {
		expect(providerFromModel(model)).toBe(expected);
	});

	// collectActive() 只返回当前供应商那一条，所以夹具也按「一条」来摆
	const providers: Record<string, any> = {
		claude: { id: "claude", name: "Claude Code", status: "signed-out", windows: [] },
		codex: {
			id: "codex",
			name: "Codex",
			status: "ok",
			windows: [{ label: "5 小时窗口", labelEn: "5h", remainingPercent: 12.34, resetAt: "" }],
		},
		deepseek: {
			id: "deepseek",
			name: "DeepSeek",
			status: "ok",
			windows: [],
			balance: { amount: 16.82, currency: "CNY", text: "¥16.82" },
		},
	};
	/** 只含当前供应商的快照 */
	const only = (id: string) => ({ providers: [providers[id]] });

	it("徽标只讲当前供应商：百分比 / 余额 / 未登录占位", () => {
		expect(formatBadge(only("codex"), "codex", true)).toEqual({ label: "CX", badge: "12.3%" });
		expect(formatBadge(only("deepseek"), "deepseek", true)).toEqual({ label: "DS", badge: "¥16.82" });
		expect(formatBadge(only("claude"), "claude", true)).toEqual({ label: "CL", badge: "—" });
	});

	it("认不出当前供应商时整段留空（客户端据此清掉底栏槽，不留 `额度 --` 残片）", () => {
		expect(formatBadge({ providers: [] }, "", true)).toEqual({ label: "", badge: "" });
		expect(formatBadge(only("codex"), "", true)).toEqual({ label: "", badge: "" });
		expect(formatBadge(only("codex"), "nope", true)).toEqual({ label: "", badge: "" });
	});

	it("tooltip 只讲当前供应商，不再罗列别家", () => {
		const hint = formatHint(only("codex"), "codex", true);
		const lines = hint.split(String.fromCharCode(10));
		expect(lines[0]).toContain("当前供应商：Codex");
		expect(hint).toContain("5 小时窗口 剩余 12.3%");
		expect(hint).not.toContain("Claude");
		expect(hint).toContain("点击打开额度看板");
	});

	it("余额型供应商的 tooltip 不重复同一条余额", () => {
		const hint = formatHint(only("deepseek"), "deepseek", true);
		expect(hint.match(/¥16\.82/g)).toHaveLength(1);
		expect(hint).toContain("余额 ¥16.82");
	});

	it("没有当前供应商时 tooltip 为空（底栏整段隐藏）", () => {
		expect(formatHint({ providers: [] }, "", true)).toBe("");
	});

	it("快照里只有这家才算识别成功", () => {
		expect(resolveActiveProvider("auto/deepseek-v4.1-flash", only("deepseek"))).toBe("deepseek");
		expect(resolveActiveProvider("auto/deepseek-v4.1-flash", { providers: [{ id: "codex" }] })).toBe("");
		expect(resolveActiveProvider("magpie/qwen3-coder", only("deepseek"))).toBe("");
	});

	it("tightestWindow 忽略没有数字的窗口", () => {
		const tightest = tightestWindow({
			windows: [{ remainingPercent: null }, { remainingPercent: 40 }, { remainingPercent: 5 }],
		});
		expect(tightest?.remaining).toBe(5);
		expect(tightestWindow({ windows: [] })).toBeNull();
	});
});

describe("collectActive 只查当前供应商", () => {
	it("当前是 Codex 时，即使本机也登录了别家，也只打 Codex 的接口", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), { tokens: { access_token: "codex-access" } });
		const { host, calls } = fakeHost({
			retrieveUserQuotaSummary: () => ({ groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.9 }] }] }),
			loadCodeAssist: () => ({ currentTier: { name: "Free" } }),
			"/backend-api/wham/usage": () => ({
				rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
			}),
		});

		const snapshot = await collectActive({ host, settings: {}, home, id: "codex" });
		expect(snapshot.providers).toHaveLength(1);
		expect(snapshot.providers[0].id).toBe("codex");
		expect(snapshot.providers[0].windows[0].remainingPercent).toBe(75);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((call) => call.url.includes("chatgpt.com"))).toBe(true);
	});

	it("认不出当前供应商 / 该来源被关掉时：一张卡都不给，也不出网", async () => {
		const home = makeHome();
		const { host, calls } = fakeHost({});

		expect((await collectActive({ host, settings: {}, home, id: "" })).providers).toEqual([]);
		expect((await collectActive({ host, settings: {}, home, id: "magpie" })).providers).toEqual([]);
		expect(
			(await collectActive({ host, settings: { deepseekEnabled: false }, home, id: "deepseek" })).providers,
		).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("当前供应商查询失败时仍给一条错误卡（底栏要能显示 ⇅ / !）", async () => {
		const home = makeHome();
		writeJson(join(home, ".codex", "auth.json"), { tokens: { access_token: "codex-access" } });
		// 两个用量地址都挂掉（codex 会在 404 后换第二个地址再试一次）
		const { host } = fakeHost({
			"chatgpt.com/backend-api": () => {
				throw new TypeError("fetch failed");
			},
		});
		const snapshot = await collectActive({ host, settings: {}, home, id: "codex" });
		expect(snapshot.providers).toHaveLength(1);
		expect(snapshot.providers[0].status).toBe("network");
		expect(snapshot.providers[0].hint).toContain("网络不可达");
	});

	it("本机 pi 已存的 DeepSeek 凭据能自动兜底（无需用户再填 Key）", async () => {
		const home = makeHome();
		writeJson(join(home, ".pi", "agent", "auth.json"), { deepseek: { type: "api_key", key: "sk-from-auth" } });
		writeJson(join(home, ".pi", "agent", "provider-keys.json"), {
			deepseek: { activeKeyName: "pi", keys: [{ name: "pi", apiKey: "sk-from-provider-keys" }] },
		});
		const { host, calls } = fakeHost({
			"api.deepseek.com/user/balance": () => ({
				is_available: true,
				balance_infos: [{ currency: "USD", total_balance: "3.00", granted_balance: "0.00", topped_up_balance: "3.00" }],
			}),
		});
		const snapshot = await collectActive({ host, settings: {}, home, id: "deepseek" });
		const ds = snapshot.providers[0];
		expect(ds.status).toBe("ok");
		expect(ds.balance.text).toBe("$3.00");
		expect(calls[0].init.headers.authorization).toBe("Bearer sk-from-auth");
	});

	it("toText 给 AI 的摘要只讲当前供应商", async () => {
		const home = makeHome();
		const { host } = fakeHost({});
		const text = toText(await collectActive({ host, settings: {}, home, id: "claude" }));
		expect(text).toContain("未登录");
		expect(toText(await collectActive({ host, settings: {}, home, id: "" }))).toContain("只查当前供应商");
	});
});

/** 插件入口用的假宿主：在 provider 级假 fetch 之上补齐 route / 事件 / 工具注册。 */
function fakePluginHost(routes: Record<string, Route>, model = "") {
	const { host, calls } = fakeHost(routes);
	let summaryHandler: any = null;
	let emitModel: (snap: any) => void = () => {};
	Object.assign(host, {
		getActiveConversation: () => ({ model }),
		onClientModelChanged: (fn: (snap: any) => void) => {
			emitModel = fn;
			return () => {};
		},
		onConversationChanged: () => () => {},
		onSettingsChanged: () => () => {},
		schedule: () => () => {},
		registerAgentTool: (tool: any) => {
			host.agentTool = tool;
			return () => {};
		},
		route: (_method: string, _path: string, fn: any) => {
			summaryHandler = fn;
			return () => {};
		},
	});
	/** 打一次 GET /summary，返回服务端拼好的载荷 */
	const summary = (query: any = {}): Promise<any> =>
		new Promise((resolve) => {
			const res = {
				status: () => res,
				json: (payload: any) => resolve(payload),
			};
			summaryHandler(query, res);
		});
	/** 模拟宿主广播「模型变了」 */
	const changeModel = (next: string) => {
		emitModel({ model: next });
		return new Promise((resolve) => setTimeout(resolve, 30));
	};
	return { host, calls, summary, changeModel };
}

describe("plugin 入口：底栏只按当前供应商出网", () => {
	const env = { ...process.env };
	afterEach(() => {
		for (const key of ["DEEPSEEK_API_KEY", "CODEX_HOME"]) {
			const value = env[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("当前是 DeepSeek：即使本机也登录了 Codex，也只打 DeepSeek 余额接口", async () => {
		process.env.DEEPSEEK_API_KEY = "sk-test";
		const { host, calls, summary } = fakePluginHost(
			{
				"api.deepseek.com/user/balance": () => ({
					is_available: true,
					balance_infos: [{ currency: "CNY", total_balance: "14.46" }],
				}),
				"chatgpt.com/backend-api": () => ({ rate_limit: { primary_window: { used_percent: 10 } } }),
			},
			"deepseek/deepseek-chat",
		);
		const dispose = plugin.activate(host);
		try {
			const body = await summary();
			expect(body.activeProvider).toBe("deepseek");
			expect(body.providers.map((p: any) => p.id)).toEqual(["deepseek"]);
			expect(body.footer.text).toBe("DS ¥14.46");
			expect(calls.every((call) => call.url.includes("api.deepseek.com"))).toBe(true);
		} finally {
			dispose();
		}
	});

	it("换模型后按新供应商重取，不拿上一家的数字", async () => {
		process.env.DEEPSEEK_API_KEY = "sk-test";
		const home = makeHome();
		const codexHome = join(home, "codex-home");
		writeJson(join(codexHome, "auth.json"), { tokens: { access_token: "codex-access" } });
		process.env.CODEX_HOME = codexHome;
		const { host, summary, changeModel } = fakePluginHost(
			{
				"api.deepseek.com/user/balance": () => ({
					is_available: true,
					balance_infos: [{ currency: "CNY", total_balance: "14.46" }],
				}),
				"chatgpt.com/backend-api": () => ({
					rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
				}),
			},
			"deepseek/deepseek-chat",
		);
		const dispose = plugin.activate(host);
		try {
			expect((await summary()).footer.text).toBe("DS ¥14.46");
			await changeModel("openai/gpt-5.1-codex");
			const after = await summary();
			expect(after.activeProvider).toBe("codex");
			expect(after.providers.map((p: any) => p.id)).toEqual(["codex"]);
			expect(after.footer.text).toBe("CX 75%");
		} finally {
			dispose();
		}
	});

	it("认不出当前模型时不出网，底栏文本为空（客户端据此隐藏整段）", async () => {
		const { host, calls, summary } = fakePluginHost({}, "magpie/qwen3-coder");
		const dispose = plugin.activate(host);
		try {
			const body = await summary();
			expect(body.providers).toEqual([]);
			expect(body.footer.text).toBe("");
			expect(calls).toHaveLength(0);
		} finally {
			dispose();
		}
	});
});

describe("刷新链路：TTL 分档与「上次成功」兜底", () => {
	const env = { ...process.env };
	afterEach(() => {
		const value = env.DEEPSEEK_API_KEY;
		if (value === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = value;
	});

	it("余额型来源 60 秒 TTL —— 余额每花一次就变，5 分钟太钝", async () => {
		process.env.DEEPSEEK_API_KEY = "sk-test";
		const { host, summary } = fakePluginHost(
			{
				"api.deepseek.com/user/balance": () => ({
					is_available: true,
					balance_infos: [{ currency: "CNY", total_balance: "14.46" }],
				}),
			},
			"deepseek/deepseek-chat",
		);
		const dispose = plugin.activate(host);
		try {
			const body = await summary();
			expect(body.ttlMs).toBe(60_000);
			expect(body.refreshSeconds).toBe(60);
			expect(body.staleMs).toBeGreaterThanOrEqual(0);
		} finally {
			dispose();
		}
	});

	it("订阅型仍按设置里的分钟数（默认 5 分钟），不跟着余额一起加速", async () => {
		const home = makeHome();
		const codexHome = join(home, "codex-home");
		writeJson(join(codexHome, "auth.json"), { tokens: { access_token: "codex-access" } });
		const savedHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = codexHome;
		const { host, summary } = fakePluginHost(
			{
				"chatgpt.com/backend-api": () => ({
					rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } },
				}),
			},
			"openai/gpt-5.1-codex",
		);
		const dispose = plugin.activate(host);
		try {
			const body = await summary();
			expect(body.ttlMs).toBe(5 * 60_000);
			expect(body.refreshSeconds).toBe(300);
		} finally {
			dispose();
			if (savedHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = savedHome;
		}
	});

	it("刷新失败时保留上次成功的数字并标成陈旧，但底栏不拿旧数字假装健康", async () => {
		process.env.DEEPSEEK_API_KEY = "sk-test";
		const routes: Record<string, Route> = {
			"api.deepseek.com/user/balance": () => ({
				is_available: true,
				balance_infos: [{ currency: "CNY", total_balance: "14.46" }],
			}),
		};
		const { host, summary } = fakePluginHost(routes, "deepseek/deepseek-chat");
		const dispose = plugin.activate(host);
		try {
			expect((await summary()).footer.text).toBe("DS ¥14.46");

			routes["api.deepseek.com/user/balance"] = () => new Error("厂商接口 500");
			const after = await summary({ query: { force: "1" } });
			const provider = after.providers[0];
			expect(provider.status).toBe("error");
			// 数字没被抹掉，但明确标成「上次成功读到的」
			expect(provider.balance.text).toBe("¥14.46");
			expect(provider.stale).toBe(true);
			expect(after.lastGoodAt).toBeTruthy();
			// 底栏徽标仍是失败态：不伪造一个健康的余额
			expect(after.footer.text).not.toContain("¥14.46");
		} finally {
			dispose();
		}
	});
});
