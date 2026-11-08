// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_CATALOG } from "../../server/engine-catalog";
import { BarItem } from "../../web/src/components/BarItem";
import {
	NativeCliCreateEntry,
	NativeCliCreateModal,
	type NativeCliCreateModalProps,
} from "../../web/src/components/NativeCliCreateModal";
import { BUILTIN_UI_ITEMS } from "../../web/src/ui-slots";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals";

let root: Root;
let container: HTMLDivElement;
let props: NativeCliCreateModalProps;
const mount = (node: ReactNode) => act(() => root.render(node));
const renderModal = (updates: Partial<NativeCliCreateModalProps> = {}) => {
	props = { ...props, ...updates };
	mount(createElement(NativeCliCreateModal, props));
};
const option = (name: string) =>
	Array.from(document.querySelectorAll<HTMLButtonElement>(".native-cli-create-option")).find(
		(button) => button.querySelector("strong")?.textContent === name,
	)!;
const click = (button: HTMLButtonElement) => act(() => button.click());
const input = (selector: string, value: string) => {
	const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
	const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	act(() => {
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const submit = () =>
	act(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const remoteCwd = "ssh://alice@build.example:2222/home/alice/project space";
const discoveryResponse = (cwd = remoteCwd) => ({
	target: "ssh",
	cwd,
	clis: [
		{ preset: "claude", available: true, executable: "/home/alice/.local/bin/claude" },
		{ preset: "codex", available: false, error: "codex: command not found on remote host" },
	],
});
const localDiscovery = (clis?: Array<Record<string, unknown>>) => ({
	target: "local",
	cwd: "/project",
	clis:
		clis ??
		Object.values(ENGINE_CATALOG)
			.filter((engine) => engine.cliCommand)
			.map((engine) => ({ preset: engine.id, available: true, executable: `/usr/local/bin/${engine.id}` })),
});
const flush = () => act(async () => {});
const retry = () => click(document.querySelector<HTMLButtonElement>(".native-cli-create-body button.btn")!);

beforeEach(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	resetAppGlobals();
	vi.stubGlobal("fetch", vi.fn());
	vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(localDiscovery())));
	localStorage.setItem("pi-web-ui:lang", "en");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	props = { cwd: "/project", onClose: vi.fn(), onCreate: vi.fn() };
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	resetAppGlobals();
});

describe("SSH CLI persistence selection", () => {
	const checkbox = () => document.querySelector<HTMLInputElement>('.native-cli-persistence input[type="checkbox"]');
	it("hides keep-alive for local creation", () => {
		renderModal();
		expect(checkbox()).toBeNull();
	});
	it("requires positive tmux capability detection and explicit opt-in", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ ...discoveryResponse(), persistence: { available: true } })),
		);
		renderModal({ cwd: remoteCwd });
		expect(checkbox()?.disabled).toBe(true);
		await flush();
		expect(checkbox()?.disabled).toBe(false);
		expect(checkbox()?.checked).toBe(false);
		click(option(ENGINE_CATALOG.claude.name));
		expect(props.onCreate).toHaveBeenLastCalledWith({ preset: "claude" });
		act(() => checkbox()!.click());
		click(option(ENGINE_CATALOG.claude.name));
		expect(props.onCreate).toHaveBeenLastCalledWith({ preset: "claude", keepAlive: true });
		click(option("Custom CLI"));
		input(".native-cli-create-config input", "/opt/custom/agent");
		input("textarea", "--project\n/path with spaces");
		submit();
		expect(props.onCreate).toHaveBeenLastCalledWith({
			preset: "custom",
			executable: "/opt/custom/agent",
			args: ["--project", "/path with spaces"],
			keepAlive: true,
		});
	});
	it("shows unavailable tmux reasons and never sends a false keep-alive promise", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					...discoveryResponse(),
					persistence: { available: false, error: "tmux: not found on remote host" },
				}),
			),
		);
		renderModal({ cwd: remoteCwd });
		await flush();
		expect(checkbox()?.disabled).toBe(true);
		expect(document.querySelector(".native-cli-persistence")?.textContent).toContain("tmux: not found on remote host");
		act(() => checkbox()!.click());
		click(option(ENGINE_CATALOG.claude.name));
		expect(props.onCreate).toHaveBeenCalledExactlyOnceWith({ preset: "claude" });
	});
	it("treats legacy discovery as unavailable and clears selection before re-detecting", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(new Response(JSON.stringify({ ...discoveryResponse(), persistence: { available: true } })))
			.mockResolvedValueOnce(new Response(JSON.stringify(discoveryResponse())));
		renderModal({ cwd: remoteCwd });
		await flush();
		act(() => checkbox()!.click());
		expect(checkbox()?.checked).toBe(true);
		retry();
		expect(checkbox()?.checked).toBe(false);
		expect(checkbox()?.disabled).toBe(true);
		await flush();
		expect(checkbox()?.disabled).toBe(true);
		click(option(ENGINE_CATALOG.claude.name));
		expect(props.onCreate).toHaveBeenLastCalledWith({ preset: "claude" });
	});
});

describe("native CLI creation", () => {
	it("offers every executable catalog engine and starts parameter-free choices immediately", async () => {
		renderModal();
		await flush();
		const engines = Object.values(ENGINE_CATALOG).filter((engine) => engine.cliCommand);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/native-cli/discovery?cwd=%2Fproject", {
			signal: expect.any(AbortSignal),
		});
		expect(document.querySelectorAll(".native-cli-create-option")).toHaveLength(engines.length + 1);
		expect(
			Array.from(document.querySelectorAll(".native-cli-create-option strong"))
				.slice(0, 3)
				.map((element) => element.textContent),
		).toEqual(["Claude Code", "Codex", "Pi"]);
		for (const engine of engines) {
			expect(option(engine.name)).toBeDefined();
			expect(option(engine.name).disabled).toBe(false);
			if (engine.cliRequiresArgs) continue;
			click(option(engine.name));
			expect(props.onCreate).toHaveBeenLastCalledWith({ preset: engine.id });
		}
		expect(document.querySelector("form")).toBeNull();
		expect(document.querySelector(".native-cli-create-install")).toBeNull();
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it("starts standalone Antigravity and DSH TUIs directly and omits library-only engines", () => {
		renderModal();
		expect(option(ENGINE_CATALOG.durable.name)).toBeUndefined();
		expect(option(ENGINE_CATALOG.dsh.name)).toBeDefined();
		click(option(ENGINE_CATALOG.dsh.name));
		expect(props.onCreate).toHaveBeenCalledWith({ preset: "dsh" });
		click(option(ENGINE_CATALOG.agy.name));
		expect(props.onCreate).toHaveBeenCalledWith({ preset: "agy" });
		expect(document.querySelector("form")).toBeNull();
	});

	it("expands custom executable configuration, rejects blank executables, and returns literal args", () => {
		renderModal();
		click(option("Custom CLI"));
		submit();
		expect(props.onCreate).not.toHaveBeenCalled();
		input(".native-cli-create-config input", "  C:\\Program Files\\tool.exe  ");
		input("textarea", "--name\nhello world\n; echo literal");
		click(document.querySelector('button[type="submit"]')!);
		expect(props.onCreate).toHaveBeenCalledWith({
			preset: "custom",
			executable: "C:\\Program Files\\tool.exe",
			args: ["--name", "hello world", "; echo literal"],
		});
	});

	it("retains custom arguments when a failed immediate launch leaves the modal open", () => {
		renderModal();
		click(option("Custom CLI"));
		input("textarea", "--custom");
		click(option(ENGINE_CATALOG.agy.name));
		click(option("Custom CLI"));
		expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("--custom");
	});

	it("blocks all engine actions while busy", () => {
		renderModal({ disabled: true });
		for (const button of document.querySelectorAll<HTMLButtonElement>(".native-cli-create-option")) {
			expect(button.disabled).toBe(true);
			click(button);
		}
		expect(props.onCreate).not.toHaveBeenCalled();
	});

	it("detects SSH presets only when opened, displays the remote location, and starts available presets directly", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(discoveryResponse())));
		expect(fetch).not.toHaveBeenCalled();
		renderModal({ cwd: remoteCwd });
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(true);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/native-cli/discovery?cwd=${encodeURIComponent(remoteCwd)}`, {
			signal: expect.any(AbortSignal),
		});
		await flush();
		const location = document.querySelector(".native-cli-create-cwd")!;
		expect(location.getAttribute("title")).toBe(remoteCwd);
		expect(location.textContent).toContain("Runs on SSH alice@build.example:2222");
		expect(location.textContent).toContain("Remote directory: /home/alice/project space");
		expect(option(ENGINE_CATALOG.claude.name).textContent).toContain("/home/alice/.local/bin/claude");
		expect(option(ENGINE_CATALOG.codex.name).textContent).toContain("codex: command not found on remote host");
		expect(option(ENGINE_CATALOG.codex.name).disabled).toBe(true);
		expect(option(ENGINE_CATALOG.pi.name).disabled).toBe(true);
		click(option(ENGINE_CATALOG.claude.name));
		expect(props.onCreate).toHaveBeenCalledExactlyOnceWith({ preset: "claude" });
		expect(document.querySelector("form")).toBeNull();
		renderModal({ disabled: true });
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(true);
		expect(option("Custom CLI").disabled).toBe(true);
	});

	it("shows SSH trust errors and retries discovery without enabling undetected presets", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: "SSH host is not trusted" }), { status: 502 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(discoveryResponse())));
		renderModal({ cwd: remoteCwd });
		await flush();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("SSH host is not trusted");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Connect through the SSH workspace flow to trust and connect to this host, then retry.",
		);
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(true);
		retry();
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(true);
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(false);
	});

	it("allows a manually entered remote executable without using any detected local path", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: "SSH not connected" }), { status: 400 }));
		renderModal({ cwd: remoteCwd });
		await flush();
		click(option("Custom CLI"));
		expect(document.querySelector<HTMLInputElement>(".native-cli-create-config input")!.value).toBe("");
		submit();
		expect(props.onCreate).not.toHaveBeenCalled();
		input(".native-cli-create-config input", "  /opt/remote/bin/agent  ");
		input("textarea", "--project\n/path with spaces");
		submit();
		expect(props.onCreate).toHaveBeenCalledExactlyOnceWith({
			preset: "custom",
			executable: "/opt/remote/bin/agent",
			args: ["--project", "/path with spaces"],
		});
	});

	it("aborts on project changes and ignores late results even when switching back to the original SSH cwd", async () => {
		const pending: Array<(response: Response) => void> = [];
		vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
		renderModal({ cwd: remoteCwd });
		click(option("Custom CLI"));
		input(".native-cli-create-config input", "/old/agent");
		const firstSignal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
		renderModal({ cwd: "/local" });
		expect(firstSignal.aborted).toBe(true);
		// The local workspace probes its own CLIs instead of inheriting the SSH result.
		expect(fetch).toHaveBeenCalledTimes(2);
		const localSignal = vi.mocked(fetch).mock.calls[1][1]!.signal!;
		renderModal({ cwd: remoteCwd });
		expect(localSignal.aborted).toBe(true);
		expect(document.querySelector("form")).toBeNull();
		await act(async () => pending[0](new Response(JSON.stringify(discoveryResponse()))));
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(true);
		await act(async () => pending[2](new Response(JSON.stringify(discoveryResponse()))));
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(false);
	});

	it("aborts on close and unmount and ignores responses arriving after close", async () => {
		let resolve!: (response: Response) => void;
		vi.mocked(fetch).mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		renderModal({ cwd: remoteCwd });
		const closeSignal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
		click(document.querySelector<HTMLButtonElement>(".modal-close")!);
		expect(props.onClose).toHaveBeenCalledOnce();
		expect(closeSignal.aborted).toBe(true);
		await act(async () => resolve(new Response(JSON.stringify(discoveryResponse()))));
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(true);
		renderModal({ cwd: `${remoteCwd}/other` });
		const unmountSignal = vi.mocked(fetch).mock.calls[1][1]!.signal!;
		mount(null);
		expect(unmountSignal.aborted).toBe(true);
	});

	it("rejects discovery results for another cwd and allows retry", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(discoveryResponse("ssh://other@host:22/wrong"))));
		renderModal({ cwd: remoteCwd });
		await flush();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Remote CLI detection failed");
		expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(true);
		expect(document.querySelector<HTMLButtonElement>(".native-cli-create-body button.btn")!.disabled).toBe(false);
	});
});

describe("local CLI detection", () => {
	const installButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".native-cli-create-install"));

	it("keeps every engine usable while local detection is still running", () => {
		renderModal();
		expect(document.querySelector('[role="status"]')?.textContent).toContain("Detecting local CLIs…");
		expect(option(ENGINE_CATALOG.codex.name).disabled).toBe(false);
	});

	it("reports missing local CLIs before launch and installs them from a terminal tab", async () => {
		const events: CustomEvent[] = [];
		const onRunCommand = (event: Event) => events.push(event as CustomEvent);
		window.addEventListener("pi-web-ui:plugin-run-command", onRunCommand);
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify(
					localDiscovery([
						{ preset: "claude", available: true, executable: "/usr/local/bin/claude" },
						{ preset: "codex", available: false, error: "Codex CLI executable not found" },
						{ preset: "agy", available: false, error: "Antigravity CLI executable not found" },
					]),
				),
			),
		);
		try {
			renderModal();
			await flush();
			expect(option(ENGINE_CATALOG.claude.name).disabled).toBe(false);
			expect(option(ENGINE_CATALOG.claude.name).textContent).toContain("/usr/local/bin/claude");
			expect(option(ENGINE_CATALOG.codex.name).disabled).toBe(true);
			expect(option(ENGINE_CATALOG.codex.name).textContent).toContain("Not installed");
			expect(installButtons().map((button) => button.textContent)).toEqual(["Install", "Install guide"]);
			expect(installButtons()[1].getAttribute("href")).toBe(ENGINE_CATALOG.agy.installCommand);
			click(option(ENGINE_CATALOG.codex.name));
			expect(props.onCreate).not.toHaveBeenCalled();
			click(installButtons()[0]);
			expect(events).toHaveLength(1);
			expect(events[0].detail).toEqual({
				title: "Install Codex engine",
				command: ENGINE_CATALOG.codex.installCommand,
			});
			expect(props.onClose).toHaveBeenCalledOnce();
		} finally {
			window.removeEventListener("pi-web-ui:plugin-run-command", onRunCommand);
		}
	});

	it("never blocks creation when the local probe itself fails", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(JSON.stringify({ error: "The terminal feature is not enabled on this instance" }), { status: 403 }),
		);
		renderModal();
		await flush();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"The terminal feature is not enabled on this instance",
		);
		expect(document.querySelector(".native-cli-create-install")).toBeNull();
		click(option(ENGINE_CATALOG.codex.name));
		expect(props.onCreate).toHaveBeenCalledExactlyOnceWith({ preset: "codex" });
	});
});

describe("native CLI hover creation entry", () => {
	it("keeps + and CLI inside one expanding creation control with the project cwd", () => {
		const onCreateCli = vi.fn();
		const onNewChat = vi.fn();
		mount(
			createElement(
				NativeCliCreateEntry,
				{ cwd: "/project/selected", onCreateCli },
				createElement("button", { onClick: onNewChat }, "+"),
			),
		);
		const plus = container.querySelector("button")!;
		click(plus);
		expect(onNewChat).toHaveBeenCalledOnce();
		expect(onCreateCli).not.toHaveBeenCalled();
		act(() => plus.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		const cli = document.querySelector<HTMLButtonElement>(".native-cli-create-hover-button")!;
		expect(cli).not.toBeNull();
		expect(cli.closest(".native-cli-create-entry")).toBe(plus.parentElement);
		expect(cli.parentElement?.getAttribute("aria-hidden")).toBe("false");
		click(cli);
		expect(onCreateCli).toHaveBeenCalledWith("/project/selected");
		expect(onNewChat).toHaveBeenCalledOnce();
		expect(plus.parentElement?.hasAttribute("data-cli-expanded")).toBe(false);
		expect(cli.parentElement?.getAttribute("aria-hidden")).toBe("true");
		expect(cli.tabIndex).toBe(-1);
	});

	it("preserves the SSH workspace URI through the shared project and header creation entry", () => {
		const onCreateCli = vi.fn();
		mount(createElement(NativeCliCreateEntry, { cwd: remoteCwd, onCreateCli }, createElement("button", null, "+")));
		click(document.querySelector<HTMLButtonElement>(".native-cli-create-hover-button")!);
		expect(onCreateCli).toHaveBeenCalledExactlyOnceWith(remoteCwd);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("supports keyboard discovery and collapses the shared control when leaving", () => {
		mount(createElement(NativeCliCreateEntry, { onCreateCli: vi.fn() }, createElement("button", null, "+")));
		const plus = container.querySelector("button")!;
		act(() => plus.focus());
		expect(document.querySelector(".native-cli-create-hover-button")).not.toBeNull();
		act(() => plus.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
		expect(document.activeElement).toBe(document.querySelector(".native-cli-create-hover-button"));
		act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.activeElement).toBe(plus);
		expect(plus.parentElement?.hasAttribute("data-cli-expanded")).toBe(false);
		act(() => plus.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
		act(() => plus.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
		expect(plus.parentElement?.hasAttribute("data-cli-expanded")).toBe(false);
	});

	it("respects the instance terminal-tab capability", () => {
		setAppGlobals({ tabs: ["chat", "git"] });
		mount(
			createElement(NativeCliCreateEntry, { cwd: remoteCwd, onCreateCli: vi.fn() }, createElement("button", null, "+")),
		);
		act(() => container.querySelector("button")!.focus());
		expect(container.querySelector(".native-cli-create-entry")).toBeNull();
		expect(document.querySelector(".native-cli-create-hover-button")).toBeNull();
	});

	it("omits CLI affordance when the callback is unavailable", () => {
		mount(createElement(NativeCliCreateEntry, null, createElement("button", null, "+")));
		act(() => container.querySelector("button")!.focus());
		expect(container.querySelector(".native-cli-create-entry")).toBeNull();
		expect(document.querySelector(".native-cli-create-hover-button")).toBeNull();
	});
});

describe("retired CLI view tabs", () => {
	it("removes the old CLI slot and renders neither legacy tab in any bar", () => {
		expect(BUILTIN_UI_ITEMS.some((entry) => entry.id === "host:native-cli")).toBe(false);
		for (const bar of ["top", "bottom", "left", "right"] as const) {
			for (const id of ["host:chat", "host:native-cli"]) {
				for (const view of ["chat", "native-cli"] as const) {
					mount(
						createElement(BarItem, {
							entry: {
								id,
								slot: "topbar.primary",
								source: "host",
								kind: "view",
								label: id,
								order: 21,
								align: "end",
								hidden: false,
								userOverrides: [],
								arrangedBy: [],
							},
							bar,
							view,
							chat: { state: null } as any,
						}),
					);
					expect(container.textContent).toBe("");
				}
			}
		}
	});

	it("keeps a return-to-chat action available from auxiliary views", () => {
		const onViewChange = vi.fn();
		for (const view of ["terminal", "git", "canvas", "devices", "worktrees"] as const) {
			mount(
				createElement(BarItem, {
					entry: {
						id: "host:chat",
						slot: "topbar.primary",
						source: "host",
						kind: "view",
						label: "chat",
						order: 21,
						align: "end",
						hidden: false,
						userOverrides: [],
						arrangedBy: [],
					},
					bar: "top",
					view,
					onViewChange,
					chat: { state: null } as any,
				}),
			);
			const button = container.querySelector<HTMLButtonElement>("button")!;
			expect(button).not.toBeNull();
			click(button);
			expect(onViewChange).toHaveBeenLastCalledWith("chat");
		}
	});
});

describe("长路径单行省略", () => {
	const longExecutable =
		"C:\Users\alice\AppData\Roaming\fnm\node-versions\v25.9.0\installation\node_modules\@anthropic-ai\claude-code\cli.js";
	const longCwd = "/Users/alice/workspaces/2026/pi-web-ui-monorepo/apps/desktop-shell";

	it("引擎路径保留尾部并缩短，完整路径留在 title", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					...localDiscovery([{ preset: "claude", available: true, executable: longExecutable }]),
					cwd: longCwd,
				}),
			),
		);
		renderModal({ cwd: longCwd });
		await flush();
		const detail = option(ENGINE_CATALOG.claude.name).querySelector("small")!;
		expect(detail.textContent).toContain("cli.js");
		expect(detail.textContent).toContain("…");
		expect(detail.textContent!.length).toBeLessThan(longExecutable.length);
		expect(detail.getAttribute("title")).toBe(longExecutable);
	});

	it("工作目录同样单行省略，完整目录留在 title", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...localDiscovery(), cwd: longCwd })));
		renderModal({ cwd: longCwd });
		await flush();
		const cwd = document.querySelector(".native-cli-create-cwd")!;
		expect(cwd.textContent).toContain("desktop-shell");
		expect(cwd.textContent!.length).toBeLessThan(longCwd.length);
		expect(cwd.getAttribute("title")).toBe(longCwd);
	});

	it("状态与报错文字不加省略类，仍可折行显示", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(discoveryResponse())));
		renderModal({ cwd: remoteCwd });
		await flush();
		const codex = option(ENGINE_CATALOG.codex.name).querySelector("small")!;
		expect(codex.textContent).toBe("codex: command not found on remote host");
		expect(codex.classList.contains("native-cli-create-path")).toBe(false);
		const claude = option(ENGINE_CATALOG.claude.name).querySelector("small")!;
		expect(claude.classList.contains("native-cli-create-path")).toBe(true);
	});
});
