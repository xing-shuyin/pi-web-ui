import { describe, expect, it } from "vitest";
import type {
	PluginBusEvent,
	PluginModelInfo,
	PluginPermissionFamily,
	PluginStats,
	UiContribution,
} from "../../server/protocol.js";

function clampProgress(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return Math.min(100, Math.max(0, v));
}

function parseVer(v: string): [number, number, number] {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
	if (!m) throw new Error(`bad version: ${v}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVer(a: string, b: string): number {
	const pa = parseVer(a);
	const pb = parseVer(b);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
	}
	return 0;
}

function satisfiesEngines(pkgVersion: string, range: string): boolean {
	const r = range.trim();
	try {
		if (r.startsWith(">=")) return cmpVer(pkgVersion, r.slice(2).trim()) >= 0;
		if (r.startsWith("^")) {
			const base = r.slice(1).trim();
			const pb = parseVer(base);
			const pp = parseVer(pkgVersion);
			return pp[0] === pb[0] && cmpVer(pkgVersion, base) >= 0;
		}
		if (r.startsWith("=")) return cmpVer(pkgVersion, r.slice(1).trim()) === 0;
		return cmpVer(pkgVersion, r) === 0;
	} catch {
		return true;
	}
}

function hostMatches(host: string, pattern: string): boolean {
	if (!pattern) return false;
	return host === pattern || host.endsWith(`.${pattern}`);
}

describe("协议类型冒烟（plugin v2 新增类型）", () => {
	it("PluginBusEvent：topic 必填，from/payload 可选", () => {
		const ev: PluginBusEvent = { topic: "webmail:inbox", from: "webmail", payload: { n: 1 } };
		expect(ev.topic).toBe("webmail:inbox");
		expect(ev.from).toBe("webmail");
		const minimal: PluginBusEvent = { topic: "x:ping" };
		expect(minimal.from).toBeUndefined();
		expect(minimal.payload).toBeUndefined();
	});

	it("PluginModelInfo：{id,provider,vision}", () => {
		const m: PluginModelInfo = { id: "anthropic/claude-sonnet-5", provider: "anthropic", vision: true };
		expect(m.id).toContain("/");
		expect(m.provider).toBe("anthropic");
		expect(m.vision).toBe(true);
	});

	it("PluginStats：完整与最小形状", () => {
		const full: PluginStats = {
			conversationId: "c1",
			tokens: { input: 10, output: 20, total: 30 },
			cost: 0.01,
			contextUsage: { tokens: 100, contextWindow: 200000, percent: 0.05 },
		};
		expect(full.tokens.total).toBe(30);
		expect(full.contextUsage?.percent).toBe(0.05);
		const minimal: PluginStats = { tokens: { input: 0, output: 0, total: 0 }, cost: 0 };
		expect(minimal.conversationId).toBeUndefined();
		expect(minimal.contextUsage).toBeUndefined();
	});

	it("PluginPermissionFamily：含 v2 新增族", () => {
		const families: PluginPermissionFamily[] = ["fs", "fs:read", "fs:write", "net", "dom", "dom:anchor"];
		expect(families).toContain("fs:read");
		expect(families).toContain("net");
		expect(families).toContain("dom:anchor");
	});
});

describe("UiContribution 新字段（toggle / progress）", () => {
	it("kind:'toggle' + checked 开关态", () => {
		const item: UiContribution = { id: "mute", slot: "topbar.primary", label: "x", kind: "toggle", checked: true };
		expect(item.kind).toBe("toggle");
		expect(item.checked).toBe(true);
	});

	it("kind:'progress' 越界由宿主钳制（复刻断言）", () => {
		const item: UiContribution = {
			id: "dl",
			slot: "topbar.primary",
			label: "x",
			kind: "progress",
			progress: 150,
		};
		expect(clampProgress(item.progress ?? 0)).toBe(100);
	});

	it("clampProgress：下界/界内/边界", () => {
		expect(clampProgress(-5)).toBe(0);
		expect(clampProgress(42.5)).toBe(42.5);
		expect(clampProgress(0)).toBe(0);
		expect(clampProgress(100)).toBe(100);
		expect(clampProgress(Number.NaN)).toBe(0);
	});
});

describe("satisfiesEngines（engines 语义）", () => {
	it(">=：满足与不满足", () => {
		expect(satisfiesEngines("1.3.0", ">=1.2.0")).toBe(true);
		expect(satisfiesEngines("1.1.9", ">=1.2.0")).toBe(false);
	});

	it("^：同 major 且不低于基线才过", () => {
		expect(satisfiesEngines("1.2.0", "^1.2.0")).toBe(true);
		expect(satisfiesEngines("1.9.9", "^1.2.0")).toBe(true);
		expect(satisfiesEngines("2.0.0", "^1.2.0")).toBe(false);
		expect(satisfiesEngines("1.1.9", "^1.2.0")).toBe(false);
	});

	it("精确（含 = 前缀）：相等才过", () => {
		expect(satisfiesEngines("1.2.0", "1.2.0")).toBe(true);
		expect(satisfiesEngines("1.2.1", "1.2.0")).toBe(false);
		expect(satisfiesEngines("1.2.0", "=1.2.0")).toBe(true);
	});

	it("非法 range/非法版本一律放行（true）", () => {
		expect(satisfiesEngines("1.0.0", "not a range")).toBe(true);
		expect(satisfiesEngines("1.0.0", "")).toBe(true);
		expect(satisfiesEngines("bogus", ">=1.2.0")).toBe(true);
	});
});

describe("hostMatches（net 白名单）", () => {
	it("全等命中", () => {
		expect(hostMatches("example.com", "example.com")).toBe(true);
	});

	it("子域名以后缀命中", () => {
		expect(hostMatches("a.example.com", "example.com")).toBe(true);
		expect(hostMatches("a.b.example.com", "example.com")).toBe(true);
	});

	it("裸后缀拼接不算（evilexample.com ≠ example.com 子域）", () => {
		expect(hostMatches("evilexample.com", "example.com")).toBe(false);
	});

	it("嵌套到攻击者域下不算", () => {
		expect(hostMatches("example.com.evil.com", "example.com")).toBe(false);
	});

	it("空 pattern 全拒", () => {
		expect(hostMatches("a.com", "")).toBe(false);
	});
});
