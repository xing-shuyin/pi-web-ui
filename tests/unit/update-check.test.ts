/**
 * All-source update check 单测：包枚举（含 scoped/.bin/坏 package.json）、
 * 结果 shape、并发 checkAll 的优雅降级（单个失败不影响整体）、顺序保持。
 * 全程注入 fake fetcher，零网络。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkAll,
	collectTargets,
	compareVersions,
	listInstalledPackages,
	memoizeWithTtl,
	parsePiVersionOutput,
	type Fetcher,
	type LocalPackage,
} from "../../server/update-check.js";

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

describe("memoizeWithTtl", () => {
	it("calls through once within the TTL, again after expiry", () => {
		vi.useFakeTimers();
		try {
			let n = 0;
			const fn = vi.fn(() => ++n);
			const memo = memoizeWithTtl(fn, 10_000);
			expect(memo()).toBe(1);
			expect(memo()).toBe(1);
			expect(fn).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(10_000);
			expect(memo()).toBe(2);
			expect(fn).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caches null results like any other value", () => {
		vi.useFakeTimers();
		try {
			const fn = vi.fn((): string | null => null);
			const memo = memoizeWithTtl(fn, 60_000);
			expect(memo()).toBeNull();
			expect(memo()).toBeNull();
			expect(fn).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
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

	it("probe miss + no vendored copy → no pi-core row, rest unchanged", () => {
		const dir = makeAgentDir({ foo: "^1.0.0" }, [["foo", "foo", "1.0.0"]]);
		try {
			expect(collectTargets(dir, "0.48.0", () => null)).toEqual([
				{ name: "pi-web-ui", version: "0.48.0", kind: "webui" },
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
});
