import { describe, expect, it } from "vitest";
import {
	LeftPanelRunningStore,
	PANEL_ITEM_CAP,
	PANEL_TTL_DEFAULT_MS,
	PANEL_TTL_MAX_MS,
	PANEL_TTL_MIN_MS,
	clampPanelTtl,
	sanitizePanelItems,
} from "../../server/left-panel-running.js";

function clock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("sanitizePanelItems（清洗）", () => {
	it("合法条目原样保留，缺省 status=running", () => {
		const { items, diags } = sanitizePanelItems([
			{ id: "a", title: "同步邮件", hint: "3/10", icon: "📬", action: "mail:open" },
		]);
		expect(diags).toEqual([]);
		expect(items).toEqual([
			{ id: "a", title: "同步邮件", hint: "3/10", icon: "📬", action: "mail:open", status: "running" },
		]);
	});

	it("缺 id / 非对象 → 丢弃并给诊断（不抛错）", () => {
		const { items, diags } = sanitizePanelItems([null, "x", { title: "无 id" }, { id: "   " }]);
		expect(items).toEqual([]);
		expect(diags).toHaveLength(4);
	});

	it("title 缺省回落 id；空白 title 也回落", () => {
		const { items } = sanitizePanelItems([{ id: "job-1" }, { id: "job-2", title: "   " }]);
		expect(items.map((i) => i.title)).toEqual(["job-1", "job-2"]);
	});

	it("重复 id：后者丢弃并诊断", () => {
		const { items, diags } = sanitizePanelItems([
			{ id: "x", title: "first" },
			{ id: "x", title: "second" },
		]);
		expect(items).toHaveLength(1);
		expect(items[0]!.title).toBe("first");
		expect(diags.some((d) => /duplicate id "x"/.test(d))).toBe(true);
	});

	it("非法 status：按 running 处理并诊断；合法三值照收", () => {
		const { items, diags } = sanitizePanelItems([
			{ id: "a", status: "done" },
			{ id: "b", status: "bogus" },
			{ id: "c", status: "error" },
		]);
		expect(items.map((i) => i.status)).toEqual(["done", "running", "error"]);
		expect(diags.some((d) => /unknown status/.test(d))).toBe(true);
	});

	it("超过上限：截到 PANEL_ITEM_CAP 条，之后的丢弃并诊断", () => {
		const raw = Array.from({ length: PANEL_ITEM_CAP + 5 }, (_, i) => ({ id: `i${i}` }));
		const { items, diags } = sanitizePanelItems(raw);
		expect(items).toHaveLength(PANEL_ITEM_CAP);
		expect(diags.some((d) => /capped at/.test(d))).toBe(true);
	});

	it("长度截断：id≤96、title≤200、hint≤200、icon≤8、action≤96", () => {
		const { items } = sanitizePanelItems([
			{
				id: "i".repeat(200),
				title: "t".repeat(500),
				hint: "h".repeat(500),
				icon: "🔥".repeat(20),
				action: "a".repeat(300),
			},
		]);
		const it = items[0]!;
		expect(it.id.length).toBe(96);
		expect(it.title.length).toBe(200);
		expect(it.hint!.length).toBe(200);
		expect(it.icon!.length).toBeLessThanOrEqual(8);
		expect(it.action!.length).toBe(96);
	});

	it("items 不是数组 → 整体忽略并诊断", () => {
		const { items, diags } = sanitizePanelItems({ id: "x" });
		expect(items).toEqual([]);
		expect(diags).toHaveLength(1);
	});
});

describe("clampPanelTtl（TTL 夹取）", () => {
	it("缺省 / 非数字 → 默认 60 秒", () => {
		expect(clampPanelTtl(undefined)).toBe(PANEL_TTL_DEFAULT_MS);
		expect(clampPanelTtl("abc")).toBe(PANEL_TTL_DEFAULT_MS);
		expect(clampPanelTtl(Number.NaN)).toBe(PANEL_TTL_DEFAULT_MS);
	});

	it("夹进 [5s, 1h]", () => {
		expect(clampPanelTtl(1)).toBe(PANEL_TTL_MIN_MS);
		expect(clampPanelTtl(10 ** 12)).toBe(PANEL_TTL_MAX_MS);
		expect(clampPanelTtl(30_000)).toBe(30_000);
	});
});

describe("LeftPanelRunningStore", () => {
	it("set 返回 changed=true；内容完全相同的重复 set（心跳）返回 changed=false", () => {
		const c = clock();
		const s = new LeftPanelRunningStore(c.now);
		const items = [{ id: "a", title: "A" }];
		expect(s.set("p", "P", items).changed).toBe(true);
		c.advance(10_000);
		expect(s.set("p", "P", items).changed).toBe(false);
	});

	it("心跳会刷新过期时钟：每 TTL 内都调用就不会过期", () => {
		const c = clock();
		const s = new LeftPanelRunningStore(c.now);
		s.set("p", "P", [{ id: "a" }], { ttlMs: 10_000 });
		for (let i = 0; i < 5; i++) {
			c.advance(8_000);
			s.set("p", "P", [{ id: "a" }], { ttlMs: 10_000 });
			expect(s.sweep()).toEqual([]);
		}
		expect(s.size).toBe(1);
	});

	it("超过 TTL 没有心跳 → sweep 清掉整组并返回插件 id", () => {
		const c = clock();
		const s = new LeftPanelRunningStore(c.now);
		s.set("p", "P", [{ id: "a" }], { ttlMs: 10_000 });
		c.advance(10_001);
		expect(s.sweep()).toEqual(["p"]);
		expect(s.groups()).toEqual([]);
	});

	it("空列表 set 等同 clear：changed 反映是否真删了东西", () => {
		const s = new LeftPanelRunningStore(() => 0);
		expect(s.set("p", "P", []).changed).toBe(false);
		s.set("p", "P", [{ id: "a" }]);
		expect(s.set("p", "P", []).changed).toBe(true);
		expect(s.size).toBe(0);
	});

	it("clear 返回是否删除；groups 按插件 id 排序、空组不出现、返回副本", () => {
		const s = new LeftPanelRunningStore(() => 0);
		s.set("zeta", "Zeta", [{ id: "z1" }]);
		s.set("alpha", "Alpha", [{ id: "a1", title: "α" }]);
		const groups = s.groups();
		expect(groups.map((g) => g.pluginId)).toEqual(["alpha", "zeta"]);
		expect(groups[0]).toEqual({
			pluginId: "alpha",
			pluginName: "Alpha",
			items: [{ id: "a1", title: "α", status: "running" }],
		});
		groups[0]!.items[0]!.title = "被改";
		expect(s.groups()[0]!.items[0]!.title).toBe("α");
		expect(s.clear("zeta")).toBe(true);
		expect(s.clear("zeta")).toBe(false);
		expect(s.groups().map((g) => g.pluginId)).toEqual(["alpha"]);
	});
});
