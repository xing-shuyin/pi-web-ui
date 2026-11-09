import { describe, expect, it, vi } from "vitest";
import { handlePluginMessage, type PluginDispatchContext } from "../../server/dispatch-plugin-handlers.js";
import type { ServerMessage } from "../../server/protocol.js";
import type { PluginInstaller } from "../../server/plugin-installer.js";
import type { PluginManager } from "../../server/plugins.js";

interface Hooks {
	done(ok: boolean, info: { error?: string; output: string }): void | Promise<void>;
	emit(msg: ServerMessage): void;
}

/** 只走「不必确认授权」的快路径：把 CLI 作业假体化，直接回调 done。 */
function makeCtx(opts: {
	action: "install" | "update" | "uninstall";
	ok: boolean;
	enable?: (id: string) => Promise<boolean>;
	order?: string[];
}) {
	const sent: ServerMessage[] = [];
	const installer = {
		start: (spec: { id: string }, hooks: Hooks) => {
			opts.order?.push("start");
			// 与真实 installer 的 finish() 一致：先发 done 消息，再回调 hooks.done
			hooks.emit({
				type: "plugin_job",
				jobId: "j1",
				action: opts.action,
				pluginId: spec.id,
				phase: "done",
				ok: opts.ok,
				output: "tail",
			});
			void Promise.resolve(hooks.done(opts.ok, { output: "tail" }));
			return { ok: true };
		},
	} as unknown as PluginInstaller;
	const ctx = {
		pluginMgr: { permGrants: { has: () => true } } as unknown as PluginManager,
		pluginInstaller: installer,
		cs: {
			getLang: () => "zh",
			emitNotice: () => {},
			...(opts.enable
				? {
						enableInstalledPlugin: (id: string) => {
							opts.order?.push(`enable:${id}`);
							return opts.enable!(id);
						},
					}
				: {}),
		},
		clientId: "c1",
		send: (m: ServerMessage) => sent.push(m),
		dataDir: "/data",
		cwd: "/work",
		clients: [],
		pendingPathRequests: new Map(),
		pendingPermissionRequests: new Map(),
		pendingDomConsents: new Map(),
		findDomConsentById: () => undefined,
		applyDomConsent: () => {},
		pushPluginGrants: () => {},
		pushPluginPermissions: () => {},
		reloadPluginsAndPush: async () => {
			opts.order?.push("reload");
		},
		confirmPluginInstallHelper: async () => true,
	} as unknown as PluginDispatchContext;
	return { ctx, sent };
}

async function run(opts: Parameters<typeof makeCtx>[0]) {
	const { ctx, sent } = makeCtx(opts);
	const handled = handlePluginMessage(
		{
			type: "plugin_job",
			jobId: "j1",
			action: opts.action,
			id: "run-trace",
			source: "xing-shuyin/pi-web-ui/plugins/run-trace",
		} as never,
		ctx,
	);
	expect(handled).toBe(true);
	await vi.waitFor(() => {
		expect(sent.some((m) => m.type === "plugin_job" && m.phase === "done")).toBe(true);
	});
	return sent;
}

describe("plugin_job 安装即启用", () => {
	it("install 成功：先摘 disabledPlugins 再重载插件列表", async () => {
		const order: string[] = [];
		const enable = vi.fn(async () => true);
		const sent = await run({ action: "install", ok: true, enable, order });
		expect(enable).toHaveBeenCalledWith("run-trace");
		expect(order).toEqual(["start", "enable:run-trace", "reload"]);
		const done = sent.find((m) => m.type === "plugin_job" && m.phase === "done");
		expect(done).toMatchObject({ ok: true });
	});

	it("update 成功不重新启用：用户主动禁用的插件升级后保持禁用", async () => {
		const enable = vi.fn(async () => true);
		await run({ action: "update", ok: true, enable });
		expect(enable).not.toHaveBeenCalled();
	});

	it("install 失败不碰设置", async () => {
		const enable = vi.fn(async () => true);
		const sent = await run({ action: "install", ok: false, enable });
		expect(enable).not.toHaveBeenCalled();
		const done = sent.find((m) => m.type === "plugin_job" && m.phase === "done");
		expect(done).toMatchObject({ ok: false });
	});

	it("启用写盘抛错不影响作业收尾：仍然重载并回成功回执", async () => {
		const order: string[] = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sent = await run({
			action: "install",
			ok: true,
			enable: async () => {
				throw new Error("disk full");
			},
			order,
		});
		expect(order).toEqual(["start", "enable:run-trace", "reload"]);
		expect(sent.find((m) => m.type === "plugin_job" && m.phase === "done")).toMatchObject({ ok: true });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
