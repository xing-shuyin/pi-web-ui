// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUiSlots, type UiPluginInfo } from "../../web/src/ui-slots";
import { GroupWorkspaceActions } from "../../web/src/components/GroupWorkspaceActions";
import { LanguageProvider } from "../../web/src/i18n";

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("Group UI Slots Real Rendering & Isolation", () => {
	const fakePlugin: UiPluginInfo = {
		id: "sample-plugin",
		name: "Sample Extension",
		version: "1.0.0",
		hasClient: true,
		ui: {
			items: [
				{
					id: "export-stats",
					slot: "device.group.actions",
					label: "导出群统计",
					kind: "action",
					order: 5,
				},
				{
					id: "group-audit",
					slot: "device.group.header",
					label: "审计群配置",
					kind: "action",
					order: 10,
				},
				{
					id: "workspace-metrics",
					slot: "device.group.workspace",
					label: "任务指标监控",
					kind: "action",
					order: 1,
				},
			],
			arrange: [],
		},
	};

	it("correctly computes entries for all three device.group.* slots in buildUiSlots", () => {
		const slots = buildUiSlots([fakePlugin], {
			locale: "zh",
			t: (k) => k,
		});

		expect(slots["device.group.actions"]).toHaveLength(1);
		expect(slots["device.group.actions"][0].label).toBe("导出群统计");

		expect(slots["device.group.header"]).toHaveLength(1);
		expect(slots["device.group.header"][0].label).toBe("审计群配置");

		expect(slots["device.group.workspace"]).toHaveLength(1);
		expect(slots["device.group.workspace"][0].label).toBe("任务指标监控");
	});

	it("renders device.group.actions slot items in GroupWorkspaceActions and triggers onUiAction", async () => {
		const slots = buildUiSlots([fakePlugin], {
			locale: "zh",
			t: (k) => k,
		});

		const onUiActionMock = vi.fn();

		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);

		await act(async () => {
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(GroupWorkspaceActions, {
						roomId: "room-test",
						uiSlotEntries: slots["device.group.actions"],
						onUiAction: onUiActionMock,
					}),
				),
			);
		});

		const slotBtn = host.querySelector<HTMLButtonElement>(".group-slot-btn");
		expect(slotBtn).not.toBeNull();
		expect(slotBtn?.textContent).toBe("导出群统计");

		await act(async () => {
			slotBtn?.click();
		});

		expect(onUiActionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "sample-plugin:export-stats",
				label: "导出群统计",
			}),
		);

		act(() => root.unmount());
		host.remove();
	});
});
