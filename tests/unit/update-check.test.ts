/**
 * All-source update check 单测：包枚举（含 scoped/.bin/坏 package.json）、
 * 结果 shape、并发 checkAll 的优雅降级（单个失败不影响整体）、顺序保持。
 * 全程注入 fake fetcher，零网络。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLsRemotePatternsForRef,
	checkAll,
	collectTargets,
	compareVersions,
	defaultCheckGitExtension,
	detectPiSdkSplit,
	formatGitVersion,
	isGitExtensionCheckEnabled,
	isHostProvidedPackage,
	listGitExtensions,
	listInstalledPackages,
	NPM_DEFAULT_REGISTRY,
	parseGitExtensionSource,
	parseNpmrcAuth,
	parseNpmrcRegistry,
	parsePiVersionOutput,
	pickRemoteShaForRef,
	resolveNpmRegistry,
	type Fetcher,
	type GitCheckFn,
	type LocalPackage,
} from "../../server/update-check.js";
import type { SdkCopy } from "../../server/sdk-origin.js";

function makeFetcher(latest: Record<string, string>, fail: string[] = []): { fetcher: Fetcher; calls: string[] } {
	const calls: string[] = [];
	const fetcher: Fetcher = async (url) => {
		const name = decodeURIComponent(String(url).split("/").pop() ?? "");
		calls.push(name);
		if (fail.includes(name)) return { ok: false, status: 500, json: async () => ({}) };
		return {
			ok: true,
			status: 200,
			json: async () => ({
				"dist-tags": { latest: latest[name] ?? null },
				time: latest[name] ? { [latest[name]]: "2026-01-01T00:00:00Z" } : {},
			}),
		};
	};
	return { fetcher, calls };
}

describe("compareVersions", () => {
	it("numeric segment compare", () => {
		expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
		expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("0.48.0", "0.48.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
	});
});

describe("parsePiVersionOutput", () => {
	it("prefers an exact version line (leading v, prerelease kept)", () => {
		expect(parsePiVersionOutput("0.84.4")).toBe("0.84.4");
		expect(parsePiVersionOutput("v0.84.4")).toBe("0.84.4");
		expect(parsePiVersionOutput("  0.85.0-beta.1  \n")).toBe("0.85.0-beta.1");
		expect(parsePiVersionOutput("v0.85.0-beta.1+build.7\n")).toBe("0.85.0-beta.1+build.7");
	});

	it("exact line wins over a misleading preamble", () => {
		expect(parsePiVersionOutput("Update available: 0.85.0\n0.84.4")).toBe("0.84.4");
	});

	it("falls back to the first loose token when no line is exact", () => {
		expect(parsePiVersionOutput("pi version is 0.84.4 (built today)")).toBe("0.84.4");
	});

	it("garbage → null", () => {
		expect(parsePiVersionOutput("")).toBeNull();
		expect(parsePiVersionOutput("no version here")).toBeNull();
	});
});

describe("listInstalledPackages", () => {
	let dir: string;
	it("enumerates plain + scoped, skips .bin/dotfiles/broken", () => {
		dir = mkdtempSync(join(tmpdir(), "upd-check-"));
		const root = join(dir, "npm", "node_modules");
		const pkg = (d: string, name: string, version: string) => {
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, "package.json"), JSON.stringify({ name, version }));
		};
		pkg(join(root, "foo"), "foo", "1.0.0");
		pkg(join(root, "@scope", "bar"), "@scope/bar", "2.3.4");
		pkg(join(root, "@scope", "baz"), "@scope/baz", "0.1.0");
		// noise
		mkdirSync(join(root, ".bin"), { recursive: true });
		mkdirSync(join(root, ".hidden"), { recursive: true });
		mkdirSync(join(root, "@scope", ".staging"), { recursive: true });
		mkdirSync(join(root, "broken"), { recursive: true });
		writeFileSync(join(root, "broken", "package.json"), "{not json");
		mkdirSync(join(root, "empty"), { recursive: true }); // no package.json

		const items = listInstalledPackages(dir);
		expect(items).toEqual([
			{ name: "@scope/bar", version: "2.3.4", kind: "package" },
			{ name: "@scope/baz", version: "0.1.0", kind: "package" },
			{ name: "foo", version: "1.0.0", kind: "package" },
		]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] for a missing agentDir", () => {
		// Self-contained fixture — not coupled to the first test's directory.
		const isolated = mkdtempSync(join(tmpdir(), "upd-check-empty-"));
		try {
			expect(listInstalledPackages(join(isolated, "nope"))).toEqual([]);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	});
});

describe("listInstalledPackages (manifest-driven)", () => {
	const pkgJson = (d: string, body: unknown) => {
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "package.json"), JSON.stringify(body));
	};

	it("lists direct deps with installed versions; transitive-only packages excluded", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-manifest-"));
		try {
			pkgJson(join(dir, "npm"), {
				dependencies: { foo: "^1.0.0", "@scope/bar": "~2.0.0" },
			});
			const root = join(dir, "npm", "node_modules");
			pkgJson(join(root, "foo"), { name: "foo", version: "1.2.3" });
			pkgJson(join(root, "@scope", "bar"), {
				name: "@scope/bar",
				version: "2.0.1",
			});
			// transitive dep: present in node_modules but not in the manifest
			pkgJson(join(root, "transitive"), {
				name: "transitive",
				version: "0.5.0",
			});

			expect(listInstalledPackages(dir)).toEqual([
				{ name: "@scope/bar", version: "2.0.1", kind: "package" },
				{ name: "foo", version: "1.2.3", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the raw node_modules walk when the manifest is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-fallback-"));
		try {
			const root = join(dir, "npm", "node_modules");
			pkgJson(join(root, "foo"), { name: "foo", version: "1.0.0" });
			pkgJson(join(root, "extra"), { name: "extra", version: "2.0.0" });
			// no <dir>/npm/package.json at all → old walk behavior
			expect(listInstalledPackages(dir)).toEqual([
				{ name: "extra", version: "2.0.0", kind: "package" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips manifest deps that are not installed (mixed case pins the no-fallback contract)", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-skip-"));
		try {
			pkgJson(join(dir, "npm"), {
				dependencies: { foo: "^1.0.0", ghost: "^1.0.0" },
			});
			// one installed sibling: a mutant that bails to the walk when ANY dep
			// is uninstalled would surface walk-only entries — this pins it
			pkgJson(join(dir, "npm", "node_modules", "foo"), {
				name: "foo",
				version: "1.0.0",
			});
			expect(listInstalledPackages(dir)).toEqual([{ name: "foo", version: "1.0.0", kind: "package" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("collectTargets", () => {
	const pkgJson = (d: string, body: unknown) => {
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "package.json"), JSON.stringify(body));
	};
	const makeAgentDir = (
		manifest: Record<string, string> | null,
		installed: Array<[rel: string, name: string, version: string]>,
	) => {
		const dir = mkdtempSync(join(tmpdir(), "upd-targets-"));
		if (manifest) pkgJson(join(dir, "npm"), { dependencies: manifest });
		for (const [rel, name, version] of installed)
			pkgJson(join(dir, "npm", "node_modules", ...rel.split("/")), {
				name,
				version,
			});
		return dir;
	};
	const CORE = "@earendil-works/pi-coding-agent";

	it("probe hit → one pi-core row, positioned webui < core < packages", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [["foo", "foo", "1.0.0"]]);
		try {
			expect(collectTargets(dir, "0.48.0", () => "0.84.4")).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "0.84.4", kind: "pi-core" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probe miss + no vendored copy → pi-core row kept with an unknown hint (issue #533)", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [["foo", "foo", "1.0.0"]]);
		try {
			expect(collectTargets(dir, "0.48.0", () => null)).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "unknown", kind: "pi-core", error: "pluginupdate.piCore.unknown" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probe miss + vendored copy → pi-core row from the vendored version", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [
			["foo", "foo", "1.0.0"],
			[CORE, CORE, "9.9.9"],
		]);
		try {
			expect(collectTargets(dir, "0.48.0", () => null)).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "9.9.9", kind: "pi-core" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probe wins over vendored copy; manifest row deduped to one pi-core row", () => {
		const dir = makeAgentDir({ foo: "^1.0.0", [CORE]: "^0.84.2" }, [
			["foo", "foo", "1.0.0"],
			[CORE, CORE, "0.84.3"],
		]);
		try {
			const targets = collectTargets(dir, "0.48.0", () => "0.84.4");
			expect(targets[0]).toEqual({
				name: "pi-web-ui",
				version: "0.48.0",
				kind: "webui",
			});
			expect(targets.filter((t) => t.name === CORE)).toEqual([{ name: CORE, version: "0.84.4", kind: "pi-core" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("walk fallback (no manifest) still dedupes the core to one pi-core row", () => {
		const dir = makeAgentDir(null, [
			[CORE, CORE, "0.85.0"],
			["plain", "plain", "1.0.0"],
		]);
		try {
			// probe null → vendored 0.85.0 wins; the raw walk must not re-add CORE
			expect(collectTargets(dir, "0.48.0", () => null)).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "0.85.0", kind: "pi-core" },
				{ name: "plain", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters out host-provided SDK peer packages (@earendil-works/* and @mariozechner/*) from package updates (issue #393)", () => {
		const dir = makeAgentDir(
			{
				foo: "^1.0.0",
				"@earendil-works/pi-agent-core": "^0.86.1",
				"@earendil-works/pi-ai": "^0.86.1",
				"@earendil-works/pi-tui": "^0.86.1",
				"@earendil-works/chord": "^0.1.0",
				"@mariozechner/pi-agent-core": "^0.80.0",
			},
			[
				["foo", "foo", "1.0.0"],
				["@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core", "0.86.1"],
				["@earendil-works/pi-ai", "@earendil-works/pi-ai", "0.86.1"],
				["@earendil-works/pi-tui", "@earendil-works/pi-tui", "0.86.1"],
				["@earendil-works/chord", "@earendil-works/chord", "0.1.0"],
				["@mariozechner/pi-agent-core", "@mariozechner/pi-agent-core", "0.80.0"],
			],
		);
		try {
			const targets = collectTargets(dir, "0.48.0", () => "0.87.1");
			expect(targets).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{ name: CORE, version: "0.87.1", kind: "pi-core" },
				{ name: "foo", version: "1.0.0", kind: "package" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isHostProvidedPackage (issue #393)", () => {
	it("correctly identifies host-provided SDK packages and aliases", () => {
		expect(isHostProvidedPackage("@earendil-works/pi-coding-agent")).toBe(true);
		expect(isHostProvidedPackage("@earendil-works/pi-agent-core")).toBe(true);
		expect(isHostProvidedPackage("@earendil-works/pi-ai")).toBe(true);
		expect(isHostProvidedPackage("@earendil-works/pi-tui")).toBe(true);
		expect(isHostProvidedPackage("@earendil-works/chord")).toBe(true);
		expect(isHostProvidedPackage("@mariozechner/pi-ai")).toBe(true);
		expect(isHostProvidedPackage("pi-goal")).toBe(false);
		expect(isHostProvidedPackage("pi-subagents")).toBe(false);
		expect(isHostProvidedPackage("@other/plugin")).toBe(false);
	});
});

describe("detectPiSdkSplit (issue #321)", () => {
	const copy = (path: string, version: string): SdkCopy => ({ path, version });

	it("probe newer than running → split", () => {
		expect(detectPiSdkSplit("0.85.1", () => "0.86.1", [])).toEqual({ running: "0.85.1", installed: "0.86.1" });
	});

	it("probe same version or older → no split", () => {
		expect(detectPiSdkSplit("0.86.1", () => "0.86.1", [])).toBeNull();
		expect(detectPiSdkSplit("0.86.1", () => "0.85.1", [])).toBeNull();
	});

	it("probe null → shadowed ancestor copy is the fallback detector", () => {
		const copies = [
			copy("/pkg/node_modules/@earendil-works/pi-coding-agent/package.json", "0.85.1"),
			copy("/global/node_modules/@earendil-works/pi-coding-agent/package.json", "0.86.1"),
		];
		expect(detectPiSdkSplit("0.85.1", () => null, copies)).toEqual({ running: "0.85.1", installed: "0.86.1" });
	});

	it("probe and copies both hit → newest wins", () => {
		const copies = [
			copy("/pkg/node_modules/@earendil-works/pi-coding-agent/package.json", "0.85.1"),
			copy("/global/node_modules/@earendil-works/pi-coding-agent/package.json", "0.87.0"),
		];
		expect(detectPiSdkSplit("0.85.1", () => "0.86.1", copies)).toEqual({ running: "0.85.1", installed: "0.87.0" });
		expect(detectPiSdkSplit("0.85.1", () => "0.88.0", copies)).toEqual({ running: "0.85.1", installed: "0.88.0" });
	});

	it("nothing newer anywhere → null (also when running is already the newest copy)", () => {
		const copies = [
			copy("/pkg/node_modules/@earendil-works/pi-coding-agent/package.json", "0.88.0"),
			copy("/global/node_modules/@earendil-works/pi-coding-agent/package.json", "0.85.1"),
		];
		expect(detectPiSdkSplit("0.88.0", () => null, copies)).toBeNull();
	});
});

describe("checkAll", () => {
	it("shapes items, preserves order, degrades failures per-item", async () => {
		const targets: LocalPackage[] = [
			{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
			{ name: "@earendil-works/pi-coding-agent", version: "1.0.0", kind: "pi-core" },
			{ name: "foo", version: "1.0.0", kind: "package" },
			{ name: "flaky", version: "2.0.0", kind: "package" },
		];
		const { fetcher } = makeFetcher(
			{
				"pi-web-ui": "0.49.0",
				"@earendil-works/pi-coding-agent": "1.0.0",
				foo: "0.9.0",
			},
			["flaky"],
		);
		const items = await checkAll(targets, fetcher);
		expect(items.map((i) => i.name)).toEqual(targets.map((t) => t.name));
		const [webui, core, foo, flaky] = items;
		expect(webui).toMatchObject({
			kind: "webui",
			current: "0.48.0",
			latest: "0.49.0",
			upToDate: false,
			latestPublishedAt: "2026-01-01T00:00:00Z",
		});
		expect(core!.upToDate).toBe(true);
		expect(foo).toMatchObject({ upToDate: true, current: "1.0.0", latest: "0.9.0" });
		expect(flaky).toMatchObject({
			latest: null,
			upToDate: false,
		});
		expect(flaky!.error).toContain("500");
		// one failure never rejects the whole list
		expect(items.every((i) => typeof i.current === "string")).toBe(true);
	});

	it("handles missing dist-tags / sparse docs", async () => {
		const fetcher: Fetcher = async () => ({
			ok: true,
			status: 200,
			json: async () => ({}),
		});
		const items = await checkAll([{ name: "ghost", version: "1.0.0", kind: "package" }], fetcher);
		expect(items[0]).toMatchObject({ latest: null, upToDate: true });
	});

	it("uses the configured registry base + auth header (issue #151)", async () => {
		const seen: Array<{ url: string; init?: { headers?: Record<string, string> } }> = [];
		const fetcher: Fetcher = async (url, init) => {
			seen.push({ url, init });
			return {
				ok: true,
				status: 200,
				json: async () => ({
					"dist-tags": { latest: "9.9.9" },
					time: { "9.9.9": "2026-01-01T00:00:00Z" },
				}),
			};
		};
		await checkAll([{ name: "foo", version: "1.0.0", kind: "package" }], fetcher, undefined, {
			registry: "https://registry.npmmirror.com",
			authHeader: "Bearer sekrit",
		});
		expect(seen[0]!.url).toBe("https://registry.npmmirror.com/foo");
		expect(seen[0]!.init?.headers).toEqual({ authorization: "Bearer sekrit" });
	});
});

describe("npmrc registry resolution (issue #151)", () => {
	it("parseNpmrcRegistry: last registry= wins, quotes/trailing slash cleaned", () => {
		expect(parseNpmrcRegistry("")).toBeNull();
		expect(parseNpmrcRegistry("# comment\n; another\n")).toBeNull();
		expect(
			parseNpmrcRegistry('registry=https://registry.npmjs.org/\nregistry = "https://registry.npmmirror.com/"\n'),
		).toBe("https://registry.npmmirror.com");
		// 非 http(s) 行忽略
		expect(parseNpmrcRegistry("registry=npmjs\n")).toBeNull();
	});

	it("parseNpmrcAuth: matches the registry host, _authToken beats _auth", () => {
		const text =
			"//other.example.com/:_authToken=nope\n" +
			"//registry.npmmirror.com/:_auth=dGVzdA==\n" +
			"//registry.npmmirror.com/:_authToken=sekrit\n";
		expect(parseNpmrcAuth(text, "https://registry.npmmirror.com")).toBe("Bearer sekrit");
		expect(parseNpmrcAuth("//registry.npmmirror.com/:_auth=dGVzdA==\n", "https://registry.npmmirror.com")).toBe(
			"Basic dGVzdA==",
		);
		expect(parseNpmrcAuth("//other.example.com/:_authToken=nope\n", "https://registry.npmmirror.com")).toBeNull();
		expect(parseNpmrcAuth("registry=x\n", "not a url")).toBeNull();
	});

	it("resolveNpmRegistry: missing .npmrc → official default", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-npmrc-missing-"));
		try {
			expect(resolveNpmRegistry(dir)).toEqual({
				registry: NPM_DEFAULT_REGISTRY,
				authHeader: null,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolveNpmRegistry: reads <agentDir>/npm/.npmrc", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-npmrc-"));
		try {
			mkdirSync(join(dir, "npm"), { recursive: true });
			writeFileSync(
				join(dir, "npm", ".npmrc"),
				"registry=https://registry.npmmirror.com/\n//registry.npmmirror.com/:_authToken=sekrit\n",
			);
			expect(resolveNpmRegistry(dir)).toEqual({
				registry: "https://registry.npmmirror.com",
				authHeader: "Bearer sekrit",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sortUpdateItems", () => {
	it("pins webui/pi-core top, outdated before up-to-date, errors last", async () => {
		const { sortUpdateItems } = await import("../../server/update-check.js");
		const items = [
			{ name: "ok-pkg", kind: "package", current: "1.0.0", latest: "1.0.0", latestPublishedAt: null, upToDate: true },
			{
				name: "bad-pkg",
				kind: "package",
				current: "1.0.0",
				latest: null,
				latestPublishedAt: null,
				upToDate: false,
				error: "boom",
			},
			{ name: "old-pkg", kind: "package", current: "1.0.0", latest: "2.0.0", latestPublishedAt: null, upToDate: false },
			{
				name: "@earendil-works/pi-coding-agent",
				kind: "pi-core",
				current: "1.0.0",
				latest: "1.0.0",
				latestPublishedAt: null,
				upToDate: true,
			},
			{
				name: "pi-web-ui",
				kind: "webui",
				current: "0.48.0",
				latest: "0.48.0",
				latestPublishedAt: null,
				upToDate: true,
			},
		] as Parameters<typeof sortUpdateItems>[0];
		expect(sortUpdateItems(items).map((i) => i.name)).toEqual([
			"pi-web-ui",
			"@earendil-works/pi-coding-agent",
			"old-pkg",
			"ok-pkg",
			"bad-pkg",
		]);
	});
});

describe("parseGitExtensionSource (issue #178)", () => {
	it("parses git:-prefixed shorthand", () => {
		expect(parseGitExtensionSource("git:github.com/NVlabs/SoL-Pi")).toEqual({
			host: "github.com",
			path: "NVlabs/SoL-Pi",
			ref: null,
			shorthand: "github.com/NVlabs/SoL-Pi",
			identity: "git:github.com/NVlabs/SoL-Pi",
		});
	});

	it("parses https URLs, strips .git, keeps @ref", () => {
		expect(parseGitExtensionSource("git:https://github.com/acme/widgets.git")).toMatchObject({
			host: "github.com",
			path: "acme/widgets",
			ref: null,
		});
		expect(parseGitExtensionSource("git:github.com/acme/widgets@main")).toMatchObject({
			path: "acme/widgets",
			ref: "main",
		});
		expect(parseGitExtensionSource("https://gitlab.example.com/group/sub/repo")).toMatchObject({
			host: "gitlab.example.com",
			path: "group/sub/repo",
		});
	});

	it("parses scp-like git@ syntax", () => {
		expect(parseGitExtensionSource("git:git@github.com:acme/widgets.git")).toMatchObject({
			host: "github.com",
			path: "acme/widgets",
		});
	});

	it("rejects npm:/local/bare/garbage entries", () => {
		expect(parseGitExtensionSource("npm:pi-lens")).toBeNull();
		expect(parseGitExtensionSource("npm:@scope/pkg@1.2.3")).toBeNull();
		expect(parseGitExtensionSource("./relative/path")).toBeNull();
		expect(parseGitExtensionSource("bare-name")).toBeNull();
		// bare a/b without git: prefix is a local path, not a git source
		expect(parseGitExtensionSource("my-dir/my-ext")).toBeNull();
		expect(parseGitExtensionSource("")).toBeNull();
		expect(parseGitExtensionSource("git:")).toBeNull();
		// single-segment path can never be owner/repo
		expect(parseGitExtensionSource("git:github.com/onlyowner")).toBeNull();
		// path traversal is refused
		expect(parseGitExtensionSource("git:github.com/a/../../evil")).toBeNull();
	});
});

describe("isGitExtensionCheckEnabled (issue #178)", () => {
	it("defaults on; 0/false/no/off disable", () => {
		expect(isGitExtensionCheckEnabled({})).toBe(true);
		expect(isGitExtensionCheckEnabled({ PI_WEB_GIT_EXTENSION_CHECK: "1" })).toBe(true);
		for (const v of ["0", "false", "FALSE", "no", "off", " 0 "]) {
			expect(isGitExtensionCheckEnabled({ PI_WEB_GIT_EXTENSION_CHECK: v }), v).toBe(false);
		}
	});
});

describe("listGitExtensions (issue #178)", () => {
	const writeJson = (d: string, body: unknown) => {
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "package.json"), JSON.stringify(body));
	};
	const makeTree = () => {
		const agentDir = mkdtempSync(join(tmpdir(), "upd-git-global-"));
		const projCwd = mkdtempSync(join(tmpdir(), "upd-git-proj-"));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [
					"npm:pi-x",
					"git:github.com/NVlabs/SoL-Pi",
					"git:github.com/acme/widgets",
					"./local-dir",
					{ source: "git:github.com/acme/object-form" },
				],
			}),
		);
		writeJson(join(agentDir, "git", "github.com", "NVlabs", "SoL-Pi"), { name: "sol-pi", version: "0.1.0" });
		writeJson(join(agentDir, "git", "github.com", "acme", "widgets"), { name: "acme-widgets", version: "2.0.0" });
		// object-form has no clone on disk → row kept with version "?"
		mkdirSync(join(projCwd, ".pi"), { recursive: true });
		writeFileSync(
			join(projCwd, ".pi", "settings.json"),
			JSON.stringify({
				packages: ["git:github.com/NVlabs/SoL-Pi", "git:github.com/acme/proj-only@main"],
			}),
		);
		writeJson(join(projCwd, ".pi", "git", "github.com", "NVlabs", "SoL-Pi"), {
			name: "sol-pi-proj",
			version: "9.9.9",
		});
		writeJson(join(projCwd, ".pi", "git", "github.com", "acme", "proj-only"), {
			name: "proj-only",
			version: "1.0.0",
		});
		return { agentDir, projCwd };
	};

	it("merges global + project, project wins on identity collision", () => {
		const { agentDir, projCwd } = makeTree();
		try {
			const items = listGitExtensions(agentDir, projCwd, {});
			expect(items.map((i) => i.name)).toEqual([
				"acme-widgets",
				"github.com/acme/object-form",
				"proj-only",
				"sol-pi-proj",
			]);
			const solPi = items.find((i) => i.source === "github.com/NVlabs/SoL-Pi")!;
			expect(solPi.version).toBe("9.9.9"); // project clone wins
			expect(solPi.installDir).toBe(join(projCwd, ".pi", "git", "github.com", "NVlabs", "SoL-Pi"));
			expect(solPi.ref).toBeNull();
			const projOnly = items.find((i) => i.name === "proj-only")!;
			expect(projOnly.ref).toBe("main");
			const missing = items.find((i) => i.name === "github.com/acme/object-form")!;
			expect(missing.version).toBe("?");
			expect(missing.installDir).toBe(join(agentDir, "git", "github.com", "acme", "object-form"));
			// npm:/local: entries never leak into the git list
			expect(items.every((i) => i.kind === "git-extension")).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projCwd, { recursive: true, force: true });
		}
	});

	it("works without a project cwd and with missing settings", () => {
		const { agentDir, projCwd } = makeTree();
		try {
			expect(listGitExtensions(agentDir, undefined, {}).map((i) => i.name)).toEqual([
				"acme-widgets",
				"github.com/acme/object-form",
				"sol-pi",
			]);
			expect(listGitExtensions(join(agentDir, "nope"), join(projCwd, "nope"), {})).toEqual([]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projCwd, { recursive: true, force: true });
		}
	});

	it("env switch disables the whole git list", () => {
		const { agentDir, projCwd } = makeTree();
		try {
			expect(listGitExtensions(agentDir, projCwd, { PI_WEB_GIT_EXTENSION_CHECK: "0" })).toEqual([]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projCwd, { recursive: true, force: true });
		}
	});

	it("w9: name and version fall back independently, name never empty", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "upd-git-half-"));
		try {
			// Clone with a version but no usable name: version kept, name = shorthand.
			mkdirSync(join(agentDir, "git", "github.com", "acme", "noname"), { recursive: true });
			writeFileSync(
				join(agentDir, "git", "github.com", "acme", "noname", "package.json"),
				JSON.stringify({ version: "1.0.0" }),
			);
			// Clone with a name but no version: name kept, version "?".
			mkdirSync(join(agentDir, "git", "github.com", "acme", "nover"), { recursive: true });
			writeFileSync(
				join(agentDir, "git", "github.com", "acme", "nover", "package.json"),
				JSON.stringify({ name: "acme-nover" }),
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ packages: ["git:github.com/acme/noname", "git:github.com/acme/nover"] }),
			);
			const items = listGitExtensions(agentDir, undefined, {});
			expect(items).toEqual([
				expect.objectContaining({ name: "acme-nover", version: "?" }),
				expect.objectContaining({ name: "github.com/acme/noname", version: "1.0.0" }),
			]);
			expect(items.every((i) => i.name.length > 0)).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("collectTargets with git extensions (issue #178)", () => {
	it("appends git rows after npm packages", () => {
		const dir = mkdtempSync(join(tmpdir(), "upd-targets-git-"));
		try {
			mkdirSync(join(dir, "npm"), { recursive: true });
			writeFileSync(join(dir, "npm", "package.json"), JSON.stringify({ dependencies: { foo: "^1.0.0" } }));
			mkdirSync(join(dir, "npm", "node_modules", "foo"), { recursive: true });
			writeFileSync(
				join(dir, "npm", "node_modules", "foo", "package.json"),
				JSON.stringify({ name: "foo", version: "1.0.0" }),
			);
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["git:github.com/NVlabs/SoL-Pi"] }));
			mkdirSync(join(dir, "git", "github.com", "NVlabs", "SoL-Pi"), { recursive: true });
			writeFileSync(
				join(dir, "git", "github.com", "NVlabs", "SoL-Pi", "package.json"),
				JSON.stringify({ name: "sol-pi", version: "0.1.0" }),
			);
			const targets = collectTargets(dir, "0.48.0", () => null, {});
			expect(targets).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
				{
					name: "@earendil-works/pi-coding-agent",
					version: "unknown",
					kind: "pi-core",
					error: "pluginupdate.piCore.unknown",
				},
				{ name: "foo", version: "1.0.0", kind: "package" },
				{
					name: "sol-pi",
					version: "0.1.0",
					kind: "git-extension",
					source: "github.com/NVlabs/SoL-Pi",
					installDir: join(dir, "git", "github.com", "NVlabs", "SoL-Pi"),
					ref: null,
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("formatGitVersion", () => {
	it("version + short sha; sha-only without a version", () => {
		expect(formatGitVersion("0.1.0", "a".repeat(40))).toBe(`0.1.0 (${"a".repeat(7)})`);
		expect(formatGitVersion("?", "b".repeat(40))).toBe("b".repeat(7));
		expect(formatGitVersion("", "c".repeat(40))).toBe("c".repeat(7));
	});
});

describe("checkAll git extensions (issue #178)", () => {
	const LOCAL_A = "a".repeat(40);
	const REMOTE_B = "b".repeat(40);
	const SAME_C = "c".repeat(40);
	const gitCheck: GitCheckFn = async (dir: string) => {
		if (dir === "/x") return { localSha: LOCAL_A, remoteSha: REMOTE_B };
		if (dir === "/y") return { localSha: SAME_C, remoteSha: SAME_C };
		throw new Error("clone missing");
	};
	const targets: LocalPackage[] = [
		{ name: "sol-pi", version: "0.1.0", kind: "git-extension", source: "github.com/NVlabs/SoL-Pi", installDir: "/x" },
		{
			name: "up-to-date-ext",
			version: "1.0.0",
			kind: "git-extension",
			source: "github.com/acme/current",
			installDir: "/y",
		},
		{ name: "broken-ext", version: "?", kind: "git-extension", source: "github.com/acme/broken", installDir: "/z" },
	];

	it("sha mismatch → outdated with version(short-sha) on both sides", async () => {
		const { fetcher } = makeFetcher({});
		const items = await checkAll(targets, fetcher, undefined, undefined, gitCheck);
		expect(items.map((i) => i.name)).toEqual(targets.map((t) => t.name));
		expect(items[0]).toMatchObject({
			kind: "git-extension",
			current: "0.1.0 (aaaaaaa)",
			latest: "0.1.0 (bbbbbbb)",
			upToDate: false,
			source: "github.com/NVlabs/SoL-Pi",
		});
		expect(items[0]!.latestPublishedAt).toBeNull();
	});

	it("equal shas → upToDate, current === latest", async () => {
		const { fetcher } = makeFetcher({});
		const items = await checkAll(targets, fetcher, undefined, undefined, gitCheck);
		expect(items[1]).toMatchObject({
			kind: "git-extension",
			current: "1.0.0 (ccccccc)",
			latest: "1.0.0 (ccccccc)",
			upToDate: true,
		});
	});

	it("git failure degrades to a per-item error without touching other rows", async () => {
		const { fetcher } = makeFetcher({});
		const items = await checkAll(targets, fetcher, undefined, undefined, gitCheck);
		expect(items[2]).toMatchObject({ latest: null, upToDate: false, current: "?" });
		expect(items[2]!.error).toContain("clone missing");
		// the npm path still works alongside git rows
		const mixed = await checkAll(
			[...targets.slice(0, 1), { name: "foo", version: "1.0.0", kind: "package" as const }],
			makeFetcher({ foo: "2.0.0" }).fetcher,
			undefined,
			undefined,
			gitCheck,
		);
		expect(mixed[1]).toMatchObject({ kind: "package", latest: "2.0.0", upToDate: false });
	});
});

describe("buildLsRemotePatternsForRef", () => {
	it("expands shorthand into branches, tags, peeled tags, and bare name", () => {
		expect(buildLsRemotePatternsForRef("dev")).toEqual([
			"refs/heads/dev",
			"refs/tags/dev",
			"refs/tags/dev^{}",
			"dev",
			"dev^{}",
		]);
	});

	it("keeps full refs/ path with peeled tag variant only", () => {
		expect(buildLsRemotePatternsForRef("refs/heads/feature/x")).toEqual([
			"refs/heads/feature/x",
			"refs/heads/feature/x^{}",
		]);
		expect(buildLsRemotePatternsForRef("refs/tags/v1.0.0")).toEqual(["refs/tags/v1.0.0", "refs/tags/v1.0.0^{}"]);
	});
});

describe("pickRemoteShaForRef", () => {
	const SHA_BRANCH = "1111111111111111111111111111111111111111";
	const SHA_TAG_OBJ = "2222222222222222222222222222222222222222";
	const SHA_TAG_COMMIT = "3333333333333333333333333333333333333333";
	const SHA_EXPLICIT = "4444444444444444444444444444444444444444";

	it("matches branch ref", () => {
		const out = `${SHA_BRANCH}\trefs/heads/dev\n`;
		expect(pickRemoteShaForRef(out, "dev")).toBe(SHA_BRANCH);
	});

	it("prefers peeled tag (annotated tag commit) over unpeeled tag object", () => {
		const out = `${SHA_TAG_OBJ}\trefs/tags/v1.0.0\n${SHA_TAG_COMMIT}\trefs/tags/v1.0.0^{}\n`;
		expect(pickRemoteShaForRef(out, "v1.0.0")).toBe(SHA_TAG_COMMIT);
	});

	it("matches lightweight tag when no peeled line exists", () => {
		const out = `${SHA_TAG_COMMIT}\trefs/tags/v1.0.0\n`;
		expect(pickRemoteShaForRef(out, "v1.0.0")).toBe(SHA_TAG_COMMIT);
	});

	it("matches full refs/heads or refs/tags paths", () => {
		const out = `${SHA_EXPLICIT}\trefs/heads/dev\n`;
		expect(pickRemoteShaForRef(out, "refs/heads/dev")).toBe(SHA_EXPLICIT);
	});

	it("returns null when no matching ref is found", () => {
		const out = `${SHA_BRANCH}\trefs/heads/main\n`;
		expect(pickRemoteShaForRef(out, "dev")).toBeNull();
		expect(pickRemoteShaForRef("", "dev")).toBeNull();
	});
});

describe("checkAll git extensions with ref (issue #665)", () => {
	const LOCAL_A = "a".repeat(40);
	const REMOTE_DEV = "d".repeat(40);
	const calls: Array<{ dir: string; ref?: string | null }> = [];
	const gitCheck: GitCheckFn = async (dir: string, ref?: string | null) => {
		calls.push({ dir, ref });
		if (ref === "dev") return { localSha: LOCAL_A, remoteSha: LOCAL_A };
		if (ref === "outdated") return { localSha: LOCAL_A, remoteSha: REMOTE_DEV };
		return { localSha: LOCAL_A, remoteSha: LOCAL_A };
	};

	it("passes ref to gitCheck and respects upToDate result", async () => {
		const targets: LocalPackage[] = [
			{
				name: "ref-ext",
				version: "0.1.0",
				kind: "git-extension",
				source: "github.com/acme/widgets",
				installDir: "/widgets",
				ref: "dev",
			},
			{
				name: "outdated-ext",
				version: "0.1.0",
				kind: "git-extension",
				source: "github.com/acme/outdated",
				installDir: "/outdated",
				ref: "outdated",
			},
		];
		const { fetcher } = makeFetcher({});
		const items = await checkAll(targets, fetcher, undefined, undefined, gitCheck);
		expect(calls).toEqual([
			{ dir: "/widgets", ref: "dev" },
			{ dir: "/outdated", ref: "outdated" },
		]);
		expect(items[0]).toMatchObject({
			name: "ref-ext",
			upToDate: true,
			current: "0.1.0 (aaaaaaa)",
			latest: "0.1.0 (aaaaaaa)",
		});
		expect(items[1]).toMatchObject({
			name: "outdated-ext",
			upToDate: false,
			current: "0.1.0 (aaaaaaa)",
			latest: "0.1.0 (ddddddd)",
		});
	});
});

describe("defaultCheckGitExtension (issue #665)", () => {
	it("is a function", () => {
		expect(typeof defaultCheckGitExtension).toBe("function");
	});

	it("resolves ref properly against remote without relying on checked-out upstream", async () => {
		const root = mkdtempSync(join(tmpdir(), "upd-git-repo-"));
		const remoteDir = join(root, "remote");
		const cloneDir = join(root, "clone");

		try {
			// 1. Create a remote bare repo with main and dev branches + annotated tag
			const git = (args: string[], cwd: string) =>
				execFileSync("git", args, {
					cwd,
					encoding: "utf8",
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "tester",
						GIT_AUTHOR_EMAIL: "tester@example.com",
						GIT_COMMITTER_NAME: "tester",
						GIT_COMMITTER_EMAIL: "tester@example.com",
					},
				}).trim();

			mkdirSync(remoteDir, { recursive: true });
			git(["init", "--bare", "-b", "main"], remoteDir);

			// Temporary work dir to push initial commits
			const workDir = join(root, "work");
			mkdirSync(workDir, { recursive: true });
			git(["init", "-b", "main"], workDir);
			writeFileSync(join(workDir, "file.txt"), "main commit 1\n");
			git(["add", "file.txt"], workDir);
			const mainCommit1 = git(["commit", "-m", "main 1"], workDir);
			git(["remote", "add", "origin", remoteDir], workDir);
			git(["push", "-u", "origin", "main"], workDir);

			// Create dev branch with another commit
			git(["checkout", "-b", "dev"], workDir);
			writeFileSync(join(workDir, "dev.txt"), "dev commit 1\n");
			git(["add", "dev.txt"], workDir);
			git(["commit", "-m", "dev 1"], workDir);
			const devCommit = git(["rev-parse", "HEAD"], workDir);
			git(["push", "-u", "origin", "dev"], workDir);

			// Create annotated tag on dev commit
			git(["tag", "-a", "v1.0.0", "-m", "tag v1.0.0", devCommit], workDir);
			git(["push", "origin", "v1.0.0"], workDir);

			// Add a new commit to main so main > mainCommit1
			git(["checkout", "main"], workDir);
			writeFileSync(join(workDir, "file.txt"), "main commit 2\n");
			git(["add", "file.txt"], workDir);
			git(["commit", "-m", "main 2"], workDir);
			const mainCommit2 = git(["rev-parse", "HEAD"], workDir);
			git(["push", "origin", "main"], workDir);

			// 2. Clone repository: checked out on main, but reset to devCommit (simulating pi update state)
			git(["clone", remoteDir, cloneDir], root);
			// Symbolic-ref HEAD is still refs/heads/main, upstream is origin/main,
			// but working tree & HEAD is set to devCommit
			git(["reset", "--hard", devCommit], cloneDir);

			const localSha = git(["rev-parse", "HEAD"], cloneDir);
			const currentBranch = git(["symbolic-ref", "--short", "HEAD"], cloneDir);
			expect(currentBranch).toBe("main");

			// Case 1: with ref="dev" -> resolves to origin/dev (devCommit), NOT origin/main (mainCommit2)!
			const resDev = await defaultCheckGitExtension(cloneDir, "dev");
			expect(resDev.localSha).toBe(localSha);
			expect(resDev.remoteSha).toBe(resDev.localSha); // Up-to-date with dev!

			// Case 2: with ref="v1.0.0" -> resolves to peeled commit of annotated tag
			const resTag = await defaultCheckGitExtension(cloneDir, "v1.0.0");
			expect(resTag.localSha).toBe(localSha);
			expect(resTag.remoteSha).toBe(resDev.localSha); // Same commit as tag!

			// Case 3: with ref=commit SHA (exact or short sha)
			const shortDev = localSha.slice(0, 7);
			const resSha = await defaultCheckGitExtension(cloneDir, shortDev);
			expect(resSha.localSha).toBe(localSha);
			expect(resSha.remoteSha).toBe(localSha);

			// Case 3b: commit SHA works even if remote is unreachable (e.g. offline)
			// Point origin to a nonexistent local path that fails immediately without network DNS delay
			git(["remote", "set-url", "origin", join(root, "nonexistent-remote")], cloneDir);
			const resOfflineSha = await defaultCheckGitExtension(cloneDir, shortDev);
			expect(resOfflineSha.localSha).toBe(localSha);
			expect(resOfflineSha.remoteSha).toBe(localSha);
			// Restore origin URL
			git(["remote", "set-url", "origin", remoteDir], cloneDir);

			// Case 4: with ref=commit SHA that does not match local HEAD
			const shortMain = git(["rev-parse", "main"], workDir).slice(0, 7);
			const resShaDiff = await defaultCheckGitExtension(cloneDir, shortMain);
			expect(resShaDiff.localSha).toBe(localSha);
			expect(resShaDiff.remoteSha).not.toBe(localSha);

			// Case 5: nonexistent ref throws clear error
			await expect(defaultCheckGitExtension(cloneDir, "nonexistent-branch")).rejects.toThrow(
				/Failed to resolve remote ref/,
			);

			// Case 6: without ref -> falls back to upstream (origin/main == mainCommit2), so remoteSha != localSha
			const resNoRef = await defaultCheckGitExtension(cloneDir);
			expect(resNoRef.localSha).toBe(localSha);
			expect(resNoRef.remoteSha).not.toBe(localSha);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);
});
