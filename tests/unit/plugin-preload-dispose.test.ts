import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../web/src/base-url", () => ({
	appUrl(path: string) {
		const code = `globalThis.__preloadStarts = (globalThis.__preloadStarts ?? 0) + 1;
if (globalThis.__preloadGate) await globalThis.__preloadGate;
export default { dispose() { globalThis.__preloadDisposes = (globalThis.__preloadDisposes ?? 0) + 1; } };`;
		return `data:text/javascript,${encodeURIComponent(code)}#${path}`;
	},
}));
vi.mock("../../web/src/mobile-runtime", () => ({ isMobileRuntime: () => false }));

beforeEach(() => {
	vi.resetModules();
	(globalThis as any).__preloadStarts = 0;
	(globalThis as any).__preloadDisposes = 0;
	(globalThis as any).__preloadGate = undefined;
});

const plugin = { id: "hongguo-preload", name: "Test player", hasClient: true, view: false, preload: true };
describe("preloaded plugin disposal", () => {
	it("cleans up on disable and allows activation again in the same epoch", async () => {
		const loader = await import("../../web/src/plugin-loader");
		await loader.syncPluginViews([plugin], 9901);
		expect((globalThis as any).__preloadStarts).toBe(1);
		await loader.syncPluginViews([], 9901);
		expect((globalThis as any).__preloadDisposes).toBe(1);
		await loader.syncPluginViews([], 9901);
		expect((globalThis as any).__preloadDisposes).toBe(1);
		await loader.syncPluginViews([plugin], 9901);
		expect((globalThis as any).__preloadStarts).toBe(2);
		await loader.syncPluginViews([], 9901);
	});
	it("cleans up a late import when the plugin was disabled while it loaded", async () => {
		let release!: () => void;
		(globalThis as any).__preloadGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loader = await import("../../web/src/plugin-loader");
		const loading = loader.syncPluginViews([plugin], 9921);
		await vi.waitFor(() => expect((globalThis as any).__preloadStarts).toBe(1));
		await loader.syncPluginViews([], 9921);
		release();
		await loading;
		expect((globalThis as any).__preloadDisposes).toBe(1);
	});
	it("cleans up the previous runtime when the plugin reload epoch changes", async () => {
		const loader = await import("../../web/src/plugin-loader");
		await loader.syncPluginViews([plugin], 9911);
		await loader.syncPluginViews([plugin], 9912);
		expect((globalThis as any).__preloadDisposes).toBe(1);
		expect((globalThis as any).__preloadStarts).toBe(2);
		await loader.syncPluginViews([], 9912);
	});
});
