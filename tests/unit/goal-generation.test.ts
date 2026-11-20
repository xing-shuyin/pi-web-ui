import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalService, type GoalConversation, type GoalHost } from "../../server/goal-service.js";
import { fakeWebUi } from "../helpers/fake-session.js";

const wizard = vi.hoisted(() => ({
	prompt: vi.fn(),
	dispose: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		ModelRuntime: { create: async () => ({ getModel: () => undefined }) },
		createAgentSessionServices: async () => ({ agentDir: tmpdir(), modelRuntime: { getModel: () => undefined } }),
		createAgentSessionFromServices: async () => ({
			session: {
				bindExtensions: async () => {},
				subscribe: () => () => {},
				prompt: wizard.prompt,
				getLastAssistantText: () => "GOAL: surveyed goal\nSTEPS:\n1. Persist the plan",
				dispose: wizard.dispose,
				abort: async () => {},
			},
		}),
	};
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup() {
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
		activeConvId: () => active,
		activeConv: () => convs.get(active)!,
		getConv: (id: string) => convs.get(id),
		cwd: () => tmpdir(),
		gitDiff: async () => "",
		goalModeEnabled: () => true,
		spawnRoleAgent: vi.fn(async () => "exec"),
		waitRoleAgent: async () => "done",
		sendRoleAgent: async () => true,
		readRoleAgent: () => ({ text: "" }),
		hasConv: (id: string) => convs.has(id),
		stopRoleAgent: vi.fn(async () => {}),
		dismissRoleAgent: vi.fn(async () => {}),
		interruptMainConv: vi.fn(async () => {}),
		setPlan: vi.fn(),
	};
	const svc = new GoalService(host as unknown as GoalHost);
	const makeConv = (id: string): GoalConversation => ({
		id,
		title: id,
		cwd: tmpdir(),
		goalGeneration: 0,
		wizardRunning: false,
		goal: svc.makeGoalStatus(),
		session: { isStreaming: false, sendCustomMessage: async () => {} } as unknown as GoalConversation["session"],
	});
	const conv = makeConv("a");
	convs.set("a", conv);
	convs.set("b", makeConv("b"));
	const start = vi.spyOn(svc as any, "startDelegatedLoop").mockImplementation(() => {});
	const blockCleanup = () => {
		const gate = deferred();
		conv.roleExec = { convId: "old-exec" } as GoalConversation["roleExec"];
		host.dismissRoleAgent.mockImplementationOnce(() => gate.promise);
		return gate;
	};
	return {
		svc,
		conv,
		convs,
		host,
		start,
		blockCleanup,
		makeConv,
		switchTo: (id: string) => {
			active = id;
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	wizard.prompt.mockResolvedValue(undefined);
	wizard.dispose.mockResolvedValue(undefined);
});

describe("goal mutation generation across delegated cleanup", () => {
	it("empty targeted text clears the inactive target without touching the active goal", async () => {
		const { svc, conv, convs } = setup();
		conv.goal.goal = "active goal";
		const target = convs.get("b")!;
		target.goal.goal = "target goal";
		await svc.setGoal("  ", { targetConvId: "b" });
		expect(target.goal.goal).toBeNull();
		expect(target.goalGeneration).toBe(1);
		expect(conv.goal.goal).toBe("active goal");
		expect(conv.goalGeneration).toBe(0);
	});

	it("empty targeted text retains its target across an active switch during cleanup", async () => {
		const { svc, conv, convs, switchTo, blockCleanup } = setup();
		conv.goal.goal = "target goal";
		const other = convs.get("b")!;
		other.goal.goal = "other goal";
		switchTo("b");
		const gate = blockCleanup();
		const pending = svc.setGoal("", { targetConvId: "a" });
		switchTo("a");
		gate.resolve();
		await pending;
		expect(conv.goal.goal).toBeNull();
		expect(other.goal.goal).toBe("other goal");
		expect(other.goalGeneration).toBe(0);
	});

	it("empty targeted text cannot clear a newer goal after an active switch", async () => {
		const { svc, conv, switchTo, blockCleanup } = setup();
		const gate = blockCleanup();
		const clearing = svc.setGoal("", { targetConvId: "a" });
		switchTo("b");
		const setting = svc.setGoal("new target goal", { targetConvId: "a", autoStart: false });
		gate.resolve();
		await Promise.all([clearing, setting]);
		expect(conv.goal.goal).toBe("new target goal");
		expect(conv.goalGeneration).toBe(2);
	});

	it("empty text for a missing target never falls back to the active conversation", async () => {
		const { svc, conv } = setup();
		conv.goal.goal = "keep";
		await svc.setGoal("", { targetConvId: "missing" });
		expect(conv.goal.goal).toBe("keep");
		expect(conv.goalGeneration).toBe(0);
	});

	it("clearGoal accepts a conversation object and rejects a stale object with the same id", async () => {
		const { svc, conv, convs, makeConv } = setup();
		const target = convs.get("b")!;
		target.goal.goal = "target";
		await svc.clearGoal(target);
		expect(target.goal.goal).toBeNull();
		expect(conv.goalGeneration).toBe(0);
		const replacement = makeConv("b");
		replacement.goal.goal = "replacement";
		convs.set("b", replacement);
		await svc.clearGoal(target);
		expect(target.goalGeneration).toBe(1);
		expect(replacement.goal.goal).toBe("replacement");
		expect(replacement.goalGeneration).toBe(0);
	});

	it("a clear invalidates a waiting set before it writes preferences, preempts or starts", async () => {
		const { svc, conv, host, start, blockCleanup } = setup();
		const gate = blockCleanup();
		const setting = svc.setGoal("stale", { reviewModel: "stale-model" });
		const clearing = svc.clearGoal();
		gate.resolve();
		await Promise.all([setting, clearing]);
		expect(conv.goal.goal).toBeNull();
		expect(host.stateStore.saveGoalPrefs).not.toHaveBeenCalled();
		expect(host.interruptMainConv).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it("only the newest of overlapping sets commits and starts using its entry generation", async () => {
		const { svc, conv, host, start, blockCleanup } = setup();
		const gate = blockCleanup();
		const first = svc.setGoal("old", { reviewModel: "old-model" });
		const second = svc.setGoal("new", { reviewModel: "new-model" });
		gate.resolve();
		await Promise.all([first, second]);
		expect(conv.goal.goal).toBe("new");
		expect(host.stateStore.saveGoalPrefs).toHaveBeenCalledTimes(1);
		expect(start).toHaveBeenCalledExactlyOnceWith(conv, 2, "new");
	});

	it("a waiting clear cannot erase a later set or reset its counters", async () => {
		const { svc, conv, start, blockCleanup } = setup();
		const gate = blockCleanup();
		const clearing = svc.clearGoal();
		const reset = vi.spyOn(svc as any, "resetLoopCounters");
		const setting = svc.setGoal("replacement");
		gate.resolve();
		await Promise.all([clearing, setting]);
		expect(reset).toHaveBeenCalledTimes(1);
		expect(conv.goal.goal).toBe("replacement");
		expect(start).toHaveBeenCalledExactlyOnceWith(conv, 2, "replacement");
	});

	it.each(["set", "clear"])(
		"%s cannot commit after its conversation is replaced with the same id and generation",
		async (operation) => {
			const { svc, conv, convs, host, start, blockCleanup, makeConv } = setup();
			conv.goal.goal = "original";
			const gate = blockCleanup();
			const pending = operation === "set" ? svc.setGoal("stale") : svc.clearGoal();
			const replacement = makeConv("a");
			replacement.goalGeneration = conv.goalGeneration;
			convs.set("a", replacement);
			gate.resolve();
			await pending;
			expect(conv.goal.goal).toBe("original");
			expect(replacement.goal.goal).toBeNull();
			expect(host.stateStore.saveGoalPrefs).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
		},
	);

	it("clear cancels the captured conversation's wizard after the active conversation changes", async () => {
		const { svc, blockCleanup, switchTo } = setup();
		const gate = blockCleanup();
		(svc as any).wizardOwnerId = "a";
		const abort = vi.spyOn(svc as any, "abortWizard").mockResolvedValue(true);
		const pending = svc.clearGoal();
		switchTo("b");
		gate.resolve();
		await pending;
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("a set invalidated during main-run preemption never dispatches", async () => {
		const { svc, conv, host, start } = setup();
		conv.promptInFlight = true;
		const entered = deferred();
		const gate = deferred();
		host.interruptMainConv.mockImplementationOnce(() => {
			entered.resolve();
			return gate.promise;
		});
		const pending = svc.setGoal("old");
		await entered.promise;
		await svc.clearGoal();
		gate.resolve();
		await pending;
		expect(start).not.toHaveBeenCalled();
	});

	it("stopAllGoals cannot clear a goal set while shutdown is awaiting cleanup", async () => {
		const { svc, conv, start, blockCleanup } = setup();
		(svc as any).delegatedLoops.set(conv.id, Promise.resolve());
		const gate = blockCleanup();
		const stopping = svc.stopAllGoals();
		const setting = svc.setGoal("new");
		gate.resolve();
		await Promise.all([stopping, setting]);
		expect(conv.goal.goal).toBe("new");
		expect(start).toHaveBeenCalledExactlyOnceWith(conv, 2, "new");
	});
});

describe("wizard goal handoff", () => {
	it("commits the plan before preemption and never starts after a clear during preemption", async () => {
		const { svc, conv, host, start } = setup();
		conv.promptInFlight = true;
		const entered = deferred();
		const gate = deferred();
		host.interruptMainConv.mockImplementationOnce(() => {
			expect(host.setPlan).toHaveBeenCalledTimes(1);
			entered.resolve();
			return gate.promise;
		});
		const survey = svc.startGoalWizard("draft");
		await entered.promise;
		await svc.clearGoal();
		gate.resolve();
		await survey;
		expect(conv.goal.goal).toBeNull();
		expect(start).not.toHaveBeenCalled();
	});

	it.each(["set", "clear", "replace"])("discards a late survey after %s", async (operation) => {
		const { svc, convs, host, start, makeConv } = setup();
		const entered = deferred();
		const gate = deferred();
		wizard.prompt.mockImplementationOnce(() => {
			entered.resolve();
			return gate.promise;
		});
		const survey = svc.startGoalWizard("draft");
		await entered.promise;
		if (operation === "set") await svc.setGoal("new", { autoStart: false });
		else if (operation === "clear") await svc.clearGoal();
		else convs.set("a", makeConv("a"));
		gate.resolve();
		await survey;
		expect(convs.get("a")!.goal.goal).toBe(operation === "set" ? "new" : null);
		expect(host.setPlan).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it("a survey invalidated during setGoal cleanup cannot restart using the newer generation", async () => {
		const { svc, conv, start, blockCleanup } = setup();
		const gate = blockCleanup();
		const entered = deferred();
		const original = (svc as any).commitGoal.bind(svc);
		vi.spyOn(svc as any, "commitGoal").mockImplementation((...args: any[]) => {
			const pending = original(...args);
			entered.resolve();
			return pending;
		});
		const survey = svc.startGoalWizard("draft");
		await entered.promise;
		const replacement = svc.setGoal("new");
		gate.resolve();
		await Promise.all([survey, replacement]);
		expect(conv.goal.goal).toBe("new");
		expect(start).toHaveBeenCalledExactlyOnceWith(conv, 2, "new");
	});

	it("starts a valid survey exactly once on its launcher even after switching conversations", async () => {
		const { svc, conv, host, start, switchTo } = setup();
		conv.goalGeneration = 7;
		wizard.prompt.mockImplementationOnce(async () => {
			switchTo("b");
		});
		await svc.startGoalWizard("draft");
		expect(conv.goal.goal).toBe("surveyed goal");
		expect(start).toHaveBeenCalledExactlyOnceWith(conv, 8, "surveyed goal");
		expect(host.setPlan).toHaveBeenCalledExactlyOnceWith("a", [expect.objectContaining({ title: "Persist the plan" })]);
		expect(host.setPlan.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
	});
});
