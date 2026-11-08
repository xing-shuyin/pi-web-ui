// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import { ModelConfigModal } from "../../web/src/components/ModelConfigModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";

type ModalProps = Parameters<typeof ModelConfigModal>[0];
let root: Root | null = null;

const customProvider = {
	providerId: "test-provider",
	name: "Test Provider",
	baseUrl: "https://example.test/v1",
	models: [],
};

const builtinProvider = {
	id: "builtin-provider",
	name: "Builtin Provider",
	configured: false,
	supportsApiKey: true,
	supportsOAuth: false,
	usingOAuth: false,
};

function mount(overrides: Partial<ModalProps> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const closed: number[] = [];
	const sent: unknown[] = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	root = createRoot(container);
	let props: ModalProps = {
		providers: [customProvider],
		providerStatus: [builtinProvider],
		providerKeys: {},
		providerOAuthFlows: [],
		providerOAuthResults: {},
		onClose: () => closed.push(1),
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
		closed,
		sent,
		render,
		unmount() {
			act(() => root!.unmount());
			root = null;
			container.remove();
		},
	};
}

function activeNavLabel(container: HTMLElement): string | null {
	return container.querySelector(".studio-nav-item.active .studio-nav-label")?.textContent ?? null;
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

describe("provider detail close button", () => {
	it("closes the custom provider card into the overview instead of the whole modal", () => {
		const modal = mount();
		expect(modal.container.querySelector(".studio-empty-card")).toBeNull();

		const close = modal.container.querySelector(".studio-card-head .studio-card-close") as HTMLButtonElement;
		expect(close).not.toBeNull();
		act(() => close.click());

		expect(modal.container.querySelector(".studio-empty-card")).not.toBeNull();
		expect(modal.container.querySelector(".form-grid")).toBeNull();
		expect(activeNavLabel(modal.container)).toBeNull();
		expect(modal.closed).toHaveLength(0);

		modal.unmount();
	});

	it("closes the builtin provider card as well", () => {
		const modal = mount();
		const navItems = Array.from(modal.container.querySelectorAll(".studio-nav-item"));
		const builtinNav = navItems.find((item) => item.textContent?.includes("Builtin Provider")) as HTMLElement;
		act(() => builtinNav.click());
		expect(modal.container.querySelector(".provider-keys")).not.toBeNull();

		const close = modal.container.querySelector(".studio-card-head .studio-card-close") as HTMLButtonElement;
		act(() => close.click());

		expect(modal.container.querySelector(".provider-keys")).toBeNull();
		expect(modal.container.querySelector(".studio-empty-card")).not.toBeNull();
		expect(modal.closed).toHaveLength(0);

		modal.unmount();
	});

	it("reopens the new provider form from the overview", () => {
		const modal = mount();
		act(() => (modal.container.querySelector(".studio-card-head .studio-card-close") as HTMLButtonElement).click());

		const addButton = modal.container.querySelector(".studio-empty-card button") as HTMLButtonElement;
		expect(addButton).not.toBeNull();
		act(() => addButton.click());

		expect(modal.container.querySelector(".studio-empty-card")).toBeNull();
		expect(modal.container.querySelector(".form-grid")).not.toBeNull();
		const title = modal.container.querySelector(".studio-card-title")?.textContent ?? "";
		expect(title).not.toContain("test-provider");
		const providerIdInput = modal.container.querySelector(".form-grid input") as HTMLInputElement;
		expect(providerIdInput.value).toBe("");

		modal.unmount();
	});
});
