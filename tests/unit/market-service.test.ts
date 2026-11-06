import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRemoteMcpMarket, fetchRemoteSkillMarket, fetchRemoteSkillContent } from "../../server/market-service.js";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("market-service", () => {
	it("fetchRemoteMcpMarket 命中缓存与容错", async () => {
		const dir = makeTempDir("market-test-");
		try {
			const cacheDir = join(dir, "market-cache");
			const cacheFile = join(cacheDir, "mcp-market-smithery-all.json");
			const mockServers = [
				{
					id: "test-mcp",
					name: "Test MCP",
					description: "A test server",
					transport: "stdio" as const,
					source: "smithery",
				},
			];
			const { mkdirSync } = await import("node:fs");
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(cacheFile, JSON.stringify({ timestamp: Date.now(), data: mockServers }));

			const res = await fetchRemoteMcpMarket({
				source: "smithery",
				dataDir: dir,
				refresh: false,
			});

			expect(res.ok).toBe(true);
			expect(res.servers.length).toBe(1);
			expect(res.servers[0].id).toBe("test-mcp");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fetchRemoteSkillMarket 命中缓存与容错", async () => {
		const dir = makeTempDir("skill-market-test-");
		try {
			const cacheDir = join(dir, "market-cache");
			const cacheFile = join(cacheDir, "skill-market-anthropics_skills.json");
			const mockSkills = [
				{
					id: "web-testing",
					name: "web-testing",
					description: "Playwright test runner",
					repo: "anthropics/skills",
				},
			];
			const { mkdirSync } = await import("node:fs");
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(cacheFile, JSON.stringify({ timestamp: Date.now(), data: mockSkills }));

			const res = await fetchRemoteSkillMarket({
				repo: "anthropics/skills",
				dataDir: dir,
				refresh: false,
			});

			expect(res.ok).toBe(true);
			expect(res.skills.length).toBe(1);
			expect(res.skills[0].id).toBe("web-testing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fetchRemoteSkillContent 当请求不存在时优雅报错", async () => {
		const dir = makeTempDir("skill-content-test-");
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				statusText: "Not Found",
			} as Response);

			const res = await fetchRemoteSkillContent({
				repo: "definitely-not-a-real-org/definitely-not-a-real-repo",
				skillId: "xyz-non-existent",
				dataDir: dir,
			});
			expect(res.ok).toBe(false);
			expect(res.error).toBeDefined();
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fetchRemoteSkillContent 成功获取并返回内容", async () => {
		const dir = makeTempDir("skill-content-test-");
		const originalFetch = globalThis.fetch;
		try {
			const mockContent = "---\nname: my-skill\n---\n# My Skill Instructions";
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => mockContent,
			} as Response);

			const res = await fetchRemoteSkillContent({
				repo: "mock-org/mock-repo",
				skillId: "my-skill",
				dataDir: dir,
			});
			expect(res.ok).toBe(true);
			expect(res.content).toBe(mockContent);
			expect(res.skillId).toBe("my-skill");
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("market 缓存 key 路径穿越防护（0.103 审计）", () => {
	it("query 里的 ../ 不再逃出 market-cache：消毒后的缓存文件零网络命中", async () => {
		const dir = makeTempDir("market-trav-");
		const originalFetch = globalThis.fetch;
		try {
			const cacheDir = join(dir, "market-cache");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(cacheDir, { recursive: true });
			const mockServers = [
				{ id: "hit", name: "Hit", description: "d", transport: "stdio" as const, source: "smithery" },
			];
			const query = "q/../../x";
			writeFileSync(
				join(cacheDir, `mcp-market-smithery-${query.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
				JSON.stringify({ timestamp: Date.now(), data: mockServers }),
			);
			let fetchCalled = false;
			vi.stubGlobal("fetch", ((..._args: unknown[]) => {
				fetchCalled = true;
				return Promise.reject(new Error("network disabled in test"));
			}) as typeof fetch);
			const r = await fetchRemoteMcpMarket({ source: "smithery", query, dataDir: dir });
			expect(fetchCalled).toBe(false);
			expect(r.ok).toBe(true);
			expect(r.servers[0]?.id).toBe("hit");
		} finally {
			vi.unstubAllGlobals();
			globalThis.fetch = originalFetch;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
