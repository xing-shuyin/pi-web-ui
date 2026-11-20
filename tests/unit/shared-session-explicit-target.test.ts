import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalService, type GoalConversation, type GoalHost } from "../../server/goal-service.js";
import { fakeWebUi } from "../helpers/fake-session.js";
import { SettingsService, type SettingsHost, type SettingsRuntimeTarget } from "../../server/settings-service.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

const wizard = vi.hoisted(() => ({ prompt: vi.fn(), services: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		ModelRuntime: { create: async () => ({ getModel: () => undefined }) },
		createAgentSessionServices: wizard.services,
		createAgentSessionFromServices: async () => ({
			session: {
				bindExtensions: async () => {},
				subscribe: () => () => {},
				prompt: wizard.prompt,
				getLastAssistantText: () => "GOAL: explicit target goal",
				dispose: async () => {},
				abort: async () => {},
			},
		}),
	};
});

function goalSetup() {
	const convs = new Map<string, GoalConversation>();
	let active = "a";
	const host = {
		clientId: "test",
		agentDir: tmpdir(),
		stateStore: { getGoalPrefs: () => null, saveGoalPrefs: vi.fn() },
		// Conversation-bound UI context is provided by the shared fake facade.
		webUi: fakeWebUi(),
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		isDisposed: () => false,
		quiesceBlocked: () => false,
		goalModeEnabled: () => true,
		activeConvId: () => active,
		activeConv: () => convs.get(active)!,
		getConv: (id: string) => convs.get(id),
		cwd: () => tmpdir(),
		gitDiff: async () => "",
		hasConv: (id: string) => convs.has(id),
		spawnRoleAgent: async () => "exec",
		waitRoleAgent: async () => "done",
		sendRoleAgent: async () => true,
		readRoleAgent: () => ({ text: "" }),
		setPlan: vi.fn(),
	};
	const svc = new GoalService(host as unknown as GoalHost);
	for (const id of ["a", "b"])
		convs.set(id, {
			id,
			title: id,
			cwd: tmpdir(),
			goalGeneration: 0,
			wizardRunning: false,
			goal: svc.makeGoalStatus(),
			session: {
				isStreaming: false,
				sendCustomMessage: vi.fn(async () => {}),
			} as unknown as GoalConversation["session"],
		});
	vi.spyOn(svc as any, "startDelegatedLoop").mockImplementation(() => {});
	return {
		svc,
		host,
		convs,
		switchTo: (id: string) => {
			active = id;
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	wizard.prompt.mockResolvedValue(undefined);
	wizard.services.mockResolvedValue({ agentDir: tmpdir(), modelRuntime: { getModel: () => undefined } });
});

describe("GoalService explicit conversation targets", () => {
	it("updates inactive target preferences and global defaults without changing the active goal", async () => {
		const { svc, host, convs } = goalSetup();
		const target = convs.get("b")!;
		convs.get("a")!.goal.goal = "active goal";
		await svc.setGoalPrefs({ maxRounds: 7, locked: true, execModel: "p/m" }, target);
		expect(target.goal.maxRounds).toBe(7);
		expect(target.goal.execModel).toBe("p/m");
		expect(convs.get("a")!.goal.execModel).toBeNull();
		expect(host.stateStore.saveGoalPrefs).toHaveBeenCalled();
	});

	it("captures wizard session and goal across an active switch during prompt", async () => {
		const { svc, convs, switchTo } = goalSetup();
		const target = convs.get("b")!;
		let finish!: () => void;
		wizard.prompt.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const pending = svc.startGoalWizard("draft", {}, target);
		await vi.waitFor(() => expect(wizard.prompt).toHaveBeenCalled());
		expect(target.wizardRunning).toBe(true);
		expect(target.session.sendCustomMessage).toHaveBeenCalled();
		expect(convs.get("a")!.session.sendCustomMessage).not.toHaveBeenCalled();
		switchTo("b");
		switchTo("a");
		finish();
		await pending;
		expect(target.goal.goal).toBe("explicit target goal");
		expect(convs.get("a")!.goal.goal).toBeNull();
		expect(wizard.services).toHaveBeenCalledWith(expect.objectContaining({ cwd: target.cwd }));
	});

	it("rejects stale target objects at entry and does not apply a wizard to a replacement", async () => {
		const { svc, host, convs } = goalSetup();
		const target = convs.get("b")!;
		let finish!: () => void;
		wizard.prompt.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const pending = svc.startGoalWizard("draft", {}, target);
		await vi.waitFor(() => expect(wizard.prompt).toHaveBeenCalled());
		const replacement = { ...target, goal: svc.makeGoalStatus() };
		convs.set("b", replacement);
		finish();
		await pending;
		expect(replacement.goal.goal).toBeNull();
		host.stateStore.saveGoalPrefs.mockClear();
		await svc.setGoalPrefs({ maxRounds: 9 }, target);
		await svc.startGoalWizard("stale", {}, target);
		expect(host.stateStore.saveGoalPrefs).not.toHaveBeenCalled();
		expect(wizard.prompt).toHaveBeenCalledTimes(1);
	});
});

function settingsSetup() {
	let saved: Record<string, unknown> = {
		disabledAgentTools: [],
		reviewDisabledSkills: [],
		disabledSkills: [],
		disabledExtensions: [],
		quickPhrases: [],
	};
	const host = {
		clientId: "test",
		stateStore: {
			getSettings: () => saved,
			getPresets: () => [{ name: "test", customSystemPrompt: "shared" }],
			getQuickPhrasesSeeded: () => false,
			saveSettings: (_id: string, patch: Record<string, unknown>) => {
				saved = { ...saved, ...patch };
			},
		},
		emit: vi.fn(),
		flushSnapshot: vi.fn(),
		isDisposed: () => false,
		getSession: () => {
			throw new Error("no session");
		},
		cwd: () => tmpdir(),
		agentDir: () => tmpdir(),
		isStreaming: vi.fn(() => true),
		reloadSession: vi.fn(async () => {}),
		applyRetryOverrides: vi.fn(),
		applyCompactionOverrides: vi.fn(),
		applyToolGating: vi.fn(),
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	};
	const svc = new SettingsService(
		host as unknown as SettingsHost,
		{ list: () => [] } as unknown as SubagentTemplatesStore,
	);
	const target = (streaming: boolean): SettingsRuntimeTarget => ({
		isStreaming: vi.fn(() => streaming),
		reloadSession: vi.fn(async () => {}),
	});
	return { svc, host, target, saved: () => saved };
}

describe("SettingsService explicit runtime targets", () => {
	it("applies the shared preset to an idle explicit runtime while active is streaming", async () => {
		const { svc, host, target, saved } = settingsSetup();
		const runtime = target(false);
		await svc.applyPreset("test", runtime);
		expect(saved().customSystemPrompt).toBe("shared");
		expect(runtime.reloadSession).toHaveBeenCalledTimes(1);
		expect(host.reloadSession).not.toHaveBeenCalled();
		expect(host.isStreaming).not.toHaveBeenCalled();
	});

	it("isolates deferred reloads per stable port, including consumption and disposal", async () => {
		const { svc, host, target } = settingsSetup();
		const a = target(true),
			b = target(true);
		await svc.applyPreset("test", a);
		await svc.applyRuntime(false, b);
		expect(svc.hasPendingReload(a)).toBe(true);
		expect(svc.hasPendingReload(b)).toBe(true);
		expect(svc.consumePendingReload()).toBe(false);
		expect(svc.consumePendingReload(a)).toBe(true);
		expect(svc.hasPendingReload(b)).toBe(true);
		vi.mocked(a.isStreaming).mockReturnValue(false);
		await svc.applyRuntime(true, a);
		expect(a.reloadSession).toHaveBeenCalledTimes(1);
		expect(b.reloadSession).not.toHaveBeenCalled();
		expect(host.reloadSession).not.toHaveBeenCalled();
		svc.dispose();
		expect(svc.hasPendingReload(b)).toBe(false);
	});

	it("rechecks the explicit port before reload and propagates its failure", async () => {
		const { svc, target } = settingsSetup();
		const runtime = target(false);
		vi.mocked(runtime.isStreaming).mockReturnValueOnce(false).mockReturnValueOnce(true);
		await svc.applyRuntime(true, runtime);
		expect(runtime.reloadSession).not.toHaveBeenCalled();
		expect(svc.consumePendingReload(runtime)).toBe(true);
		vi.mocked(runtime.reloadSession).mockRejectedValueOnce(new Error("target reload failed"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(svc.applyPreset("test", runtime)).rejects.toThrow("target reload failed");
		} finally {
			log.mockRestore();
		}
	});
});
