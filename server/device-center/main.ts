import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createDeviceHub } from "./hub.js";
import { createDeviceRelay } from "./relay.js";
import { renderDeviceHubPage } from "./hub-page.js";
import { installDeviceTransfers } from "./transfers.js";
import { createServer, type Server } from "node:http";
import { DevicePortals, parsePortalPorts } from "./device-portals.js";

/** Separate process: never shares a pi-web-ui data directory or SDK runtime. */
export async function startDeviceHub(env: NodeJS.ProcessEnv = process.env) {
	const publicUrl = env.PI_DEVICE_HUB_PUBLIC_URL;
	const deviceDomain = env.PI_DEVICE_HUB_DEVICE_DOMAIN || undefined;
	const pathAccess = env.PI_DEVICE_HUB_PATH_ACCESS !== "0";
	if (!publicUrl) throw new Error("Set PI_DEVICE_HUB_PUBLIC_URL; see docs/device-center.md");
	const port = Number(env.PI_DEVICE_HUB_PORT ?? 8790);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid hub port");
	const dataDir = resolve(env.PI_DEVICE_HUB_DATA_DIR ?? join(homedir(), ".pi-device-hub"));
	const portalPorts = parsePortalPorts(env.PI_DEVICE_HUB_PORTAL_PORTS);
	if (
		portalPorts.includes(port) ||
		portalPorts.includes(Number(new URL(publicUrl).port || (new URL(publicUrl).protocol === "https:" ? 443 : 80)))
	)
		throw new Error("Portal port must differ from hub port");
	const portals = await DevicePortals.open(dataDir, publicUrl, portalPorts, { pathAccess });
	const portalServers: Server[] = [];
	let relay: ReturnType<typeof createDeviceRelay> | undefined;
	const hub = await createDeviceHub({
		dataDir: resolve(env.PI_DEVICE_HUB_DATA_DIR ?? join(homedir(), ".pi-device-hub")),
		publicUrl,
		deviceDomain,
		pathAccess,
		portals,
		allowRegistration: env.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1",
		isOnline: (id) => relay?.isOnline(id) ?? false,
		onTask: (id, task) => {
			if (!relay?.sendTask(id, task)) throw new Error("Device unavailable; task was not delivered");
		},
		onRevoke: (id) => {
			relay?.revoke(id);
		},
	});
	relay = createDeviceRelay({
		server: hub.server,
		publicUrl,
		deviceDomain,
		deviceOrigins: () => portals.origins(),
		pathAccess,
		authenticateDevice: (id, credential) => hub.store.authenticateDevice(id, credential),
		getAccount: (req) => hub.getRelayAccount(req),
		ownsDevice: (accountId, id) => hub.store.getDeviceOwner(id) === accountId,
		getDeviceName: (id) => hub.store.getDevice(id)?.name,
		onTaskEvent: (id, event) => hub.acceptTaskEvent(id, event).then(() => undefined),
		onTaskInteractions: (id, event) => hub.acceptInteractions(id, event),
		onTaskProgress: (id, event) => hub.acceptTaskProgress(id, event),
		onTaskToolLifecycle: (id, frame) => hub.acceptTaskToolLifecycle(id, frame),
		onTaskPlanReady: (id, frame) => hub.acceptTaskPlanReady(id, frame),
		onTaskClaim: (id, claim) => hub.claimTask(id, claim),
		onTaskLeaseRenew: (id, renew) => hub.renewTaskLease(id, renew),
		onTaskDisconnect: (id, taskId, attemptId) => hub.onTaskDisconnect(id, taskId, attemptId),
	});
	hub.setRelay(relay);
	const transfers = await installDeviceTransfers({
		app: hub.app,
		hub,
		dataDir: resolve(env.PI_DEVICE_HUB_DATA_DIR ?? join(homedir(), ".pi-device-hub")),
		relay,
	});
	hub.app.get("/", (_req, res) => {
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		);
		res.setHeader("Cache-Control", "no-store");
		res.type("html").send(renderDeviceHubPage());
	});
	const closePortals = async () => {
		await Promise.all(
			portalServers.map(
				(server) =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						if (!server.listening) return done();
						server.close(() => done());
					}),
			),
		);
	};
	try {
		for (const portalPort of pathAccess ? [] : portalPorts) {
			const server = createServer((req, res) => {
				if (
					req.headers.host !==
						new URL(`${new URL(publicUrl).protocol}//${new URL(publicUrl).hostname}:${portalPort}`).host ||
					!relay?.handleRequest(req, res)
				)
					res.writeHead(403).end();
			});
			server.on("upgrade", (req, socket, head) => {
				if (
					req.headers.host !==
					new URL(`${new URL(publicUrl).protocol}//${new URL(publicUrl).hostname}:${portalPort}`).host
				)
					return socket.destroy();
				relay!.handleUpgrade(req, socket, head);
			});
			portalServers.push(server);
			await listen(server, portalPort);
		}
		await listen(hub.server, port);
	} catch (error) {
		await transfers.close();
		relay.close();
		await closePortals();
		await hub.close();
		throw error;
	}
	function listen(server: Server, listenPort: number) {
		return new Promise<void>((done, reject) => {
			server.once("error", reject);
			server.listen(listenPort, env.PI_DEVICE_HUB_HOST ?? "127.0.0.1", () => {
				server.off("error", reject);
				done();
			});
		});
	}
	console.log(
		`[device-hub] ${publicUrl} (listen ${port}; registration ${env.PI_DEVICE_HUB_ALLOW_REGISTRATION === "1" ? "enabled" : "disabled"})`,
	);
	return {
		...hub,
		portals,
		async close() {
			await transfers.close();
			relay?.close();
			await closePortals();
			await hub.close();
		},
	};
}
