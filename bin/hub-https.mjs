import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { httpsPlan } from "./hub-https-install.mjs";
import { writeAtomicFileSync } from "./lib/atomic-file.mjs";
import { randomUUID } from "node:crypto";

export function automaticHttps(publicUrl, platform = process.platform) {
	if (platform !== "linux") return false;
	try {
		const url = new URL(publicUrl);
		url.protocol = "https:";
		httpsPlan({ publicUrl: url.origin, upstream: "http://127.0.0.1:8790" });
		return true;
	} catch {
		return false;
	}
}
export function secureHubSettings(saved, publicUrl) {
	if (saved.PI_DEVICE_HUB_PATH_ACCESS === "0")
		throw Error(
			"Managed HTTPS requires path-based device access. Keep an external TLS proxy for legacy per-device ports.",
		);
	const source = publicUrl || saved.PI_DEVICE_HUB_PUBLIC_URL;
	const url = new URL(source);
	if (url.origin !== source || url.username || url.password || !["http:", "https:"].includes(url.protocol))
		throw Error("HTTPS public URL must be a canonical HTTP(S) origin");
	if (url.protocol === "http:") {
		url.protocol = "https:";
		url.port = "";
	}
	const input = {
		publicUrl: url.origin,
		upstream: "http://127.0.0.1:" + saved.PI_DEVICE_HUB_PORT,
		serviceName: saved.PI_DEVICE_HUB_SERVICE_NAME || "pi-device-hub",
	};
	const plan = httpsPlan(input);
	if (plan.port === Number(saved.PI_DEVICE_HUB_PORT))
		throw Error("The HTTPS port must differ from the internal Hub port (default HTTPS 443, Hub 8790)");
	const legacy = JSON.parse(saved.PI_DEVICE_HUB_LEGACY_ORIGINS || "[]");
	if (saved.PI_DEVICE_HUB_PUBLIC_URL.startsWith("http:")) legacy.push(saved.PI_DEVICE_HUB_PUBLIC_URL);
	return {
		input,
		settings: {
			...saved,
			PI_DEVICE_HUB_PUBLIC_URL: plan.publicUrl,
			PI_DEVICE_HUB_LEGACY_ORIGINS: JSON.stringify([...new Set(legacy)]),
			PI_DEVICE_HUB_HTTPS: "managed",
		},
	};
}
// Called only while the owned Hub is stopped. Preserve allocations and aliases, including changes
// made after a failed HTTPS start; rollback changes the origin, never restores an old data snapshot.
export async function migratePortalOrigin(dataDir, previous, next) {
	const path = join(dataDir, "device-portals.json");
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
	const registry = JSON.parse(text);
	if (registry.version !== 1 || !Array.isArray(registry.ports) || !Array.isArray(registry.allocations))
		throw Error("Invalid device portal registry; refusing HTTPS migration");
	if (registry.publicUrl === next) return false;
	if (registry.publicUrl !== previous) throw Error("Device portal origin does not match the installed Hub");
	registry.publicUrl = next;
	writeAtomicFileSync(path, JSON.stringify(registry), { nonce: randomUUID(), mode: 0o600 });
	return true;
}
async function privileged(file, signal) {
	const script = fileURLToPath(new URL("./hub-https-install.mjs", import.meta.url));
	const root = process.getuid?.() === 0;
	const child = spawn(
		root ? process.execPath : "sudo",
		root
			? [script, "--apply", file]
			: [...(process.stdin.isTTY ? [] : ["-n"]), process.execPath, script, "--apply", file],
		{ stdio: "inherit", signal },
	);
	const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
	try {
		await new Promise((r, j) => {
			child.on("error", j);
			child.on("exit", (code) =>
				code === 0 ? r() : j(Error("HTTPS certificate/proxy installation failed (" + code + ")")),
			);
		});
	} finally {
		clearTimeout(timer);
	}
}
export async function enableHubHttps({
	plan,
	publicUrl,
	run,
	probe,
	wait,
	signal,
	log = console.log,
	install = privileged,
	verify = fetch,
}) {
	if (process.platform !== "linux" && install === privileged)
		throw Error(
			"Managed HTTPS currently supports Linux systemd. Use --https=external with your HTTPS proxy on other platforms",
		);
	const original = await readFile(plan.config, "utf8"),
		saved = JSON.parse(original);
	const current = await probe(saved);
	if (!current || current.instanceId !== saved.PI_DEVICE_HUB_INSTANCE_ID)
		throw Error("HTTPS setup requires the installed, owned Hub to be running");
	const { input, settings } = secureHubSettings(saved, publicUrl);
	const file = join(plan.root, "https-install.json");
	await writeFile(file, JSON.stringify(input), { mode: 0o600 });
	log("Configuring trusted HTTPS and automatic certificate renewal. Administrator access may be requested.");
	await install(file, signal);
	const save = async (text) => writeAtomicFileSync(plan.config, text, { nonce: randomUUID(), mode: 0o600 });
	let migrated = false;
	try {
		signal?.throwIfAborted();
		for (const args of plan.commands.stop) run(plan.manager, args);
		migrated = await migratePortalOrigin(
			saved.PI_DEVICE_HUB_DATA_DIR,
			saved.PI_DEVICE_HUB_PUBLIC_URL,
			settings.PI_DEVICE_HUB_PUBLIC_URL,
		);
		await save(JSON.stringify(settings, null, 2) + "\n");
		for (const args of plan.commands.start) run(plan.manager, args);
		await wait(settings);
		const response = await verify(settings.PI_DEVICE_HUB_PUBLIC_URL + "/health", {
			signal: AbortSignal.timeout(15000),
		});
		const health = await response.json();
		if (!response.ok || health.service !== "pi-device-hub" || health.instanceId !== saved.PI_DEVICE_HUB_INSTANCE_ID)
			throw Error("HTTPS endpoint does not identify this Hub");
		log("HTTPS ready: " + settings.PI_DEVICE_HUB_PUBLIC_URL);
		return settings;
	} catch (error) {
		for (const args of plan.commands.stop) run(plan.manager, args);
		if (migrated)
			await migratePortalOrigin(
				saved.PI_DEVICE_HUB_DATA_DIR,
				settings.PI_DEVICE_HUB_PUBLIC_URL,
				saved.PI_DEVICE_HUB_PUBLIC_URL,
			);
		await save(original);
		for (const args of plan.commands.start) run(plan.manager, args);
		await wait(saved, true);
		throw Error(
			"HTTPS verification failed; restored the previous Hub configuration. Check public TCP 443/cloud firewall and certificate trust. " +
				error.message,
		);
	}
}
