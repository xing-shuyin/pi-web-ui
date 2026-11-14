import { spawn } from "node:child_process";
import { readFile, mkdir, readdir, access, unlink, stat } from "node:fs/promises";
import { isIP, createServer } from "node:net";
import { X509Certificate, randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomicFileSync } from "./lib/atomic-file.mjs";

const MARKER = "Managed by pi-web-ui Hub HTTPS";
export function httpsPlan({ publicUrl, upstream, serviceName = "pi-device-hub" }) {
	const url = new URL(publicUrl),
		target = new URL(upstream),
		host = url.hostname.replace(/^\[|\]$/g, "");
	if (
		url.origin !== publicUrl ||
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!/^pi-device-hub(?:-[a-z0-9-]{1,48})?$/.test(serviceName)
	)
		throw Error("Invalid Hub HTTPS configuration");
	if (target.protocol !== "http:" || target.origin !== upstream || !["127.0.0.1", "[::1]"].includes(target.hostname))
		throw Error("HTTPS requires a loopback Hub upstream");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".invalid") ||
		(!isIP(host) && !host.includes(".")) ||
		/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|(?:22[4-9]|2[3-5]\d)\.)/.test(
			host,
		)
	)
		throw Error("A publicly reachable IP address or DNS name is required for a trusted certificate");
	if (isIP(host) === 6)
		throw Error("Automatic IPv6 certificate deployment is not supported yet; use an external HTTPS proxy");
	const unit = serviceName + "-https",
		root = "/etc/" + unit,
		lib = "/usr/local/lib/" + unit;
	return {
		publicUrl,
		upstream,
		host,
		port: Number(url.port || 443),
		serviceName,
		unit,
		root,
		lib,
		config: root + "/gateway.json",
		gateway: lib + "/gateway.mjs",
		webroot: "/var/lib/" + unit + "/acme",
		certName: unit,
		renew: unit + "-renew",
		acme: unit + "-acme",
	};
}
export async function command(file, args, { timeout = 600000, capture = false } = {}) {
	const child = spawn(file, args, {
		stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
		windowsHide: true,
	});
	let text = "";
	if (capture) {
		const collect = (b) => {
			text = (text + b).slice(-65536);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
	}
	const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
	try {
		await new Promise((r, j) => {
			child.on("error", j);
			child.on("exit", (c) => (c === 0 ? r() : j(Error(file + " failed (" + c + "); check the installation log"))));
		});
		return text;
	} finally {
		clearTimeout(timer);
	}
}
async function ownedWrite(file, content, mode = 0o644) {
	try {
		const old = await readFile(file, "utf8");
		if (!old.includes(MARKER)) throw Error("Refusing to replace unmanaged file: " + file);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	await mkdir(dirname(file), { recursive: true });
	writeAtomicFileSync(file, content, { nonce: randomUUID(), mode });
}
const quote = (value) =>
	'"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$") + '"';
export function httpsUnits(plan, node, certbot, certName) {
	const service = (description, args) =>
		`# ${MARKER}\n[Unit]\nDescription=${description}\nAfter=network-online.target\n[Service]\nExecStart=${[node, plan.gateway, ...args].map(quote).join(" ")}\nRestart=on-failure\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=read-only\nProtectSystem=strict\n[Install]\nWantedBy=multi-user.target\n`;
	return {
		[plan.unit + ".service"]: service("pi-web-ui HTTPS gateway", ["--config", plan.config]),
		[plan.acme + ".service"]: service("pi-web-ui ACME challenge only", ["--acme-root", plan.webroot]),
		[plan.renew + ".service"]:
			`# ${MARKER}\n[Unit]\nDescription=Renew pi-web-ui HTTPS certificate\n[Service]\nType=oneshot\nExecStart=${[certbot, "renew", "--cert-name", certName, "--quiet", "--no-random-sleep-on-renew"].map(quote).join(" ")}\n`,
		[plan.renew + ".timer"]:
			`# ${MARKER}\n[Unit]\nDescription=Check pi-web-ui certificate renewal every six hours\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=6h\nRandomizedDelaySec=10min\nPersistent=true\n[Install]\nWantedBy=timers.target\n`,
	};
}
export function certificateCommand(plan, certbot) {
	return [
		certbot,
		"certonly",
		"--non-interactive",
		"--agree-tos",
		"--register-unsafely-without-email",
		"--webroot",
		"--webroot-path",
		plan.webroot,
		"--cert-name",
		plan.certName,
		...(isIP(plan.host) ? ["--required-profile", "shortlived", "--ip-address", plan.host] : ["-d", plan.host]),
	];
}
async function certbotExecutable() {
	for (const file of ["/snap/bin/certbot", "/usr/bin/certbot", "/opt/pi-device-hub-certbot/bin/certbot"])
		try {
			const text = await command(file, ["--version"], { timeout: 15000, capture: true });
			const v = /certbot\s+(\d+)\.(\d+)/.exec(text);
			if (v && (Number(v[1]) > 5 || (Number(v[1]) === 5 && Number(v[2]) >= 4))) return file;
		} catch {}
	try {
		await access("/usr/bin/apt-get");
	} catch {
		throw Error(
			"Install Certbot >= 5.4 first on this Linux distribution; automatic dependency installation currently supports Debian/Ubuntu",
		);
	}
	await command("/usr/bin/apt-get", ["update", "-qq"]);
	await command("/usr/bin/apt-get", ["install", "-y", "-qq", "python3-venv"]);
	await command("/usr/bin/python3", ["-m", "venv", "/opt/pi-device-hub-certbot"]);
	await command("/opt/pi-device-hub-certbot/bin/python", ["-m", "pip", "install", "--quiet", "certbot>=5.4,<6"]);
	return "/opt/pi-device-hub-certbot/bin/certbot";
}
async function existingCertificate(plan) {
	for (const name of await readdir("/etc/letsencrypt/live").catch(() => [])) {
		const cert = "/etc/letsencrypt/live/" + name + "/fullchain.pem";
		try {
			const x = new X509Certificate(await readFile(cert));
			if (
				Date.parse(x.validTo) <= Date.now() + 24 * 3600000 ||
				!(isIP(plan.host) ? x.checkIP(plan.host) : x.checkHost(plan.host))
			)
				continue;
			const key = dirname(cert) + "/privkey.pem";
			await access(key);
			await access("/etc/letsencrypt/renewal/" + name + ".conf");
			return { cert, key, name };
		} catch {}
	}
}
async function portAvailable(port) {
	const server = createServer();
	await new Promise((r, j) => {
		server.once("error", j);
		server.listen(port, "0.0.0.0", () => server.close(r));
	});
}

export async function installHttpsGateway(input) {
	if (process.platform !== "linux" || process.getuid?.() !== 0)
		throw Error("Automatic HTTPS installation requires Linux systemd and administrator privileges");
	const plan = httpsPlan(input);
	await access("/run/systemd/system");
	const configured = await readFile(plan.config, "utf8").catch(() => null);
	if (configured && !configured.includes(MARKER)) throw Error("HTTPS configuration belongs to another application");
	if (!configured) await portAvailable(plan.port);
	const certbot = await certbotExecutable();
	let certificate = await existingCertificate(plan);
	const previousFiles = new Map();
	const write = async (file, content, mode = 0o644) => {
		const previous = await readFile(file, "utf8").catch((error) => {
			if (error.code !== "ENOENT") throw error;
			return null;
		});
		if (previous !== null && !previous.includes(MARKER)) throw Error("Refusing to replace unmanaged file: " + file);
		if (!previousFiles.has(file))
			previousFiles.set(file, { content: previous, mode: previous === null ? mode : (await stat(file)).mode & 0o777 });
		await ownedWrite(file, content, mode);
	};
	try {
		await mkdir(plan.lib, { recursive: true });
		await mkdir(plan.root, { recursive: true, mode: 0o700 });
		await write(
			plan.gateway,
			"// " + MARKER + "\n" + (await readFile(new URL("./hub-https-gateway.mjs", import.meta.url), "utf8")),
		);
		const units = httpsUnits(plan, process.execPath, certbot, certificate?.name ?? plan.certName);
		if (!certificate) {
			const acmePath = "/etc/systemd/system/" + plan.acme + ".service";
			const previous = await readFile(acmePath, "utf8").catch(() => null);
			if (!previous) await portAvailable(80);
			await mkdir(join(plan.webroot, ".well-known/acme-challenge"), { recursive: true });
			await write(acmePath, units[plan.acme + ".service"]);
			await command("systemctl", ["daemon-reload"]);
			await command("systemctl", ["enable", "--now", plan.acme + ".service"]);
			const [program, ...args] = certificateCommand(plan, certbot);
			await command(program, args);
			certificate = await existingCertificate(plan);
			if (!certificate) throw Error("Certificate issuance did not produce a valid renewable certificate");
		}
		const finalUnits = httpsUnits(plan, process.execPath, certbot, certificate.name);
		const gateway = {
			managedBy: MARKER,
			publicUrl: plan.publicUrl,
			upstream: plan.upstream,
			cert: certificate.cert,
			key: certificate.key,
			port: plan.port,
		};
		await write(plan.config, JSON.stringify(gateway, null, 2) + "\n", 0o600);
		for (const name of [plan.unit + ".service", plan.renew + ".service", plan.renew + ".timer"])
			await write("/etc/systemd/system/" + name, finalUnits[name]);
		// Directory hooks compose with an existing application's own deploy hook.
		await write(
			"/etc/letsencrypt/renewal-hooks/deploy/" + plan.unit,
			`#!/bin/sh\n# ${MARKER}\n/usr/bin/systemctl kill --kill-who=main -s HUP ${plan.unit}.service || true\n`,
			0o755,
		);
		await command("systemctl", ["daemon-reload"]);
		await command("systemctl", ["enable", "--now", plan.unit + ".service", plan.renew + ".timer"]);
		await command("systemctl", ["restart", plan.unit + ".service"]);
		console.log(
			JSON.stringify({ https: plan.publicUrl, certificateName: certificate.name, renewal: plan.renew + ".timer" }),
		);
		return plan;
	} catch (error) {
		for (const [file, previous] of previousFiles) {
			if (file.startsWith("/etc/systemd/system/") && previous.content === null)
				await command("systemctl", ["disable", "--now", file.slice("/etc/systemd/system/".length)]).catch(() => {});
		}
		for (const [file, previous] of [...previousFiles].reverse()) {
			if (previous.content === null)
				await unlink(file).catch((e) => {
					if (e.code !== "ENOENT") throw e;
				});
			else await ownedWrite(file, previous.content, previous.mode);
		}
		await command("systemctl", ["daemon-reload"]).catch(() => {});
		if (configured) await command("systemctl", ["restart", plan.unit + ".service"]).catch(() => {});
		throw error;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 4 || process.argv[2] !== "--apply")
		throw Error("Usage: hub-https-install.mjs --apply CONFIG");
	await installHttpsGateway(JSON.parse(await readFile(process.argv[3], "utf8")));
}
