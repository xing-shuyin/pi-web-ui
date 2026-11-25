import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../../server/protocol.js";
import {
	SCM_COMMITMSG_UNWIRED,
	type ScmCommitMessagePort,
	type ScmCommitMessageResult,
} from "../../packages/keel/src/contracts/scm.js";
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
	it("照样回一帧 ok:false（不抛、不留空等）：分发层 `void` 调用，抛了前端一帧都收不到", async () => {
		const { handlers, frames } = harness(undefined);
		await expect(handlers.scmGenCommitMessage(3)).resolves.toBeUndefined();
		expect(frames).toEqual([
			{ type: "scm_data", reqId: 3, kind: "commitmsg", ok: false, error: SCM_COMMITMSG_UNWIRED },
		]);
	});

	it("端口 cherry-pick 不到（thunk 回 undefined）也不抛；通道已关就不出帧", async () => {
		const frames: ServerMessage[] = [];
		const handlers = createScmHandlers({
			scm: () => undefined,
			transport: { send: (msg) => frames.push(msg), isClosed: () => true },
			cwd: () => "/work/project",
		});
		await expect(handlers.scmGenCommitMessage(5)).resolves.toBeUndefined();
		expect(frames).toEqual([]);
	});

	it("cwd 取值自己炸了也回帧（不把异常攼到分发层）", async () => {
		const frames: ServerMessage[] = [];
		const handlers = createScmHandlers({
			scm: () => okPort("feat: x"),
			transport: { send: (msg) => frames.push(msg), isClosed: () => false },
			cwd: () => {
				throw new Error("no active conversation");
			},
		});
		await expect(handlers.scmGenCommitMessage(11)).resolves.toBeUndefined();
		expect(frames).toEqual([
			{ type: "scm_data", reqId: 11, kind: "commitmsg", ok: false, error: "no active conversation" },
		]);
	});
});
