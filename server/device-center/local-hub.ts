import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { createDeviceHub } from "./hub.js";
import { createDeviceRelay } from "./relay.js";
import { installDeviceTransfers } from "./transfers.js";
import { hashSecret } from "./store.js";
import type { LocalDeviceConfig } from "./local.js";

/** Private loopback Hub: uses the same authenticated Bot, room and task paths as a remote Hub. */
export async function createLocalDeviceHub(dataDir: string) {
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
		});
		const credential = randomBytes(32).toString("hex");
		const uiCredential = randomBytes(32).toString("hex");
		// Stable local identity and durable rooms; credentials are rotated on every process start.
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
			getDeviceName: (id) => hub!.store.getDevice(id)?.name,
			onTaskProgress: (id, event) => hub!.acceptTaskProgress(id, event),
			onTaskToolLifecycle: (id, frame) => hub!.acceptTaskToolLifecycle(id, frame),
			onTaskPlanReady: (id, frame) => hub!.acceptTaskPlanReady(id, frame),
			onTaskInteractions: (id, event) => hub!.acceptInteractions(id, event),
			onTaskEvent: async (id, event) => {
				await hub!.acceptTaskEvent(id, event);
			},
			onTaskClaim: (id, claim) => hub!.claimTask(id, claim),
			onTaskLeaseRenew: (id, renew) => hub!.renewTaskLease(id, renew),
			onTaskDisconnect: (id, taskId, attemptId) => hub!.onTaskDisconnect(id, taskId, attemptId),
		});
		hub.setRelay({
			onTask: relay.sendTask,
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
			credential,
			uiCredential,
			allowExecution: true,
		};
		return {
			config,
			async close() {
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
