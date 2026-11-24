import { describe, expect, it } from "vitest";
import { planSandboxLifecycle, type SandboxOwnerFact } from "../../packages/keel/src/domains/sandbox/lifecycle.js";

const isInside = (target: string, root: string) =>
	target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);

function owners(...cwdList: string[]): SandboxOwnerFact[] {
	return cwdList.map((cwd, index) => ({ conversationId: `c-${index + 1}`, cwd }));
}

describe("planSandboxLifecycle · 沙盒生命周期的纯编排", () => {
	it("沙盒里的对话迁到源项目；reset/apply 之后回到沙盒", () => {
		const plan = planSandboxLifecycle({
			action: "reset",
			sandboxPath: "/data/sandboxes/sb1",
			owners: owners("/data/sandboxes/sb1/src", "/work/other"),
			fallbackPath: "/src/proj",
			isInside,
		});
		expect(plan).toStrictEqual({
			moves: [{ conversationId: "c-1", to: "/src/proj" }],
			restoreTo: "/data/sandboxes/sb1",
		});
	});

	it("destroy 不迁回（沙盒目录随后被清理）", () => {
		const plan = planSandboxLifecycle({
			action: "destroy",
			sandboxPath: "/data/sandboxes/sb1",
			owners: owners("/data/sandboxes/sb1"),
			fallbackPath: "/src/proj",
			isInside,
		});
		expect(plan.moves).toStrictEqual([{ conversationId: "c-1", to: "/src/proj" }]);
		expect(plan.restoreTo).toBeUndefined();
	});

	it("沙盒根目录本身也算 owner（`==` 与子路径都算）", () => {
		const plan = planSandboxLifecycle({
			action: "apply",
			sandboxPath: "/data/sandboxes/sb1",
			owners: owners("/data/sandboxes/sb1", "/data/sandboxes/sb10"),
			fallbackPath: "/src/proj",
			isInside,
		});
		// `sb10` 不是 `sb1` 的子路径（前缀相同但目录不同）——不能误伤。
		expect(plan.moves.map((m) => m.conversationId)).toStrictEqual(["c-1"]);
	});

	it("cwd 为空（老对话/远程）不参与迁移", () => {
		const plan = planSandboxLifecycle({
			action: "reset",
			sandboxPath: "/data/sandboxes/sb1",
			owners: owners("", "/work"),
			fallbackPath: "/src/proj",
			isInside,
		});
		expect(plan.moves).toStrictEqual([]);
	});

	it("缺省判定用 path-boundary 的单源谓词（不另写一份串比较）", () => {
		const plan = planSandboxLifecycle({
			action: "reset",
			sandboxPath: "/data/sandboxes/sb1",
			owners: owners("/data/sandboxes/sb1/nested"),
			fallbackPath: "/src/proj",
		});
		expect(plan.moves).toStrictEqual([{ conversationId: "c-1", to: "/src/proj" }]);
	});
});
