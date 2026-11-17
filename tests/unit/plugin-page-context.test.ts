import { describe, expect, it, vi } from "vitest";
import { makePluginContext } from "../../web/src/plugin-loader";

/**
 * 守卫：插件页上下文里的 `page` 契约。
 *
 * `ui.settings` 声明的每一页在「设置 → 插件 → 安装的插件 → 详情」里各占一个标签，
 * 宿主把该页的 itemId 通过 `ctx.page` 交给插件；没声明页的插件走通用「插件页」标签，
 * 此时 `ctx.page` 必须是 undefined（否则插件无法区分「通用页」与「某一页」）。
 */
describe("makePluginContext 的 page 契约", () => {
	it("不给 page 时不带这个字段（通用插件页）", () => {
		const ctx = makePluginContext("demo", () => {});
		expect("page" in ctx).toBe(false);
		expect(ctx.pluginId).toBe("demo");
	});

	it("给了 page 就透传成 ctx.page（声明页各自的 itemId）", () => {
		const ctx = makePluginContext("demo", () => {}, { page: "conf" });
		expect(ctx.page).toBe("conf");
	});

	it("send 仍然只投递到自己的 pluginId", () => {
		const send = vi.fn();
		const ctx = makePluginContext("demo", send, { page: "conf" });
		ctx.send({ type: "ping" });
		expect(send).toHaveBeenCalledWith({ type: "plugin_message", pluginId: "demo", payload: { type: "ping" } });
	});
});
