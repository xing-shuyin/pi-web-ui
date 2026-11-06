// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import { ModelConfigModal } from "../../web/src/components/ModelConfigModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { ClientMessage } from "../../web/src/types.js";

type ModalProps = Parameters<typeof ModelConfigModal>[0];
type FetchResult = NonNullable<ModalProps["fetchModelsResult"]>;
let root: Root | null = null;

const models = [{ id: "discovered-model", name: "Discovered model" }];

function mount(overrides: Partial<ModalProps> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: ClientMessage[] = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	root = createRoot(container);
	let props: ModalProps = {
		providers: [
			{
				providerId: "test-provider",
				baseUrl: "https://example.test/v1",
				models: [],
			},
		],
		providerStatus: [],
		providerKeys: {},
		providerOAuthFlows: [],
		providerOAuthResults: {},
		onClose: () => {},
		...overrides,
	};
	const render = (patch: Partial<ModalProps> = {}) => {
		props = { ...props, ...patch };
		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(ModelConfigModal, props)));
		});
	};
	render();
	return {
		container,
		render,
		fetch() {
			const button = container.querySelector(".model-section-actions button") as HTMLButtonElement;
			expect(button.disabled).toBe(false);
			act(() => button.click());
			const request = sent.filter((message) => message.type === "fetch_models").at(-1);
			expect(request).toBeDefined();
			return request!.reqId;
		},
		unmount() {
			act(() => root!.unmount());
			root = null;
			container.remove();
		},
	};
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	setAppSend(null);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("model discovery result ownership", () => {
	it("does not replay a cached result when opening provider management", () => {
		const { container } = mount({ fetchModelsResult: { reqId: 1, ok: true, models } });
		expect(container.querySelector(".candidate-picker-modal")).toBeNull();
		expect(container.querySelector(".fetch-msg")).toBeNull();
	});

	it.each(["cancel", "adopt"])("does not reopen candidates after %s and reopening management", (action) => {
		const modal = mount();
		const result: FetchResult = { reqId: modal.fetch(), ok: true, models };
		modal.render({ fetchModelsResult: result });
		expect(modal.container.querySelector(".candidate-picker-modal")).not.toBeNull();

		const button = modal.container.querySelector(
			action === "adopt" ? ".candidate-actions-footer .primary" : ".candidate-actions-footer .btn:not(.primary)",
		) as HTMLButtonElement;
		act(() => button.click());
		expect(modal.container.querySelector(".candidate-picker-modal")).toBeNull();
		modal.render({ fetchModelsResult: { ...result } });
		expect(modal.container.querySelector(".candidate-picker-modal")).toBeNull();

		modal.unmount();
		const reopened = mount({ fetchModelsResult: result });
		expect(reopened.container.querySelector(".candidate-picker-modal")).toBeNull();
		const nextReqId = reopened.fetch();
		expect(nextReqId).not.toBe(result.reqId);
		reopened.render({ fetchModelsResult: { ...result, reqId: nextReqId } });
		expect(reopened.container.querySelector(".candidate-picker-modal")).not.toBeNull();
	});

	it("ignores a previous mount's late response while a new probe is pending", () => {
		vi.spyOn(Date, "now").mockReturnValue(1700000000000);
		const previous = mount();
		const oldReqId = previous.fetch();
		previous.unmount();
		const reopened = mount();
		const reqId = reopened.fetch();
		expect(reqId).not.toBe(oldReqId);
		reopened.render({ fetchModelsResult: { reqId: oldReqId, ok: true, models } });
		expect(reopened.container.querySelector(".candidate-picker-modal")).toBeNull();
		expect((reopened.container.querySelector(".model-section-actions button") as HTMLButtonElement).disabled).toBe(
			true,
		);
		reopened.render({ fetchModelsResult: { reqId, ok: true, models } });
		expect(reopened.container.querySelector(".candidate-picker-modal")).not.toBeNull();
	});

	it("ignores a late response when the reopened window has not requested models", () => {
		const previous = mount();
		const reqId = previous.fetch();
		previous.unmount();
		const reopened = mount();
		reopened.render({ fetchModelsResult: { reqId, ok: true, models } });
		expect(reopened.container.querySelector(".candidate-picker-modal")).toBeNull();
	});

	it.each([
		{ ok: false, error: "probe failed" },
		{ ok: true, models: [] },
	])("allows retry after a failed or empty result: %j", (response) => {
		const modal = mount();
		const reqId = modal.fetch();
		modal.render({ fetchModelsResult: { reqId, ...response } });
		expect(modal.container.querySelector(".candidate-picker-modal")).toBeNull();
		expect(modal.container.querySelector(".fetch-msg.err")).not.toBeNull();
		const retryReqId = modal.fetch();
		expect(retryReqId).not.toBe(reqId);
		modal.render({ fetchModelsResult: { reqId: retryReqId, ok: true, models } });
		expect(modal.container.querySelector(".candidate-picker-modal")).not.toBeNull();
	});
});
