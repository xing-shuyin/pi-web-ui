// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountGenView } from "../../plugins/image-toolkit/client/gen-view.mjs";

vi.mock("../../plugins/image-toolkit/client/gen-api.mjs", () => ({
	getConfig: async () => ({
		config: { services: [], outputDir: "generated" },
		shapes: [],
		presets: [],
		jobs: [{ id: "job1", status: "done", prompt: "Sample", files: [{ path: "generated/sample.png" }] }],
	}),
	imageUrl: (path: string) => `/api/image?path=${encodeURIComponent(path)}`,
}));
let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	document.body.replaceChildren();
	delete (window as any).__piWebUiHost;
	vi.restoreAllMocks();
});

describe("image studio shared preview", () => {
	it("routes a generated image to the host preview and preserves editing and reference actions", async () => {
		const openImagePreview = vi.fn((_target: any) => true);
		(window as any).__piWebUiHost = { openImagePreview };
		const container = document.createElement("div");
		document.body.append(container);
		const edit = vi.fn();
		const view = mountGenView(container, { getLang: () => "zh", onOpenInToolkit: edit });
		cleanup = view.unmount;
		await view.load();
		(container.querySelector(".ig-tile-hover button") as HTMLButtonElement).click();
		const target = openImagePreview.mock.calls[0]?.[0] as any;
		expect(target).toMatchObject({ src: "/api/image?path=generated%2Fsample.png", alt: "sample.png" });
		expect(target.actions.map((action: any) => action.id)).toEqual(["edit", "reference", "copy", "download"]);
		target.actions[0].onSelect();
		expect(edit).toHaveBeenCalledWith({ path: "generated/sample.png", url: target.src });
		target.actions[1].onSelect();
		expect(container.querySelector(".ig-refchip")?.getAttribute("title")).toBe("generated/sample.png");
		expect(container.querySelector(".ig-lightbox")).toBeNull();
	});
	it("opens the original image on older hosts instead of maintaining another lightbox", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const container = document.createElement("div");
		document.body.append(container);
		const view = mountGenView(container, { getLang: () => "zh" });
		cleanup = view.unmount;
		await view.load();
		(container.querySelector(".ig-tile-hover button") as HTMLButtonElement).click();
		expect(open).toHaveBeenCalledWith("/api/image?path=generated%2Fsample.png", "_blank", "noopener,noreferrer");
	});
});
