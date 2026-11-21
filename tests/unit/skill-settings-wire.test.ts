import { describe, expect, it, vi } from "vitest";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import type { ClientMessage } from "../../server/protocol.js";
import type { DispatchSession } from "../../server/engine-service.js";
import { PUBLIC_SKILLS, SKILL_MARKETS } from "../../web/src/skill-catalog.js";
import { MCP_MARKETS, PUBLIC_MCP_SERVERS } from "../../web/src/mcp-catalog.js";

describe("Skill 技能市场消息分发与清单体检", () => {
	it("分发 install_skill 消息", () => {
		const installSkill = vi.fn();
		const mockSession = {
			installSkill,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "install_skill",
			name: "code-review",
			scope: "global",
			content: "---\nname: code-review\n---\n# Guide",
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(installSkill).toHaveBeenCalledWith("code-review", "global", msg.content);
	});

	it("分发 uninstall_skill 消息", () => {
		const uninstallSkill = vi.fn();
		const mockSession = {
			uninstallSkill,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "uninstall_skill",
			name: "code-review",
			scope: "project",
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(uninstallSkill).toHaveBeenCalledWith("code-review", "project");
	});

	it("PUBLIC_SKILLS 目录清单规范性校验", () => {
		expect(PUBLIC_SKILLS.length).toBeGreaterThanOrEqual(10);
		for (const sk of PUBLIC_SKILLS) {
			expect(/^[a-zA-Z0-9_-]+$/.test(sk.id)).toBe(true);
			expect(sk.name.trim().length).toBeGreaterThan(0);
			expect(sk.nameZh.trim().length).toBeGreaterThan(0);
			expect(sk.description.trim().length).toBeGreaterThan(0);
			expect(sk.descriptionZh.trim().length).toBeGreaterThan(0);
			expect(sk.content.startsWith("---")).toBe(true);
			expect(sk.content).toContain(`name: ${sk.id}`);
		}
	});

	it("SKILL_MARKETS 链接列表规范性校验", () => {
		expect(SKILL_MARKETS.length).toBeGreaterThanOrEqual(10);
		const validCategories = new Set(["official", "marketplace", "community", "directory"]);
		for (const market of SKILL_MARKETS) {
			expect(/^[a-zA-Z0-9_-]+$/.test(market.id)).toBe(true);
			expect(market.name.trim().length).toBeGreaterThan(0);
			expect(market.nameZh.trim().length).toBeGreaterThan(0);
			expect(market.description.trim().length).toBeGreaterThan(0);
			expect(market.descriptionZh.trim().length).toBeGreaterThan(0);
			expect(market.url.startsWith("https://")).toBe(true);
			expect(() => new URL(market.url)).not.toThrow();
			expect(validCategories.has(market.category)).toBe(true);
			if (market.tags) {
				expect(Array.isArray(market.tags)).toBe(true);
				for (const tag of market.tags) {
					expect(tag.trim().length).toBeGreaterThan(0);
				}
			}
		}
	});

	it("PUBLIC_MCP_SERVERS 目录清单规范性校验", () => {
		expect(PUBLIC_MCP_SERVERS.length).toBeGreaterThanOrEqual(10);
		const validRegions = new Set(["cn", "global"]);
		for (const srv of PUBLIC_MCP_SERVERS) {
			expect(/^[a-zA-Z0-9_-]+$/.test(srv.id)).toBe(true);
			expect(srv.name.trim().length).toBeGreaterThan(0);
			expect(srv.nameZh.trim().length).toBeGreaterThan(0);
			expect(srv.package.trim().length).toBeGreaterThan(0);
			expect(srv.description.trim().length).toBeGreaterThan(0);
			expect(srv.descriptionZh.trim().length).toBeGreaterThan(0);
			expect(srv.homepage.startsWith("https://")).toBe(true);
			expect(() => new URL(srv.homepage)).not.toThrow();
			expect(validRegions.has(srv.region)).toBe(true);
		}
	});

	it("MCP_MARKETS 链接列表规范性校验", () => {
		expect(MCP_MARKETS.length).toBeGreaterThanOrEqual(10);
		const validCategories = new Set(["official", "marketplace", "community", "directory"]);
		for (const market of MCP_MARKETS) {
			expect(/^[a-zA-Z0-9_-]+$/.test(market.id)).toBe(true);
			expect(market.name.trim().length).toBeGreaterThan(0);
			expect(market.nameZh.trim().length).toBeGreaterThan(0);
			expect(market.description.trim().length).toBeGreaterThan(0);
			expect(market.descriptionZh.trim().length).toBeGreaterThan(0);
			expect(market.url.startsWith("https://")).toBe(true);
			expect(() => new URL(market.url)).not.toThrow();
			expect(validCategories.has(market.category)).toBe(true);
			if (market.tags) {
				expect(Array.isArray(market.tags)).toBe(true);
				for (const tag of market.tags) {
					expect(tag.trim().length).toBeGreaterThan(0);
				}
			}
		}
	});
});
