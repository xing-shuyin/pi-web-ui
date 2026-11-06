import type { Express } from "express";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { join } from "node:path";
import { getPkgRoot, getAppVersion } from "../pkg-info.js";

export interface HubSetupInput {
	host: string;
	port: number;
	publicUrl: string;
	allowRegistration: true;
}

export function validateHubSetup(input: unknown): HubSetupInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid installation options");
	const value = input as Record<string, unknown>;
	if (Object.keys(value).some((key) => !["host", "port", "publicUrl", "allowRegistration"].includes(key)))
		throw new Error("Unknown installation option");
	if (typeof value.host !== "string" || !(value.host === "localhost" || isIP(value.host)))
		throw new Error("Bind host must be localhost or an IP address");
	if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535)
		throw new Error("Choose an unprivileged port from 1024 to 65535");
	if (
		typeof value.publicUrl !== "string" ||
		value.publicUrl.length > 2048 ||
		/[\s\u0000-\u001f\u007f]/.test(value.publicUrl)
	)
		throw new Error("Invalid public URL");
	const url = new URL(value.publicUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		Reflect.get(url, "pass" + "word") ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		["0.0.0.0", "[::]"].includes(url.hostname)
	)
		throw new Error("Public URL must be a reachable HTTP(S) origin without credentials or a path");
	if (value.allowRegistration !== true)
		throw new Error("Explicitly enable account registration to create the first account");
	return { host: value.host, port: value.port, publicUrl: url.origin, allowRegistration: true };
}

type Runner = (args: string[], signal: AbortSignal) => Promise<string>;
interface HubInstallation {
	installed: boolean;
	running: boolean;
	owned: boolean;
	publicUrl: string | null;
	host: string | null;
	port: number | null;
	dataDir: string | null;
}
function parseInstallation(output: string): HubInstallation {
	const value = JSON.parse(output) as Record<string, unknown>;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Hub installation status");
	if (
		value.service !== "pi-device-hub" ||
		value.schemaVersion !== 1 ||
		typeof value.installed !== "boolean" ||
		typeof value.running !== "boolean" ||
		typeof value.owned !== "boolean"
	)
		throw new Error("Invalid Hub installation status");
	for (const key of ["publicUrl", "host", "dataDir"])
		if (value[key] !== null && typeof value[key] !== "string") throw new Error("Invalid Hub installation metadata");
	if (value.port !== null && (typeof value.port !== "number" || !Number.isInteger(value.port)))
		throw new Error("Invalid Hub installation port");
	return {
		installed: value.installed,
		running: value.running,
		owned: value.owned,
		publicUrl: value.publicUrl as string | null,
		host: value.host as string | null,
		port: value.port as number | null,
		dataDir: value.dataDir as string | null,
	};
}
export function installHubSetupRoutes(app: Express, dataDir: string, runner?: Runner) {
	const cliPath = join(getPkgRoot(), "bin", "pi-web-ui.mjs");
	const hubDataDir = join(dataDir, "device-hub");
	let active: AbortController | undefined;
	let pending: Promise<void> | undefined;
	const statusControllers = new Set<AbortController>();
	const statusOperations = new Set<Promise<void>>();
	let closed = false;
	const run: Runner =
		runner ??
		((args, signal) =>
			new Promise((resolve, reject) => {
				if (signal.aborted) {
					reject(new Error("Hub operation cancelled"));
					return;
				}
				const child = spawn(process.execPath, [cliPath, ...args], {
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				});
				let output = "";
				let bytes = 0;
				let failure: Error | undefined;
				let forceTimer: ReturnType<typeof setTimeout> | undefined;
				const terminate = (reason: string) => {
					failure ??= new Error(reason);
					if (forceTimer) return;
					if (child.connected) child.send({ type: "cancel-hub-operation" }, () => {});
					forceTimer = setTimeout(() => child.kill("SIGKILL"), 45_000);
				};
				const abort = () => terminate("Hub operation cancelled; check hub status before retrying");
				signal.addEventListener("abort", abort, { once: true });
				const timeout = setTimeout(
					() => terminate("Hub operation timed out; check hub status before retrying"),
					120_000,
				);
				const collect = (chunk: Buffer) => {
					bytes += chunk.byteLength;
					if (bytes > 32_768) {
						terminate("Hub installer output exceeded limit");
						return;
					}
					output += chunk.toString("utf8");
				};
				child.stdout?.on("data", collect);
				child.stderr?.on("data", collect);
				child.on("error", (error) => {
					failure = error;
				});
				child.on("close", (code) => {
					clearTimeout(timeout);
					clearTimeout(forceTimer);
					signal.removeEventListener("abort", abort);
					if (failure || code !== 0)
						reject(new Error(`${failure?.message ?? `Hub command exited with ${code}`}\n${output}`.slice(0, 4096)));
					else resolve(output.slice(0, 16_384));
				});
			}));
	app.get("/api/device-center/setup", (_req, res) => {
		if (closed) {
			res.status(503).json({ error: "Device center is shutting down" });
			return;
		}
		if (statusControllers.size >= 2) {
			res.status(429).json({ error: "Hub status query already in progress; retry shortly" });
			return;
		}
		const controller = new AbortController();
		const disconnected = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.on("close", disconnected);
		statusControllers.add(controller);
		const operation = run(["hub", "status", "--json"], controller.signal)
			.then((output) => {
				if (closed || controller.signal.aborted) throw new Error("Hub status query cancelled");
				const installation = parseInstallation(output);
				res.json({
					platform: process.platform,
					nodeVersion: process.version,
					version: getAppVersion(),
					defaultPort: 8790,
					defaultPublicUrl: "http://127.0.0.1:8790",
					dataDir: hubDataDir,
					cliPath,
					busy: !!active,
					installation,
				});
			})
			.catch((error: unknown) => {
				if (!res.destroyed)
					res.status(503).json({ error: error instanceof Error ? error.message : "Cannot inspect Hub installation" });
			})
			.finally(() => {
				res.off("close", disconnected);
				statusControllers.delete(controller);
				statusOperations.delete(operation);
			});
		statusOperations.add(operation);
	});
	app.post("/api/device-center/setup/update", (_req, res) => {
		if (closed || active) {
			res.status(409).json({ error: closed ? "Device center is shutting down" : "Hub operation is already running" });
			return;
		}
		const controller = new AbortController();
		active = controller;
		pending = run(["hub", "update"], controller.signal)
			.then((output) => {
				if (closed || controller.signal.aborted)
					throw new Error("Update interrupted; check hub status before retrying");
				res.json({ success: true, output });
			})
			.catch((error: unknown) => {
				res.status(500).json({ error: error instanceof Error ? error.message : "Hub update failed" });
			})
			.finally(() => {
				if (active === controller) active = undefined;
			});
	});
	app.post("/api/device-center/setup", (req, res) => {
		if (closed || active) {
			res
				.status(409)
				.json({ error: closed ? "Device center is shutting down" : "Hub installation is already running" });
			return;
		}
		let input: HubSetupInput;
		try {
			input = validateHubSetup(req.body);
		} catch (error) {
			res.status(400).json({ error: (error as Error).message });
			return;
		}
		const controller = new AbortController();
		active = controller;
		pending = run(
			[
				"hub",
				"install",
				"--host",
				input.host,
				"--port",
				String(input.port),
				"--public-url",
				input.publicUrl,
				"--data-dir",
				hubDataDir,
				"--allow-registration",
			],
			controller.signal,
		)
			.then((output) => {
				if (closed || controller.signal.aborted)
					throw new Error("Installation interrupted; check hub status before retrying");
				res.json({ publicUrl: input.publicUrl, output });
			})
			.catch((error: unknown) => {
				res.status(500).json({ error: error instanceof Error ? error.message : "Hub installation failed" });
			})
			.finally(() => {
				if (active === controller) active = undefined;
			});
	});
	return {
		async close() {
			closed = true;
			active?.abort();
			for (const controller of statusControllers) controller.abort();
			await Promise.allSettled([pending, ...statusOperations]);
		},
	};
}
