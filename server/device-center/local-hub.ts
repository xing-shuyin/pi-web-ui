import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { createDeviceHub } from "./hub.js";
import { createDeviceRelay } from "./relay.js";
import { installDeviceTransfers } from "./transfers.js";
import { hashSecret, isTerminal } from "./store.js";
import { createLocalTaskBridge, isLocalTaskRuntime } from "./local-task-bridge.js";
import type { LocalDeviceConfig } from "./local.js";
import type { DeviceExecutionSettings } from "./execution-settings.js";

export async function createLocalDeviceHub(dataDir: string, getSettings?: () => DeviceExecutionSettings) {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Local Hub address unavailable");
	const hubUrl = `http://127.0.0.1:${address.port}`;
	let hub: Awaited<ReturnType<typeof createDeviceHub>> | undefined;
	let relay: ReturnType<typeof createDeviceRelay> | undefined;
	try {
		hub = await createDeviceHub({
			dataDir: join(dataDir, "local-device-hub"),
			publicUrl: hubUrl,
			server,
			isOnline: (id) => relay?.isOnline(id) ?? false,
			getSettings,
		});
		const credential = randomBytes(32).toString("hex");
		const uiCredential = randomBytes(32).toString("hex");
		const accountId = "local-account";
		const deviceId = "local-device";
		await hub.store.transact((draft) => {
			if (!draft.accounts.some((account) => account.id === accountId))
				draft.accounts.push({ id: accountId, username: "local", passwordHash: "", createdAt: Date.now() });
			const device = {
				id: deviceId,
				accountId,
				name: hostname(),
				credentialHash: hashSecret(credential),
				uiCredentialHash: hashSecret(uiCredential),
				createdAt: Date.now(),
			};
			const previous = draft.devices.find((entry) => entry.id === deviceId);
			if (previous) Object.assign(previous, device, { createdAt: previous.createdAt });
			else draft.devices.push(device);
		});
		relay = createDeviceRelay({
			server,
			publicUrl: hubUrl,
			getAccount: hub.getRelayAccount,
			authenticateDevice: (id, token) => hub!.store.authenticateDevice(id, token),
			ownsDevice: (owner, id) => hub!.store.getDeviceOwner(id) === owner,
			getDeviceIds: (owner) =>
				hub!.store
					.snapshot()
					.devices.filter((device) => device.accountId === owner)
					.map((device) => device.id),
			getDeviceName: (id) => hub!.store.getDevice(id)?.name,
			getDeviceRemark: (id) => hub!.store.getDevice(id)?.remark,
			onTaskProgress: (id, event) => hub!.acceptTaskProgress(id, event),
			onTaskToolLifecycle: (id, frame) => hub!.acceptTaskToolLifecycle(id, frame),
			onTaskPlanReady: (id, frame) => hub!.acceptTaskPlanReady(id, frame),
			onTaskInteractions: (id, event) => hub!.acceptInteractions(id, event),
			onTaskEvent: (id, event) => hub!.acceptTaskEvent(id, event),
			onDeviceConnect: async (id) => {
				await Promise.all([hub!.resumeQueuedTasks(id), hub!.reconcilePendingPublications(id)]);
			},
			onTaskClaim: (id, claim) => hub!.claimTask(id, claim),
			onTaskLeaseRenew: (id, renew) => hub!.renewTaskLease(id, renew),
			onTaskDisconnect: (id, taskId, attemptId) => hub!.onTaskDisconnect(id, taskId, attemptId),
		});
		hub.setRelay({
			onTask: relay.sendTask,
			cancelTask: relay.cancelTask,
			steerTask: relay.steerTask,
			answerInteraction: relay.answerInteraction,
			onRevoke: relay.revoke,
			handleRequest: relay.handleRequest,
			callDevice: relay.callDevice,
		});
		const transfers = await installDeviceTransfers({
			app: hub.app,
			hub,
			dataDir: join(dataDir, "local-device-hub"),
			relay,
		});
		const config: LocalDeviceConfig = {
			hubUrl,
			name: hostname(),
			deviceId,
			accountId,
			credential,
			uiCredential,
			allowExecution: true,
			// 端口每次启动都变，历史/恢复/锁的作用域必须用这个稳定身份（见 runtime 的 hubKey）。
			hubIdentity: "local-device-hub",
		};
		return {
			config,
			/**
			 * 只读忙碌视图：哪些 Bot 现在有未完成的任务（给左栏"执行中"徽标投影用）。
			 * 不暴露 store，宿主只能读到聚合结果。
			 */
			busyBots(): Set<string> {
				const tasks = hub?.store.snapshot().tasks ?? [];
				return new Set(tasks.filter((task) => task.botId && !isTerminal(task.status)).map((task) => task.botId));
			},
			/**
			 * 本机设备运行时就绪后接管任务直调（`index.ts` 创建 runtime 之后由 `local.ts` 调用）。
			 * 直调命中时 Hub 不再把任务经 relay 发出，因此私聊不再依赖 WS 送达/帧回写。
			 */
			attachLocalDeviceRuntime(runtime: unknown) {
				const target = hub;
				// 嵌入方可能只给调度视图（测试、第三方宿主）：缺直调能力就继续走 relay。
				if (!target || !isLocalTaskRuntime(runtime)) return false;
				target.setLocalTaskExecutor(
					createLocalTaskBridge({
						deviceId,
						hubUrl,
						credential,
						runtime,
						hub: {
							acceptTaskEvent: (id, event) => target.acceptTaskEvent(id, event),
							acceptTaskProgress: (id, event) => target.acceptTaskProgress(id, event),
							acceptTaskToolLifecycle: (id, frame) => target.acceptTaskToolLifecycle(id, frame),
							acceptInteractions: (id, event) => target.acceptInteractions(id, event),
							acceptTaskPlanReady: (id, frame) => target.acceptTaskPlanReady(id, frame as never),
							renewTaskLease: (id, renew) => target.renewTaskLease(id, renew),
						},
					}),
				);
				return true;
			},
			async close() {
				hub?.setLocalTaskExecutor(undefined);
				await transfers.close();
				relay?.close();
				await hub?.close();
			},
		};
	} catch (error) {
		relay?.close();
		if (hub) await hub.close();
		else await new Promise<void>((resolve) => server.close(() => resolve()));
		throw error;
	}
}
