import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectExtensionRules,
	compileRuleset,
	DeclarativeNetworkRules,
	domainMatches,
	hostPermissionMatcher,
	hostFromUrl,
	literalToken,
	resourceTypeOf,
	safeRegex,
	urlFilterToRegExp,
	type NetworkRule,
} from "../../browser/runtime/dnr.js";

const allowAll = (_url: string) => true;

const rules = (raw: unknown, allowUrl: (url: string) => boolean = allowAll): NetworkRule[] =>
	compileRuleset(raw, { allowUrl, source: "test" });

const blocked = (list: NetworkRule[], url: string, type = "script", initiator?: string): boolean => {
	const engine = new DeclarativeNetworkRules({ webRequest: { onBeforeRequest: () => {} } } as never);
	engine.setRules(list);
	return engine.isBlocked({ url, resourceType: type, ...(initiator ? { initiatorOrigin: initiator } : {}) });
};

describe("dnr: resource type mapping", () => {
	it("maps Electron webRequest types onto Chrome ResourceType", () => {
		expect(resourceTypeOf("mainFrame")).toBe("main_frame");
		expect(resourceTypeOf("subFrame")).toBe("sub_frame");
		expect(resourceTypeOf("xhr")).toBe("xmlhttprequest");
		expect(resourceTypeOf("cspReport")).toBe("csp_report");
		expect(resourceTypeOf("webSocket")).toBe("websocket");
		expect(resourceTypeOf("somethingNew")).toBe("other");
	});
});

describe("dnr: urlFilter", () => {
	it("anchors ||domain^ to the host, not to a lookalike suffix", () => {
		const filter = urlFilterToRegExp("||example.com^");
		expect(filter).not.toBeNull();
		expect(filter!.test("https://example.com/ads.js")).toBe(true);
		expect(filter!.test("https://sub.example.com/ads.js")).toBe(true);
		expect(filter!.test("https://notexample.com/ads.js")).toBe(false);
		expect(filter!.test("https://example.com.evil.test/ads.js")).toBe(false);
	});

	it("supports * wildcards and ^ separators", () => {
		const filter = urlFilterToRegExp("*/ads/*")!;
		expect(filter.test("https://a.test/ads/banner.png")).toBe(true);
		expect(filter.test("https://a.test/static/banner.png")).toBe(false);
		const separator = urlFilterToRegExp("||tracker.test^")!;
		expect(separator.test("https://tracker.test")).toBe(true);
		expect(separator.test("https://tracker.test/pixel")).toBe(true);
	});

	it("honours |start and end| anchors and case sensitivity", () => {
		expect(urlFilterToRegExp("|https://a.test/")!.test("https://a.test/x")).toBe(true);
		expect(urlFilterToRegExp("|https://a.test/")!.test("https://b.test/?u=https://a.test/")).toBe(false);
		expect(urlFilterToRegExp(".png|")!.test("https://a.test/x.png")).toBe(true);
		expect(urlFilterToRegExp(".png|")!.test("https://a.test/x.png?y=1")).toBe(false);
		expect(urlFilterToRegExp("Banner", true)!.test("https://a.test/banner")).toBe(false);
		expect(urlFilterToRegExp("Banner", false)!.test("https://a.test/banner")).toBe(true);
	});

	it("extracts a literal token for the cheap prefilter", () => {
		expect(literalToken("||example.com^")).toBe("example.com");
		expect(literalToken("*/ads/*")).toBe("ads");
		expect(literalToken("*")).toBeUndefined();
	});

	it("rejects unbounded regex rule patterns", () => {
		expect(safeRegex("^(a+)+$")).not.toBeNull();
		expect(safeRegex("(a)\\1")).toBeNull();
		expect(safeRegex("(?<=x)y")).toBeNull();
		expect(safeRegex("x".repeat(600))).toBeNull();
	});
});

describe("dnr: domains and host permissions", () => {
	it("matches a domain and its subdomains only", () => {
		expect(domainMatches("example.com", "example.com")).toBe(true);
		expect(domainMatches("ads.example.com", "example.com")).toBe(true);
		expect(domainMatches("notexample.com", "example.com")).toBe(false);
	});

	it("derives the request host safely", () => {
		expect(hostFromUrl("https://A.Test/x")).toBe("a.test");
		expect(hostFromUrl("not a url")).toBe("");
	});

	it("gates rules by the extension's host permissions", () => {
		expect(hostPermissionMatcher(["<all_urls>"])("https://any.test/x")).toBe(true);
		expect(hostPermissionMatcher(["<all_urls>"])("file:///tmp/x")).toBe(true);
		expect(hostPermissionMatcher(["*://*/*"])("https://any.test/x")).toBe(true);
		// Chrome 语义：`example.com` 只匹配自己，子域必须显式写成 `*.example.com`
		expect(hostPermissionMatcher(["https://example.com/*"])("https://example.com/x")).toBe(true);
		expect(hostPermissionMatcher(["https://example.com/*"])("https://sub.example.com/x")).toBe(false);
		expect(hostPermissionMatcher(["https://*.example.com/*"])("https://sub.example.com/x")).toBe(true);
		expect(hostPermissionMatcher(["https://*.example.com/*"])("https://example.com/x")).toBe(true);
		expect(hostPermissionMatcher(["https://example.com/*"])("http://example.com/x")).toBe(false);
		expect(hostPermissionMatcher(["https://example.com/*"])("https://other.test/x")).toBe(false);
		expect(hostPermissionMatcher([])("https://any.test/x")).toBe(false);
	});
});

describe("dnr: rule compilation", () => {
	it("keeps only block/allow rules that carry a filter", () => {
		const compiled = rules([
			{ id: 1, action: { type: "block" }, condition: { urlFilter: "ads" } },
			{ id: 2, action: { type: "redirect" }, condition: { urlFilter: "ads" } },
			{ id: 3, action: { type: "block" }, condition: {} },
			{ id: 4, action: { type: "block" }, condition: { regexFilter: "(" } },
		]);
		expect(compiled).toHaveLength(1);
		expect(compiled[0].allow).toBe(false);
	});

	it("filters by resource type and excluded domains", () => {
		const [scriptOnly] = rules([
			{ action: { type: "block" }, condition: { urlFilter: "ads", resourceTypes: ["script"] } },
		]);
		expect(blocked([scriptOnly], "https://a.test/ads.js", "script")).toBe(true);
		expect(blocked([scriptOnly], "https://a.test/ads.png", "image")).toBe(false);

		const [notOnAllowed] = rules([
			{ action: { type: "block" }, condition: { urlFilter: "ads", excludedDomains: ["shop.test"] } },
		]);
		expect(blocked([notOnAllowed], "https://a.test/ads.js", "script", "https://shop.test/")).toBe(false);
		expect(blocked([notOnAllowed], "https://a.test/ads.js", "script", "https://news.test/")).toBe(true);
	});

	it("requires the host permission for the request URL", () => {
		const allowOnlyExample = hostPermissionMatcher(["https://example.com/*"]);
		const [rule] = rules([{ action: { type: "block" }, condition: { urlFilter: "ads" } }], allowOnlyExample);
		expect(blocked([rule], "https://example.com/ads.js")).toBe(true);
		expect(blocked([rule], "https://other.test/ads.js")).toBe(false);
	});
});

describe("dnr: precedence and safety", () => {
	const block = { action: { type: "block" }, condition: { urlFilter: "ads" }, priority: 1 };
	const allow = { action: { type: "allow" }, condition: { urlFilter: "ads" }, priority: 1 };
	const strongerBlock = { action: { type: "block" }, condition: { urlFilter: "ads" }, priority: 5 };

	it("lets the highest priority win and allow win ties", () => {
		expect(blocked(rules([block, allow]), "https://a.test/ads.js")).toBe(false);
		expect(blocked(rules([allow, block]), "https://a.test/ads.js")).toBe(false);
		expect(blocked(rules([allow, strongerBlock]), "https://a.test/ads.js")).toBe(true);
	});

	it("never blocks internal or extension pages", () => {
		const list = rules([block]);
		expect(blocked(list, "file:///E:/app/shell.html")).toBe(false);
		expect(blocked(list, "chrome-extension://abc/popup.html")).toBe(false);
	});

	it("survives a throwing matcher instead of crashing the request", () => {
		const engine = new DeclarativeNetworkRules({ webRequest: { onBeforeRequest: () => {} } } as never);
		engine.setRules([
			{
				id: 1,
				priority: 1,
				allow: false,
				allowUrl: allowAll,
				test: () => {
					throw new Error("boom");
				},
			},
		]);
		expect(engine.isBlocked({ url: "https://a.test/x", resourceType: "script" })).toBe(false);
	});
});

describe("dnr: reading extension rulesets", () => {
	const extension = async (manifest: Record<string, unknown>, files: Record<string, unknown>) => {
		const root = await mkdtemp(join(tmpdir(), "pi-dnr-"));
		await mkdir(join(root, "rules"), { recursive: true });
		await writeFile(join(root, "manifest.json"), JSON.stringify(manifest), "utf8");
		for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), JSON.stringify(body), "utf8");
		return { path: root, name: "Ad blocker", manifest } as unknown as Electron.Extension;
	};

	it("compiles enabled static rulesets of extensions that declare the permission", async () => {
		const ext = await extension(
			{
				manifest_version: 3,
				permissions: ["declarativeNetRequest"],
				host_permissions: ["<all_urls>"],
				declarative_net_request: {
					rule_resources: [
						{ id: "ads", enabled: true, path: "rules/ads.json" },
						{ id: "off", enabled: false, path: "rules/off.json" },
					],
				},
			},
			{
				"rules/ads.json": [
					{ id: 1, action: { type: "block" }, condition: { urlFilter: "ads", resourceTypes: ["script"] } },
				],
				"rules/off.json": [{ id: 1, action: { type: "block" }, condition: { urlFilter: "off" } }],
			},
		);
		const list = await collectExtensionRules([ext]);
		expect(list).toHaveLength(1);
		expect(blocked(list, "https://a.test/ads.js", "script")).toBe(true);
	});

	it("skips extensions without the DNR permission", async () => {
		const ext = await extension(
			{
				manifest_version: 3,
				permissions: ["tabs"],
				host_permissions: ["<all_urls>"],
				declarative_net_request: { rule_resources: [{ id: "ads", path: "rules/ads.json" }] },
			},
			{ "rules/ads.json": [{ action: { type: "block" }, condition: { urlFilter: "ads" } }] },
		);
		expect(await collectExtensionRules([ext])).toEqual([]);
	});

	it("ignores ruleset paths that escape the extension directory", async () => {
		const ext = await extension(
			{
				manifest_version: 3,
				permissions: ["declarativeNetRequest"],
				host_permissions: ["<all_urls>"],
				declarative_net_request: { rule_resources: [{ id: "x", path: "../../etc/passwd" }] },
			},
			{},
		);
		expect(await collectExtensionRules([ext])).toEqual([]);
	});
});
