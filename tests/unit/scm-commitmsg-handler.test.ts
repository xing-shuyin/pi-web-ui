import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../../server/protocol.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ScmCommitMessagePort, ScmCommitMessageResult } from "../../packages/keel/src/contracts/scm.js";
import { createScmHandlers } from "../../packages/keel/src/domains/scm/index.js";

/**
 * `scmGenCommitMessage` 的内核这一段只有一个职责：**按 `reqId` 把宿主结论拼成一帧 `scm_data`**。
 * 采集 diff、选模型、凭证、超时、清洗都在宿主端口后面（`server/scm-commitmsg.ts`）：
 * 这里钉的是端口被怎么调、回执怎么出、失败怎么不假装成功。
 */

function harness(port: ScmCommitMessagePort | undefined, options: { closed?: boolean; cwd?: string } = {}) {
	const frames: ServerMessage[] = [];
	const handlers = createScmHandlers({
		...(port ? { scm: () => port } : {}),
		transport: {
			send: (msg) => frames.push(msg),
			isClosed: () => options.closed ?? false,
		},
		cwd: () => options.cwd ?? "/work/project",
	});
	return { handlers, frames };
}

const okPort = (text: string): ScmCommitMessagePort => ({
	async generateCommitMessage(input) {
		return { ok: true, text: `${text}@${input.cwd}` };
	},
});

describe("scmGenCommitMessage · 转发 + 发帧", () => {
	it("happy path：按当前对话的 cwd 调端口，回一帧 scm_data（kind=commitmsg / 原 reqId）", async () => {
		const { handlers, frames } = harness(okPort("feat: 生成提交信息"));
		await expect(handlers.scmGenCommitMessage(42)).resolves.toBeUndefined();
		expect(frames).toEqual([
			{ type: "scm_data", reqId: 42, kind: "commitmsg", ok: true, text: "feat: 生成提交信息@/work/project" },
		]);
	});

	it("端口回 ok:false（没模型 / 工作区干净 / 不是仓库 / 超时）时原样转成回执帧，不抛", async () => {
		const { handlers, frames } = harness({
			async generateCommitMessage(): Promise<ScmCommitMessageResult> {
				return { ok: false, error: "当前没有可用模型——先在顶栏选择一个模型再生成" };
			},
		});
		await expect(handlers.scmGenCommitMessage(7)).resolves.toBeUndefined();
		expect(frames).toEqual([
			{
				type: "scm_data",
				reqId: 7,
				kind: "commitmsg",
				ok: false,
				error: "当前没有可用模型——先在顶栏选择一个模型再生成",
			},
		]);
	});

	it("端口自己抛了也要回一帧 ok:false（前端不会永远等不到回执）", async () => {
		const { handlers, frames } = harness({
			async generateCommitMessage() {
				throw new Error("git failed");
			},
		});
		await expect(handlers.scmGenCommitMessage(9)).resolves.toBeUndefined();
		expect(frames).toEqual([{ type: "scm_data", reqId: 9, kind: "commitmsg", ok: false, error: "git failed" }]);
	});

	it("通道已关就不出帧（但端口照样被调用，宿主自己收尾）", async () => {
		let called = 0;
		const { handlers, frames } = harness(
			{
				async generateCommitMessage() {
					called++;
					return { ok: true, text: "chore: x" };
				},
			},
			{ closed: true },
		);
		await handlers.scmGenCommitMessage(1);
		expect(called).toBe(1);
		expect(frames).toEqual([]);
	});
});

describe("scmGenCommitMessage · 端口未注入", () => {
	it("同步抛 CoreEngineNotReadyError（不是 rejected promise，也不发半帧）", () => {
		const { handlers, frames } = harness(undefined);
		expect(() => handlers.scmGenCommitMessage(3)).toThrow(CoreEngineNotReadyError);
		expect(frames).toEqual([]);
	});
});
