import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function equal(a, b) {
	return a.length === b.length && timingSafeEqual(a, b);
}

function matches(pattern, hostname) {
	if (pattern.startsWith("|")) {
		const parts = pattern.split("|");
		if (parts.length !== 4 || parts[1] !== "1") return false;
		const salt = Buffer.from(parts[2], "base64");
		const digest = Buffer.from(parts[3], "base64");
		return salt.length === 20 && equal(createHmac("sha1", salt).update(hostname).digest(), digest);
	}
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${regex}$`, "i").test(hostname);
}

function hostMatches(patterns, hostname) {
	let matched = false;
	for (const pattern of patterns.split(",")) {
		if (pattern.startsWith("!")) {
			if (matches(pattern.slice(1), hostname)) return false;
		} else if (matches(pattern, hostname)) matched = true;
	}
	return matched;
}

export function verifyKnownHosts(contents, host, port, key) {
	const hostname = port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
	let trusted = false;
	for (const line of contents.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (!fields[0] || fields[0].startsWith("#")) continue;
		const marker = fields[0].startsWith("@") ? fields.shift() : "";
		const [hosts, algorithm, encoded] = fields;
		if (!hosts || !algorithm || !encoded || !hostMatches(hosts, hostname)) continue;
		const stored = Buffer.from(encoded, "base64");
		if (stored.length < 4) continue;
		const length = stored.readUInt32BE(0);
		if (length > stored.length - 4 || stored.subarray(4, 4 + length).toString("ascii") !== algorithm) continue;
		if (!equal(stored, key)) continue;
		if (marker === "@revoked") return false;
		if (!marker) trusted = true;
	}
	return trusted;
}

function knownHostsFile() {
	const configured = process.env.PI_WEB_SSH_KNOWN_HOSTS?.trim();
	return path.resolve(
		configured ? configured.replace(/^~(?=[/\\])/, os.homedir()) : path.join(os.homedir(), ".ssh", "known_hosts"),
	);
}

async function readKnownHosts(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return "";
		throw new Error(`Cannot read SSH known_hosts ${file}: ${error.message}`);
	}
}

function fingerprintOf(key) {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function algorithmOf(key) {
	if (!Buffer.isBuffer(key) || key.length < 5) throw new Error("Invalid SSH host key");
	const length = key.readUInt32BE(0);
	if (!length || length > key.length - 4) throw new Error("Invalid SSH host key");
	const algorithm = key.subarray(4, 4 + length).toString("ascii");
	if (!/^[a-zA-Z0-9@._+-]+$/.test(algorithm)) throw new Error("Invalid SSH host key algorithm");
	return algorithm;
}

function hostBinding(host, port) {
	if (typeof host !== "string" || !host || /[\s,*?!|#[\]\\/\x00-\x1f\x7f]/.test(host)) {
		throw new Error("Invalid SSH host");
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH port");
	return port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
}

function matchingRows(contents, hostname) {
	const rows = [];
	for (const line of contents.split(/(?<=\n)/)) {
		const fields = /^(\s*)(?:(@\S+)\s+)?([^\s#]+)(\s+)(\S+)\s+(\S+)/.exec(line);
		if (!fields || !hostMatches(fields[3], hostname)) continue;
		const stored = Buffer.from(fields[6], "base64");
		try {
			if (algorithmOf(stored) !== fields[5]) continue;
		} catch {
			continue;
		}
		rows.push({ line, fields, stored, marker: fields[2] || "", hosts: fields[3] });
	}
	return rows;
}

function trustStatus(contents, hostname, key) {
	const rows = matchingRows(contents, hostname);
	if (rows.some((row) => row.marker === "@revoked" && equal(row.stored, key))) return "revoked";
	return rows.length ? "changed" : "unknown";
}

let pendingSave = Promise.resolve();

export function saveTrustedHostKey({ host, port = 22, key, fingerprint, replace = false }) {
	const file = knownHostsFile();
	const capturedKey = Buffer.isBuffer(key) ? Buffer.from(key) : key;
	const save = pendingSave.then(async () => {
		const hostname = hostBinding(host, port);
		const algorithm = algorithmOf(capturedKey);
		if (fingerprint !== fingerprintOf(capturedKey)) throw new Error("SSH host key fingerprint mismatch");
		const contents = await readKnownHosts(file);
		const rows = matchingRows(contents, hostname);
		if (rows.some((row) => row.marker === "@revoked")) throw new Error("SSH host key is revoked; cannot save trust");
		const result = { host, port, algorithm, fingerprint, knownHostsFile: file };
		if (verifyKnownHosts(contents, host, port, capturedKey)) return result;
		if (rows.length && !replace) throw new Error("SSH host key changed; explicit replace is required");
		const replacements = new Map();
		for (const row of rows) {
			const bindings = row.hosts.split(",");
			if (
				row.marker ||
				bindings.some((binding) => !binding.startsWith("!") && matches(binding, hostname) && /[*?]/.test(binding))
			) {
				throw new Error("Cannot safely replace wildcard or marked SSH known_hosts binding");
			}
			const remaining = bindings.filter((binding) => binding.startsWith("!") || !matches(binding, hostname));
			if (!remaining.some((binding) => !binding.startsWith("!"))) replacements.set(row.line, "");
			else {
				const start = row.fields[1].length;
				replacements.set(
					row.line,
					row.line.slice(0, start) + remaining.join(",") + row.line.slice(start + row.hosts.length),
				);
			}
		}
		let updated = contents
			.split(/(?<=\n)/)
			.map((line) => replacements.get(line) ?? line)
			.join("");
		if (updated && !updated.endsWith("\n")) updated += "\n";
		updated += `${hostname} ${algorithm} ${capturedKey.toString("base64")}\n`;
		let mode = 0o600;
		try {
			const stat = await lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SSH known_hosts must be a regular file");
			mode = stat.mode & 0o777;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, updated, { flag: "wx", mode });
			await chmod(temporary, mode);
			await rename(temporary, file);
		} finally {
			await unlink(temporary).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		return result;
	});
	pendingSave = save.catch(() => {});
	return save;
}

export async function createHostVerifier(host, port = 22) {
	const file = knownHostsFile();
	const contents = await readKnownHosts(file);
	let failure;
	return {
		hostVerifier(key) {
			if (verifyKnownHosts(contents, host, port, key)) return true;
			const fingerprint = fingerprintOf(key);
			failure = new Error(
				`SSH 主机密钥未受信任或已变更 / host key untrusted or changed: ${host}:${port}; presented ${fingerprint}. ` +
					`连接已拒绝，未保存密钥 / Connection refused; no key was saved. ` +
					`请通过服务器控制台或管理员独立核对指纹（服务器上可运行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub；按实际密钥类型选文件）。` +
					`核对一致后，用本机 OpenSSH ssh 连接同一主机和端口，设置 StrictHostKeyChecking=ask 和 UserKnownHostsFile 为 ${file}，确认提示后重试。` +
					`若密钥已变更，须先由管理员确认轮换，再手动更新对应记录；不要盲目删除旧记录或直接信任 ssh-keyscan 输出。` +
					` Independently verify the fingerprint with the server console/admin, then use OpenSSH ssh with StrictHostKeyChecking=ask and UserKnownHostsFile=${file} for the same host/port; accept only the verified key. ` +
					`For rotated keys, confirm rotation before replacing the old entry. Do not trust ssh-keyscan output alone. ` +
					`Preprovision verified OpenSSH entries in this file, or set PI_WEB_SSH_KNOWN_HOSTS to a trusted known_hosts file in the server environment. ` +
					`CA-only (@cert-authority) entries are not supported; provision the verified host public key.`,
			);
			failure.hostTrust = {
				host,
				port,
				algorithm: algorithmOf(key),
				fingerprint,
				knownHostsFile: file,
				status: trustStatus(contents, port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`, key),
			};
			Object.defineProperty(failure, "hostKey", { value: Buffer.from(key), enumerable: false });
			return false;
		},
		getError() {
			return failure;
		},
	};
}
