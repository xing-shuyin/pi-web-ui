import type { BrowserDesignDocument, BrowserDesignKind, BrowserDesignStatus } from "../contracts.js";
import { parseDesignKind } from "../runtime/customize.js";

/**
 * 自定义新标签页 / 主题的自动化入口（`browser_design` 工具 → `design.*` 页面调用）。
 *
 * 与 `script.*` 同一层：归属浏览器外壳而不是某个网页，所以不参与「选目标标签」那套解析；
 * 四个动作都是纯宿主操作，只有 preview 需要一块可见的页面（Electron 藏起来的视图截不到图）。
 */
export const BROWSER_DESIGN_ACTIONS = ["status", "get", "save", "reset", "preview"] as const;
export type BrowserDesignAction = (typeof BROWSER_DESIGN_ACTIONS)[number];

export interface BrowserDesignPreview {
	kind: string;
	url: string;
	image: { dataUrl: string; mimeType: string; width?: number; height?: number };
}

export interface BrowserDesignHost {
	designStatus(): BrowserDesignStatus[];
	designDocument(kind: BrowserDesignKind): BrowserDesignDocument;
	saveDesign(kind: BrowserDesignKind, content: unknown): BrowserDesignStatus;
	resetDesign(kind: BrowserDesignKind): BrowserDesignStatus;
	previewDesign(kind: BrowserDesignKind): Promise<BrowserDesignPreview>;
}

export async function runDesignOperation(
	host: BrowserDesignHost,
	action: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const kind = parseDesignKind(args.kind ?? "newtab");
	switch (action) {
		case "status":
			return host.designStatus();
		case "get":
			return host.designDocument(kind);
		case "save":
			return host.saveDesign(kind, args.content);
		case "reset":
			return host.resetDesign(kind);
		case "preview":
			return host.previewDesign(kind);
		default:
			throw new Error("Unsupported browser design action: " + (action || "(empty)"));
	}
}
