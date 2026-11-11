import { describe, expect, it } from "vitest";
import type { ClientStateStore, MarkerSettings } from "../../server/client-state.js";
import { MarkerService, type MarkerHost } from "../../server/marker-service.js";
import { getMarker } from "../../server/markers/index.js";

const DEFAULT_SETTINGS: MarkerSettings = { disabledMarkers: [] };

function makeService(lang: string | undefined): MarkerService {
	const host = {
		clientId: "test-client",
		stateStore: {
			getMarkerSettings: () => DEFAULT_SETTINGS,
		} as unknown as ClientStateStore,
		emit: () => {},
		isDisposed: () => false,
		getActiveConversationId: () => "conv-1",
		getSessionManager: () => undefined,
		renameConversation: () => {},
		refreshMarkers: () => {},
		lang: lang === undefined ? undefined : () => lang,
	} satisfies MarkerHost;
	return new MarkerService(host);
}

describe("MarkerService.listForUi 语言感知", () => {
	it("guidance 走 getGuidance(lang)（回退静态值）", () => {
		for (const lang of ["en", "zh", "pt", "ja"]) {
			const entries = makeService(lang).listForUi();
			expect(entries.length).toBeGreaterThan(0);
			for (const entry of entries) {
				const m = getMarker(entry.name);
				expect(m).toBeDefined();
				expect(entry.guidance).toEqual(m?.getGuidance?.(lang) ?? m?.guidance);
			}
		}
	});

	it("英文界面下发英文 guidance（不再恒为中文）", () => {
		const en = makeService("en").listForUi();
		const zh = makeService("zh").listForUi();
		const enAction = en.find((e) => e.name === "action")?.guidance.join("\n") ?? "";
		const zhAction = zh.find((e) => e.name === "action")?.guidance.join("\n") ?? "";
		expect(enAction).not.toEqual(zhAction);
		expect(zhAction).toMatch(/[\u4e00-\u9fff]/);
		expect(enAction).not.toMatch(/[\u4e00-\u9fff]/);
	});

	it("未接线 lang 时回退英文默认（非中文静态值）", () => {
		const entries = makeService(undefined).listForUi();
		const action = entries.find((e) => e.name === "action")?.guidance.join("\n") ?? "";
		expect(action).not.toMatch(/[\u4e00-\u9fff]/);
	});
});
