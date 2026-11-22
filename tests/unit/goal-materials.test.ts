import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GoalService,
	composeGoalMaterials,
	goalExecutorPrompt,
	goalMaterialRefs,
	goalReviewerPrompt,
	withMaterialBlock,
	type GoalConversation,
	type GoalHost,
} from "../../server/goal-service.js";
import { initAttachmentStore } from "../../server/attachment-store.js";
import { normalizeMaterials, type MaterialRef } from "../../server/material.js";
import type { ServerMessage } from "../../server/protocol.js";
import { fakeWebUi } from "../helpers/fake-session.js";

// 向导（wizard）会真的起一个会话：这里只关心它拿到的输入文本与落进规格的材料。
const wizard = vi.hoisted(() => ({ prompt: vi.fn() }));
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
				getLastAssistantText: () => "GOAL: 目标已收敛\nSTEPS:\n1. 读材料",
				dispose: async () => {},
				abort: async () => {},
			},
		}),
	};
});

/**
 * 目标线的材料规格（`docs/proposals/material-spec-contract.md` A 线）：
 * 存（string[]）→ 归（normalize + 记账）→ 投（同一份清单给执行者与审查者）→ 证。
 */

/** 无材料时的执行者首轮 prompt：material 接线前后必须逐字节一致（R10）。 */
const EXEC_PROMPT_NO_MATERIALS =
	"【目标 · 第 1/3 轮】\n\n把 README 补全\n\n要求：\n- 直接修改工作区（不要只在回复里描述改动），做完用一段话说明「改了什么、怎么验证的」。\n- 禁止向用户提问（本对话由服务端自动驱动，弹窗会被按取消返回）。\n- 禁止派生或等待其他子代理（轮次由服务端控制，你只负责这一轮）。";

const ref = (over: Partial<MaterialRef> = {}): MaterialRef => ({
	kind: "file",
	ref: "docs/spec.md",
	abs: "/w/docs/spec.md",
	...over,
});

const tmpDirs: string[] = [];
function tmpWorkspace(prefix = "goal-mat-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

beforeEach(() => {
	wizard.prompt.mockReset();
	wizard.prompt.mockResolvedValue(undefined);
});

describe("goalMaterialRefs（规格只存字符串，R1/R9/R10）", () => {
	it("非数组 / 空数组 → undefined（缺字段 ≡ []，且不写进快照）", () => {
		expect(goalMaterialRefs(undefined)).toBeUndefined();
		expect(goalMaterialRefs(null)).toBeUndefined();
		expect(goalMaterialRefs("docs/a.md")).toBeUndefined();
		expect(goalMaterialRefs([])).toBeUndefined();
	});

	it("只留字符串项，保持原顺序，并返回副本（不把调用方数组挂进规格）", () => {
		const raw = ["docs/a.md", 42, null, "docs/b.md"];
		const out = goalMaterialRefs(raw)!;
		expect(out).toEqual(["docs/a.md", "docs/b.md"]);
		out.push("docs/c.md");
		expect(raw).toEqual(["docs/a.md", 42, null, "docs/b.md"]);
	});
});

describe("withMaterialBlock（清单拼进目标段落）", () => {
	it("没有清单时原样返回：prompt 逐字节不变（R10）", () => {
		expect(withMaterialBlock("把 README 补全")).toBe("把 README 补全");
		expect(withMaterialBlock("把 README 补全", "")).toBe("把 README 补全");
		expect(withMaterialBlock("把 README 补全", "   ")).toBe("把 README 补全");
	});

	it("有清单时接在目标段落之后（空一行）", () => {
		expect(withMaterialBlock("把 README 补全", "材料：docs/spec.md")).toBe("把 README 补全\n\n材料：docs/spec.md");
	});
});

describe("执行者 / 审查者 prompt", () => {
	it("无材料：执行者 prompt 与今天逐字节一致（R10）", () => {
		expect(goalExecutorPrompt("zh", { goalText: "把 README 补全", round: 1, budget: 3, feedback: "" })).toBe(
			EXEC_PROMPT_NO_MATERIALS,
		);
		expect(
			goalExecutorPrompt("zh", { goalText: "把 README 补全", round: 1, budget: 3, feedback: "", materialsBlock: "" }),
		).toBe(EXEC_PROMPT_NO_MATERIALS);
	});

	it("无材料：审查者 prompt 传入空清单时与原样一致", () => {
		const base = { goalText: "把 README 补全", round: 1, budget: 3, execOutput: "已改完" };
		expect(goalReviewerPrompt("zh", { ...base, materialsBlock: "" })).toBe(goalReviewerPrompt("zh", base));
		expect(goalReviewerPrompt("zh", base)).not.toContain("材料");
	});

	it("有材料：执行者把清单放在目标段落里（不是追加到 prompt 末尾）", () => {
		const block = "材料：docs/spec.md、shot.png";
		const prompt = goalExecutorPrompt("zh", {
			goalText: "把 README 补全",
			round: 2,
			budget: 3,
			feedback: "还差单测",
			materialsBlock: block,
		});
		expect(prompt.startsWith(`【目标 · 第 2/3 轮】\n\n${withMaterialBlock("把 README 补全", block)}`)).toBe(true);
		expect(prompt).toContain(block);
	});

	it("审查者拿到同一份清单：也落在【目标】段落内", () => {
		const block = "材料：docs/spec.md、shot.png";
		const prompt = goalReviewerPrompt("zh", {
			goalText: "把 README 补全",
			round: 1,
			budget: 3,
			execOutput: "已改完",
			materialsBlock: block,
		});
		expect(prompt).toContain(`【目标】\n${withMaterialBlock("把 README 补全", block)}`);
		expect(prompt).toContain(block);
	});
});

describe("composeGoalMaterials（投递 + 记账，R3/R5/R6/R7）", () => {
	it("没有材料：清单为空、无回执（不产生噪音）", () => {
		expect(composeGoalMaterials([])).toEqual({ block: "", pointers: [], notice: null });
	});

	it("清单文本只由 describeMaterials 产出（≤3 项一行）", () => {
		const composed = composeGoalMaterials([ref(), ref({ ref: "src/a.ts", abs: "/w/src/a.ts" })]);
		expect(composed.block).toBe("材料：docs/spec.md、src/a.ts");
		expect(composed.notice).toBeNull();
		expect(composed.pointers.map((m) => m.ref)).toEqual(["docs/spec.md", "src/a.ts"]);
	});

	it("归一时被丢的项必须记账（R6）：清单里不出现，回执里点名", () => {
		const composed = composeGoalMaterials(
			[ref()],
			[],
			[
				{ value: "不存在.txt", reason: "missing" },
				{ value: "docs/spec.md", reason: "duplicate" },
			],
		);
		expect(composed.block).toBe("材料：docs/spec.md");
		expect(composed.notice?.text).toContain("不存在.txt(missing)");
		expect(composed.notice?.text).toContain("docs/spec.md(duplicate)");
	});

	it("跨 cwd 搬运失败（R7）：明示不可达，不进清单", () => {
		const composed = composeGoalMaterials([], [{ ref: "shot.png", reason: "EPERM" }]);
		expect(composed.block).toBe("");
		expect(composed.notice?.text).toContain("shot.png(unreachable)");
		expect(composed.notice?.textEn).toContain("shot.png(unreachable)");
	});

	it("反例：不存在的文件走 dropped:missing，不抛错、不静默（契约 §5）", async () => {
		const cwd = tmpWorkspace();
		const { materials, dropped } = await normalizeMaterials(["不存在.txt"], { cwd });
		expect(materials).toEqual([]);
		expect(dropped).toEqual([{ value: "不存在.txt", reason: "missing" }]);
		const composed = composeGoalMaterials(materials, [], dropped);
		expect(composed.block).toBe("");
		expect(composed.notice?.text).toContain("不存在.txt");
	});
});

interface Harness {
	svc: GoalService;
	sent: ServerMessage[];
	spawned: { role: string; prompt: string; cwd?: string }[];
	steered: string[];
	mainSent: string[];
	conv: () => GoalConversation & { mainLastText: { value: string } };
	notices: () => string[];
}

function makeHarness(opts: { cwd: string; diffs?: string[] }): Harness {
	const sent: ServerMessage[] = [];
	const spawned: Harness["spawned"] = [];
	const steered: string[] = [];
	const convs = new Map<string, GoalConversation>();
	const mainSent: string[] = [];
	const mainLastText = { value: "" };
	let diffIdx = 0;
	const host = {
		clientId: "test",
		agentDir: opts.cwd,
		stateStore: { getGoalPrefs: () => null, saveGoalPrefs: () => {} },
		webUi: fakeWebUi(),
		emit: (m: ServerMessage) => void sent.push(m),
		flushSnapshot: () => {},
		isDisposed: () => false,
		quiesceBlocked: () => false,
		activeConvId: () => "conv-a",
		activeConv: () => convs.get("conv-a")!,
		getConv: (id: string) => convs.get(id),
		cwd: () => opts.cwd,
		gitDiff: async () => {
			const arr = opts.diffs ?? ["d1", "d2", "d3"];
			return arr[Math.min(diffIdx++, arr.length - 1)]!;
		},
		goalModeEnabled: () => true,
		lang: () => "zh",
		describePlan: () => "No active plan.",
		roleDeadlineMs: () => 1000,
		spawnRoleAgent: async ({ role, prompt, cwd }: { role: string; prompt: string; cwd?: string }) => {
			spawned.push({ role, prompt, cwd });
			return "sa-exec";
		},
		waitRoleAgent: async () => "done",
		sendRoleAgent: async (convId: string, message: string) => {
			if (convId === "sa-exec") steered.push(message);
			else mainSent.push(message);
			return true;
		},
		readRoleAgent: (id: string) => (id === "sa-exec" ? { text: "已改完并自测通过。" } : undefined),
		stopRoleAgent: async () => {},
		dismissRoleAgent: async () => {},
		hasConv: (id: string) => id === "sa-exec" || convs.has(id),
	};
	const svc = new GoalService(host as unknown as GoalHost);
	const conv: GoalConversation = {
		id: "conv-a",
		title: "会话 A",
		cwd: opts.cwd,
		goalGeneration: 0,
		wizardRunning: false,
		goal: svc.makeGoalStatus(),
		session: {
			isStreaming: false,
			sendCustomMessage: async () => {},
			getLastAssistantText: () => mainLastText.value,
			getSessionStats: () => ({ totalMessages: 0 }),
		} as unknown as GoalConversation["session"],
	};
	convs.set("conv-a", conv);
	Object.assign(conv, { mainSent, mainLastText });
	return {
		svc,
		sent,
		spawned,
		steered,
		mainSent,
		conv: () => conv as unknown as ReturnType<Harness["conv"]>,
		notices: () => (sent.filter((m) => m.type === "notice") as { text: string }[]).map((m) => m.text),
	};
}

const materialLine = (prompt: string): string | undefined => prompt.match(/材料：[^\n]*/)?.[0];

describe("目标执行：材料清单落到执行者与审查者（R3/R5/R7/R10）", () => {
	it("无材料：执行者首轮 prompt 与今天逐字节一致（R10）", async () => {
		const h = makeHarness({ cwd: tmpWorkspace() });
		await h.svc.setGoal("把 README 补全", { maxRounds: 3, locked: true });

		expect(h.conv().goal.materials).toBeUndefined();
		expect(h.spawned[0]!.prompt).toBe(EXEC_PROMPT_NO_MATERIALS);
		expect(h.notices().filter((t) => t.includes("材料"))).toEqual([]);
	});

	it("粘贴图（base64）：落盘成内容寻址路径后才进规格（R1 的唯一出口）", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "piweb-att-"));
		try {
			initAttachmentStore(dataDir);
			const h = makeHarness({ cwd: tmpWorkspace() });
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
			await h.svc.setGoal("按截图修", {
				maxRounds: 1,
				locked: true,
				materialBlobs: [{ name: "shot.png", mimeType: "image/png", data: png }],
			});

			const stored = h.conv().goal.materials ?? [];
			expect(stored).toHaveLength(1);
			expect(stored[0]!.startsWith(join(dataDir, "attachments"))).toBe(true);
			expect(existsSync(stored[0]!)).toBe(true);
			// 等执行者真的被派活（spawn 在循环里异步发生）
			expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
			expect(materialLine(h.spawned[0]!.prompt)).toBe(`材料：${stored[0]}`);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("blob 落盘不了只记账，不阻断设目标", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "piweb-att-"));
		try {
			initAttachmentStore(dataDir);
			const h = makeHarness({ cwd: tmpWorkspace() });
			await h.svc.setGoal("目标照设", {
				maxRounds: 1,
				locked: true,
				materialBlobs: [{ name: "broken.png", data: "" }],
			});
			expect(h.conv().goal.materials).toBeUndefined();
			expect(h.notices().some((t) => t.includes("broken.png"))).toBe(true);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("有材料：goal 里存 string[]，执行者与审查者拿到同一份清单", async () => {
		const cwd = tmpWorkspace();
		writeFileSync(join(cwd, "notes.md"), "材料正文");
		const h = makeHarness({ cwd });
		await h.svc.setGoal("按 notes.md 补完接口", { maxRounds: 3, locked: true, materials: ["notes.md"] });

		expect(h.conv().goal.materials).toEqual(["notes.md"]);
		// 快照/回显同样带出（`goal_status` 是快照唯一的携带点）。
		const lastGoalStatus = h.sent.filter((m) => m.type === "goal_status").at(-1) as
			{ status: { materials?: string[] } } | undefined;
		expect(lastGoalStatus?.status.materials).toEqual(["notes.md"]);
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);

		const execLine = materialLine(h.spawned[0]!.prompt);
		expect(execLine).toBe("材料：notes.md");
		const reviewPrompt = h.mainSent.at(-1)!;
		expect(materialLine(reviewPrompt)).toBe(execLine);
		expect(h.notices().filter((t) => t.includes("材料"))).toEqual([]);
	});

	it("不可达材料：不抛错、不进清单，用户收到 notice（R6）", async () => {
		const h = makeHarness({ cwd: tmpWorkspace() });
		await h.svc.setGoal("按缺失的材料干活", { maxRounds: 3, locked: true, materials: ["不存在.txt"] });

		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(materialLine(h.spawned[0]!.prompt)).toBeUndefined();
		expect(h.spawned[0]!.prompt).not.toContain("不存在.txt");
		expect(h.notices().some((t) => t.includes("不存在.txt") && t.includes("missing"))).toBe(true);
	});

	it("执行者 cwd 与记录 cwd 不一致：材料先 stage 到执行侧，清单给出暂存路径（R7）", async () => {
		const execCwd = tmpWorkspace("goal-mat-exec-");
		const recordCwd = tmpWorkspace("goal-mat-record-");
		writeFileSync(join(execCwd, "notes.md"), "执行侧旧正文");
		writeFileSync(join(recordCwd, "notes.md"), "记录侧正文");
		const h = makeHarness({ cwd: execCwd });
		await h.svc.setGoal("按 notes.md 补完接口", { maxRounds: 0, locked: true, materials: ["notes.md"] });
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);
		expect(materialLine(h.spawned[0]!.prompt)).toBe("材料：notes.md");
		expect(h.spawned[0]!.cwd).toBe(execCwd);

		// 第二轮：记录 cwd 换成另一份工作区，执行对话仍在旧 cwd → 必须把材料搬过去。
		h.conv().mainLastText.value = '{"verdict":"fail","feedback":"继续"}';
		h.conv().cwd = recordCwd;
		h.svc.onAgentEnd(h.conv(), false);
		expect(await h.svc.whenAwaitingVerdict("conv-a")).toBe(true);

		const stagedPath = join(execCwd, ".pi-materials", "notes.md");
		expect(existsSync(stagedPath)).toBe(true);
		expect(readFileSync(stagedPath, "utf8")).toBe("记录侧正文");
		const roundTwo = h.steered.at(-1)!;
		expect(materialLine(roundTwo)).toBe("材料：.pi-materials/notes.md");
		expect(materialLine(h.mainSent.at(-1)!)).toBe("材料：.pi-materials/notes.md");
	});

	it("目标调研（wizard）阶段就看到材料，并随收敛后的目标进入规格", async () => {
		const cwd = tmpWorkspace();
		writeFileSync(join(cwd, "notes.md"), "材料正文");
		const h = makeHarness({ cwd });

		await h.svc.startGoalWizard("按 notes.md 补个接口", { materials: ["notes.md"] });

		const wizardInput = String(wizard.prompt.mock.calls.at(-1)?.[0] ?? "");
		expect(materialLine(wizardInput)).toBe("材料：notes.md");
		expect(h.conv().goal.materials).toEqual(["notes.md"]);
		expect(h.conv().goal.goal).toBe("目标已收敛");
	});
});
