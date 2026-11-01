import { randomUUID } from "node:crypto";
import type { DeviceIntegration, DeviceIntegrationValidationCommand } from "../protocol.js";
import { getAcceptedDeliveryForIntegration } from "./hub-deliveries.js";
import type { Bot, DeviceHubStore, HubState } from "./store.js";

function fail(status: number, message: string): never {
	throw Object.assign(new Error(message), { status });
}

function text(value: unknown, max: number, name: string): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
	) {
		fail(400, `Invalid ${name}`);
	}
	return value.trim();
}

function sha(value: unknown): string {
	const result = text(value, 64, "commit");
	if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(result)) fail(400, "Full commit SHA required");
	return result.toLowerCase();
}

function safeBranch(value: unknown): string {
	const result = text(value, 256, "branch");
	if (
		result.startsWith("-") ||
		/[\s~^:?*[\\\]]/.test(result) ||
		result.includes("..") ||
		result.startsWith("/") ||
		result.endsWith("/") ||
		result.endsWith(".lock")
	) {
		fail(400, "Invalid branch name");
	}
	return result;
}

function sanitizePublicError(error: unknown): string {
	if (!error) return "Integration operation failed";
	const raw = error instanceof Error ? error.message : String(error);
	return raw
		.replace(/\/\/[^@\s]+@/g, "//***@")
		.split("\n")[0]
		.trim()
		.slice(0, 300);
}

function wrapRpcError(error: unknown): Error {
	const err = error instanceof Error ? error : new Error(String(error));
	const msg = err.message.toLowerCase();
	if (!(err as any).status) {
		if (
			msg.includes("checked out") ||
			msg.includes("moved from") ||
			msg.includes("uncommitted") ||
			msg.includes("dirty") ||
			msg.includes("custom") ||
			msg.includes("mismatch") ||
			msg.includes("offline") ||
			msg.includes("cannot") ||
			msg.includes("rejected") ||
			msg.includes("conflict")
		) {
			Object.assign(err, { status: 409 });
		} else {
			Object.assign(err, { status: 502 });
		}
	}
	return err;
}

export interface IntegrationActor {
	accountId: string;
	bot?: Bot;
}

export interface HubIntegrationDriver {
	callDeviceCommand: (
		deviceId: string,
		action: string,
		payload: unknown,
		options?: { signal?: AbortSignal },
	) => Promise<unknown>;
}

export type HubStoreLike = Pick<DeviceHubStore, "transact" | "snapshot">;

/** 白名单验证并投影设备端准备集成返回的结果 */
function validateDevicePrepareResult(raw: unknown): {
	status: "prepared" | "conflict";
	expectedTargetSha: string;
	conflicts?: string[];
	diff?: string;
} {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		fail(502, "Invalid device response");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.status !== "prepared" && obj.status !== "conflict") {
		fail(502, "Invalid integration status from device");
	}
	const expectedTargetSha = sha(obj.expectedTargetSha);
	let conflicts: string[] | undefined;
	if (obj.conflicts !== undefined) {
		if (!Array.isArray(obj.conflicts) || obj.conflicts.some((c) => typeof c !== "string" || !c.trim())) {
			fail(502, "Invalid conflicts list from device");
		}
		conflicts = obj.conflicts.map((c) => text(c, 1024, "conflict path"));
	}
	let diff: string | undefined;
	if (obj.diff !== undefined) {
		diff = text(obj.diff, 64 * 1024, "diff");
	}
	return {
		status: obj.status,
		expectedTargetSha,
		conflicts,
		diff,
	};
}

/** 白名单验证并投影设备端验证命令返回的结果 */
function validateDeviceVerifyResult(raw: unknown): {
	status: "verified" | "failed";
	validationCommands: DeviceIntegrationValidationCommand[];
} {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		fail(502, "Invalid device response");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.status !== "verified" && obj.status !== "failed") {
		fail(502, "Invalid verification status from device");
	}
	if (!Array.isArray(obj.validationCommands)) {
		fail(502, "Invalid validationCommands from device");
	}
	const validationCommands: DeviceIntegrationValidationCommand[] = obj.validationCommands.map((v) => {
		if (!v || typeof v !== "object") fail(502, "Invalid validation command item");
		const item = v as Record<string, unknown>;
		const status = item.status === "passed" || item.status === "failed" ? item.status : "failed";
		return {
			command: text(item.command, 1024, "command"),
			status,
			exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
			output: typeof item.output === "string" ? item.output.slice(0, 16 * 1024) : undefined,
		};
	});
	return {
		status: obj.status,
		validationCommands,
	};
}

/** 白名单验证并投影设备端确认写入返回的结果 */
function validateDeviceConfirmResult(raw: unknown): {
	status: "applied";
	newCommitSha: string;
	cleanupPending?: boolean;
} {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		fail(502, "Invalid device response");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.status !== "applied") {
		fail(502, "Device failed to apply integration");
	}
	return {
		status: "applied",
		newCommitSha: sha(obj.newCommitSha),
		cleanupPending: !!obj.cleanupPending,
	};
}

/**
 * Hub 端准备集成：
 * 1. 同步 reservation：校验授权与 accepted delivery，添加 preparing 状态记录并持久化
 * 2. 事务外异步副作用：强制通过设备端 RPC 执行隔离工作树预合并（严禁本地 fallback！）
 * 3. 同步 commit：再次全量校验 Bot 版本、成员归属与 delivery 状态，持久化白名单投影结果
 */
export async function hubPrepareIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	actor: IntegrationActor,
	input: Record<string, unknown>,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	if (!driver?.callDeviceCommand) {
		fail(409, "Target device offline or command unavailable; Hub local execution is forbidden");
	}

	const deliveryId = text(input.deliveryId, 128, "deliveryId");
	const targetBotId = text(input.targetBotId, 128, "targetBotId");
	const targetBranch = safeBranch(input.targetBranch || "main");

	const integrationId = randomUUID();

	// Step 1: 同步 reservation
	const { delivery, targetBot } = await store.transact((draft) => {
		const room = draft.rooms.find((r) => r.id === roomId && r.accountId === actor.accountId);
		if (!room) fail(404, "Room missing");
		if (!room.botIds.includes(targetBotId)) fail(403, "Target Bot is not a room member");

		const bot = draft.bots.find((b) => b.id === targetBotId && b.accountId === actor.accountId && b.enabled);
		if (!bot) fail(404, "Target Bot not found or disabled");

		const { delivery: del, review } = getAcceptedDeliveryForIntegration(draft, conversationId, deliveryId);

		const initialRecord: DeviceIntegration = {
			id: integrationId,
			accountId: actor.accountId,
			roomId,
			conversationId,
			deliveryId,
			commit: del.commit,
			reviewId: review.id,
			targetBotId,
			targetBotRevision: bot.revision,
			targetBranch,
			expectedTargetSha: "",
			status: "preparing",
			validationCommands: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		draft.integrations.push(initialRecord);
		return { delivery: del, targetBot: { ...bot } };
	});

	// Step 2: 事务外异步调用设备 RPC
	try {
		const payload = {
			integrationId,
			roomId,
			targetBotId,
			targetBotRevision: targetBot.revision,
			targetBranch,
			commit: delivery.commit,
		};

		const rawResult = await driver.callDeviceCommand(targetBot.deviceId, "integration_prepare", payload);
		const deviceResult = validateDevicePrepareResult(rawResult);

		// Step 3: 同步 commit，并严密重新核验版本、归属与当前 delivery 状态
		return await store.transact((draft) => {
			const room = draft.rooms.find((r) => r.id === roomId && r.accountId === actor.accountId);
			if (!room || !room.botIds.includes(targetBotId)) fail(403, "Target Bot membership changed during integration");

			const currentBot = draft.bots.find((b) => b.id === targetBotId && b.accountId === actor.accountId && b.enabled);
			if (!currentBot || currentBot.revision !== targetBot.revision || currentBot.deviceId !== targetBot.deviceId) {
				fail(409, "Target Bot revision or hosting device changed during integration");
			}

			const { delivery: currentDelivery, review: currentReview } = getAcceptedDeliveryForIntegration(
				draft,
				conversationId,
				deliveryId,
			);
			if (currentDelivery.commit !== delivery.commit || currentReview.verdict !== "accepted") {
				fail(409, "Delivery or review state changed during preparation");
			}

			const record = draft.integrations.find((it) => it.id === integrationId);
			if (!record) fail(404, "Integration record missing");
			if (record.status !== "preparing") {
				fail(409, `Integration generation collision; expected 'preparing' but found '${record.status}'`);
			}

			record.status = deviceResult.status;
			record.expectedTargetSha = deviceResult.expectedTargetSha;
			record.conflicts = deviceResult.conflicts;
			record.diff = deviceResult.diff;
			record.updatedAt = Date.now();
			return { ...record };
		});
	} catch (error) {
		const errMsg = sanitizePublicError(error);
		await store.transact((draft) => {
			const record = draft.integrations.find((it) => it.id === integrationId);
			if (record && record.status === "preparing") {
				record.status = "failed";
				record.error = errMsg;
				record.updatedAt = Date.now();
			}
		});
		throw wrapRpcError(error);
	}
}

/**
 * Hub 端运行显式验证命令
 */
export async function hubVerifyIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	integrationId: string,
	actor: IntegrationActor,
	input: Record<string, unknown>,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	if (!driver?.callDeviceCommand) {
		fail(409, "Target device offline or command unavailable");
	}

	const rawCommands = input.commands;
	if (!Array.isArray(rawCommands) || rawCommands.length === 0) {
		fail(400, "Explicit commands array required");
	}
	const commands = rawCommands.map((c) => text(c, 1024, "command"));
	const opId = randomUUID();

	// Step 1: 同步 reservation
	const { targetBot } = await store.transact((draft) => {
		const record = draft.integrations.find(
			(it) =>
				it.id === integrationId &&
				it.roomId === roomId &&
				it.conversationId === conversationId &&
				it.accountId === actor.accountId,
		);
		if (!record) fail(404, "Integration task not found");
		if (record.status !== "prepared" && record.status !== "verified") {
			fail(409, `Cannot verify integration in status '${record.status}'`);
		}

		// 重新校验交付与 accepted 审查绑定
		const { delivery, review } = getAcceptedDeliveryForIntegration(draft, conversationId, record.deliveryId);
		if (delivery.commit !== record.commit || review.id !== record.reviewId || review.verdict !== "accepted") {
			fail(409, "Delivery or accepted review invalidated; verification rejected");
		}

		const bot = draft.bots.find((b) => b.id === record.targetBotId && b.accountId === actor.accountId && b.enabled);
		if (!bot || bot.revision !== record.targetBotRevision) {
			fail(409, "Target Bot revision mismatch or disabled");
		}

		record.status = "verifying";
		record.currentOpId = opId;
		record.updatedAt = Date.now();
		return { targetBot: { ...bot } };
	});

	// Step 2: 事务外调用设备 RPC
	try {
		const payload = {
			integrationId,
			roomId,
			targetBotId: targetBot.id,
			targetBotRevision: targetBot.revision,
			commands,
		};

		const rawResult = await driver.callDeviceCommand(targetBot.deviceId, "integration_verify", payload);
		const deviceResult = validateDeviceVerifyResult(rawResult);

		// Step 3: 同步 commit
		return await store.transact((draft) => {
			const record = draft.integrations.find((it) => it.id === integrationId);
			if (!record) fail(404, "Integration record missing");
			if (record.status !== "verifying" || record.currentOpId !== opId) {
				fail(409, "Verification generation mismatch");
			}

			record.status = deviceResult.status;
			record.validationCommands = deviceResult.validationCommands;
			record.updatedAt = Date.now();
			return { ...record };
		});
	} catch (error) {
		const errMsg = sanitizePublicError(error);
		await store.transact((draft) => {
			const record = draft.integrations.find((it) => it.id === integrationId);
			if (record && record.status === "verifying" && record.currentOpId === opId) {
				record.status = "failed";
				record.error = errMsg;
				record.updatedAt = Date.now();
			}
		});
		throw wrapRpcError(error);
	}
}

/**
 * Hub 端确认写入目标分支
 */
export async function hubConfirmIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	integrationId: string,
	actor: IntegrationActor,
	input: Record<string, unknown>,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	if (!driver?.callDeviceCommand) {
		fail(409, "Target device offline or command unavailable");
	}
	const opId = randomUUID();

	// Step 1: 同步 reservation
	const { integration, targetBot, expectedTargetSha } = await store.transact((draft) => {
		const record = draft.integrations.find(
			(it) =>
				it.id === integrationId &&
				it.roomId === roomId &&
				it.conversationId === conversationId &&
				it.accountId === actor.accountId,
		);
		if (!record) fail(404, "Integration task not found");
		if (record.status !== "prepared" && record.status !== "verified" && record.status !== "failed") {
			fail(409, `Integration in status '${record.status}' cannot be applied`);
		}

		const { delivery, review } = getAcceptedDeliveryForIntegration(draft, conversationId, record.deliveryId);
		if (delivery.commit !== record.commit) {
			fail(409, "Delivery commit changed; integration rejected");
		}
		if (review.id !== record.reviewId || review.verdict !== "accepted") {
			fail(409, "Delivery accepted review invalidated; integration rejected");
		}

		const expSha = text(input.expectedTargetSha || record.expectedTargetSha, 64, "expectedTargetSha");
		if (expSha !== record.expectedTargetSha) {
			fail(409, "Expected target SHA mismatch");
		}

		const bot = draft.bots.find((b) => b.id === record.targetBotId && b.accountId === actor.accountId && b.enabled);
		if (!bot || bot.revision !== record.targetBotRevision) {
			fail(409, "Target Bot revision mismatch or disabled");
		}

		record.status = "applying";
		record.currentOpId = opId;
		record.updatedAt = Date.now();
		return { integration: { ...record }, targetBot: { ...bot }, expectedTargetSha: expSha };
	});

	// Step 2: 事务外调用设备 RPC
	try {
		const payload = {
			integrationId,
			roomId,
			targetBotId: targetBot.id,
			targetBotRevision: targetBot.revision,
			deliveryId: integration.deliveryId,
			commit: integration.commit,
			expectedTargetSha,
		};

		const rawResult = await driver.callDeviceCommand(targetBot.deviceId, "integration_confirm", payload);
		const deviceResult = validateDeviceConfirmResult(rawResult);

		// Step 3: 同步 commit
		return await store.transact((draft) => {
			const record = draft.integrations.find((it) => it.id === integrationId);
			if (!record) fail(404, "Integration record missing");
			if (record.status !== "applying" || record.currentOpId !== opId) {
				fail(409, "Integration application generation mismatch");
			}

			record.status = "applied";
			record.newCommitSha = deviceResult.newCommitSha;
			if (deviceResult.cleanupPending) {
				record.cleanupPending = true;
			}
			record.updatedAt = Date.now();
			return { ...record };
		});
	} catch (error) {
		const errMsg = sanitizePublicError(error);
		await store.transact((draft) => {
			const record = draft.integrations.find((it) => it.id === integrationId);
			if (record && record.status === "applying" && record.currentOpId === opId) {
				record.status = "failed";
				record.error = errMsg;
				record.updatedAt = Date.now();
			}
		});
		throw wrapRpcError(error);
	}
}

/**
 * Hub 端取消集成
 */
export async function hubCancelIntegration(
	store: HubStoreLike,
	roomId: string,
	conversationId: string,
	integrationId: string,
	actor: IntegrationActor,
	driver?: HubIntegrationDriver,
): Promise<DeviceIntegration> {
	// Step 1: 同步 reservation
	const { targetBot } = await store.transact((draft) => {
		const record = draft.integrations.find(
			(it) =>
				it.id === integrationId &&
				it.roomId === roomId &&
				it.conversationId === conversationId &&
				it.accountId === actor.accountId,
		);
		if (!record) fail(404, "Integration task not found");
		if (record.status === "applied") {
			fail(409, "Already applied integration cannot be cancelled");
		}
		if (record.status === "applying") {
			fail(409, "Integration is currently being applied and cannot be cancelled");
		}
		if (record.status === "cancelled") {
			return { targetBot: undefined };
		}
		record.status = "cancelling";
		record.updatedAt = Date.now();
		const bot = draft.bots.find((b) => b.id === record.targetBotId && b.accountId === actor.accountId);
		return { targetBot: bot ? { ...bot } : undefined };
	});

	// Step 2: 事务外异步调用设备 RPC
	let rpcError: unknown;
	try {
		if (targetBot && driver?.callDeviceCommand) {
			const payload = { integrationId, roomId, targetBotId: targetBot.id };
			await driver.callDeviceCommand(targetBot.deviceId, "integration_cancel", payload);
		}
	} catch (error) {
		rpcError = error;
	}

	// Step 3: 严格终态 CAS，防止覆盖并发已 applied 终态
	const result = await store.transact((draft) => {
		const rec = draft.integrations.find((it) => it.id === integrationId);
		if (!rec) fail(404, "Integration record missing");
		if (rec.status === "applied") {
			return { ...rec };
		}
		rec.status = "cancelled";
		if (rpcError) {
			rec.error = sanitizePublicError(rpcError);
		}
		rec.updatedAt = Date.now();
		return { ...rec };
	});
	if (rpcError) throw rpcError;
	return result;
}

/** 查询会话的集成历史记录 */
export function listIntegrations(state: HubState, conversationId: string): DeviceIntegration[] {
	return state.integrations.filter((it) => it.conversationId === conversationId);
}
