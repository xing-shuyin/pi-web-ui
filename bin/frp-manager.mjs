import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Client as SshClient } from "ssh2";
import * as tar from "tar";
import yauzl from "yauzl";

export const DEFAULT_FRP_VERSION = "0.61.1";
export const DEFAULT_SERVER_PORT = 7000;
export const DEFAULT_LOCAL_PORT = 8787;
export const DEFAULT_REMOTE_PORT = 8787;
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_USER = "root";

export function isZhLang() {
	const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
	if (env.startsWith("zh")) return true;
	if (!env) {
		try {
			return Intl.DateTimeFormat().resolvedOptions().locale.startsWith("zh");
		} catch {}
	}
	return false;
}

const ZH = isZhLang();

export function pick(zh, en) {
	return ZH ? zh : en;
}

export function getFrpDataDir(customDataDir) {
	const base =
		customDataDir ||
		process.env.PI_WEB_DATA_DIR ||
		(process.platform === "win32" ? join(process.env.APPDATA || homedir(), "pi-web-ui") : join(homedir(), ".pi-web"));
	return join(base, "frp");
}

export function getDefaultLocalPort() {
	if (process.env.PI_WEB_PORT) {
		const p = parseInt(process.env.PI_WEB_PORT, 10);
		if (p > 0 && p < 65536) return p;
	}
	return DEFAULT_LOCAL_PORT;
}

export function getLocalPlatformArch(platform = process.platform, arch = process.arch) {
	let osName = "linux";
	let isZip = false;
	let binName = "frpc";

	if (platform === "win32") {
		osName = "windows";
		isZip = true;
		binName = "frpc.exe";
	} else if (platform === "darwin") {
		osName = "darwin";
	}

	let archName = "amd64";
	if (arch === "arm64") {
		archName = "arm64";
	} else if (arch === "arm") {
		archName = "arm";
	} else if (arch === "ia32" || arch === "x86") {
		archName = "386";
	} else if (arch === "x64") {
		archName = "amd64";
	}

	const osArch = `${osName}_${archName}`;
	const ext = isZip ? "zip" : "tar.gz";

	return {
		os: osName,
		arch: archName,
		osArch,
		isZip,
		binName,
		ext,
		archiveName: (ver) => `frp_${ver}_${osArch}.${ext}`,
	};
}

export function getRemotePlatformArch(unameM = "x86_64") {
	const raw = String(unameM).trim().toLowerCase();
	let archName = "amd64";

	if (raw === "aarch64" || raw === "arm64") {
		archName = "arm64";
	} else if (raw.startsWith("armv7") || raw.startsWith("armv6") || raw === "arm") {
		archName = "arm";
	} else if (raw === "i386" || raw === "i686" || raw === "x86") {
		archName = "386";
	} else if (raw === "x86_64" || raw === "amd64") {
		archName = "amd64";
	}

	const osArch = `linux_${archName}`;
	const ext = "tar.gz";

	return {
		os: "linux",
		arch: archName,
		osArch,
		isZip: false,
		binName: "frps",
		ext,
		archiveName: (ver) => `frp_${ver}_${osArch}.${ext}`,
	};
}

export function generateRandomToken() {
	return randomBytes(16).toString("hex");
}

export function generateFrpsToml({ bindPort = DEFAULT_SERVER_PORT, token }) {
	return `# frps.toml - Managed by pi-web-ui
bindPort = ${bindPort}
auth.method = "token"
auth.token = "${token}"
`;
}

export function generateFrpcToml({
	serverAddr,
	serverPort = DEFAULT_SERVER_PORT,
	token,
	localPort = DEFAULT_LOCAL_PORT,
	remotePort = DEFAULT_REMOTE_PORT,
	proxyName = "pi-web-ui",
}) {
	return `# frpc.toml - Managed by pi-web-ui
serverAddr = "${serverAddr}"
serverPort = ${serverPort}
auth.method = "token"
auth.token = "${token}"

[[proxies]]
name = "${proxyName}"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${localPort}
remotePort = ${remotePort}
`;
}

export function generateRemoteBashScript({
	version = DEFAULT_FRP_VERSION,
	bindPort = DEFAULT_SERVER_PORT,
	remotePort = DEFAULT_REMOTE_PORT,
	token,
}) {
	return `#!/usr/bin/env bash
# ==============================================================================
# pi-web-ui FRP Server (frps) 一键部署脚本
# ==============================================================================
set -e

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ 错误: 此脚本需要 root 权限，请使用 sudo 或 root 用户运行" >&2
    exit 1
fi

FRP_VERSION="${version}"
BIND_PORT=${bindPort}
REMOTE_PORT=${remotePort}
TOKEN="${token}"

echo "🚀 开始部署 frps v\${FRP_VERSION} 到远程服务器..."

ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64) FRP_ARCH="amd64" ;;
    aarch64|arm64) FRP_ARCH="arm64" ;;
    armv7l|armv6l) FRP_ARCH="arm" ;;
    i386|i686) FRP_ARCH="386" ;;
    *) echo "❌ 不支持的 CPU 架构: $ARCH" >&2; exit 1 ;;
esac

TAR_NAME="frp_\${FRP_VERSION}_linux_\${FRP_ARCH}.tar.gz"
TMP_DIR="$(mktemp -d /tmp/frps-install-XXXXXX)"

echo "📦 架构: linux_\${FRP_ARCH}，正在下载 \${TAR_NAME}..."

DOWNLOAD_URLS=(
    "https://github.com/fatedier/frp/releases/download/v\${FRP_VERSION}/\${TAR_NAME}"
)

DOWNLOAD_SUCCESS=0
for url in "\${DOWNLOAD_URLS[@]}"; do
    echo "· 尝试源: $url"
    if curl -fSL --connect-timeout 10 -m 60 "$url" -o "$TMP_DIR/$TAR_NAME" 2>/dev/null; then
        DOWNLOAD_SUCCESS=1
        break
    elif command -v wget >/dev/null 2>&1 && wget --timeout=10 -t 1 "$url" -O "$TMP_DIR/$TAR_NAME" 2>/dev/null; then
        DOWNLOAD_SUCCESS=1
        break
    fi
done

if [ "$DOWNLOAD_SUCCESS" -ne 1 ]; then
    echo "❌ 下载 frp 失败，请检查网络或配置代理" >&2
    rm -rf "$TMP_DIR"
    exit 1
fi

echo "🔐 校验下载文件 SHA256..."
for cu in \
    "https://github.com/fatedier/frp/releases/download/v\${FRP_VERSION}/frp_\${FRP_VERSION}_sha256_checksums.txt" \
    "https://github.com/fatedier/frp/releases/download/v\${FRP_VERSION}/frp_sha256_checksums.txt"; do
    if curl -fsSL --connect-timeout 10 -m 30 "$cu" -o "$TMP_DIR/checksums.txt" 2>/dev/null; then
        break
    fi
done
if [ -s "$TMP_DIR/checksums.txt" ]; then
    EXPECTED=""
    while read -r h f; do
        fname="\${f#*}"
        if [ "$fname" = "$TAR_NAME" ] && [ "\${#h}" -eq 64 ]; then
            EXPECTED="$h"
            break
        fi
    done < "$TMP_DIR/checksums.txt"
    if [ -n "$EXPECTED" ]; then
        ACTUAL="$(sha256sum "$TMP_DIR/$TAR_NAME" | awk '{print $1}')"
        if [ "$ACTUAL" != "$EXPECTED" ]; then
            echo "❌ SHA256 校验失败，下载文件可能被篡改，已中止安装" >&2
            rm -rf "$TMP_DIR"
            exit 1
        fi
        echo "✅ SHA256 校验通过"
    else
        # fail-closed：这是 root 权限安装到 /usr/local/bin 的脚本——「找不到条目」
        # 同样可能是 checksums 被污染/降级，与本地 frpc 安装路径同口径直接中止，
        # 不给「阻断 checksums 请求即降级为无校验 root 安装」留面。
        echo "❌ 未在官方 checksums 中找到 \${TAR_NAME}，无法校验，已中止安装" >&2
        rm -rf "$TMP_DIR"
        exit 1
    fi
else
    echo "❌ 未获取到官方 checksums 文件，无法校验，已中止安装（请检查网络后重试）" >&2
    rm -rf "$TMP_DIR"
    exit 1
fi

echo "📂 解压并安装到 /usr/local/bin/frps..."
tar -zxvf "$TMP_DIR/$TAR_NAME" -C "$TMP_DIR" >/dev/null
EXTRACTED_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name "frp_*" | head -n 1)"
install -m 755 "$EXTRACTED_DIR/frps" /usr/local/bin/frps
rm -rf "$TMP_DIR"

mkdir -p /etc/frp
cat > /etc/frp/frps.toml << 'EOF'
bindPort = ${bindPort}
auth.method = "token"
auth.token = "${token}"
EOF
chmod 600 /etc/frp/frps.toml

cat > /etc/systemd/system/frps.service << 'EOF'
[Unit]
Description=Frp Server Service (Managed by pi-web-ui)
After=network.target syslog.target
Wants=network.target

[Service]
Type=simple
User=root
Restart=on-failure
RestartSec=5s
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable frps >/dev/null 2>&1 || true
systemctl restart frps

if systemctl is-active --quiet frps; then
    echo "✅ frps 服务已成功安装并运行！"
else
    echo "⚠ frps 服务已启动但状态未确认，请检查: systemctl status frps" >&2
fi

# 尝试放行防火墙端口
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    echo "🛡  检测到 ufw 防火墙，尝试放行通信端口 \${BIND_PORT} 与转发端口 \${REMOTE_PORT}..."
    ufw allow \${BIND_PORT}/tcp comment 'frps bind port' >/dev/null 2>&1 || true
    ufw allow \${REMOTE_PORT}/tcp comment 'pi-web-ui remote port' >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    echo "🛡  检测到 firewalld，尝试放行通信端口 \${BIND_PORT} 与转发端口 \${REMOTE_PORT}..."
    firewall-cmd --zone=public --add-port=\${BIND_PORT}/tcp --permanent >/dev/null 2>&1 || true
    firewall-cmd --zone=public --add-port=\${REMOTE_PORT}/tcp --permanent >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo ""
echo "================================================================================"
echo "🎉 远程 FRP 服务端配置完成！"
echo "   - 通信端口 (serverPort) : \${BIND_PORT}"
echo "   - 转发端口 (remotePort) : \${REMOTE_PORT}"
echo "   - 配置文件路径          : /etc/frp/frps.toml"
echo "   - systemd 服务          : systemctl status frps"
echo "   - 提醒                  : 若使用阿里云/腾讯云/AWS等云服务器，请务必在控制台安全组放行"
echo "                             TCP \${BIND_PORT} 与 TCP \${REMOTE_PORT}！"
echo "================================================================================"
`;
}

export function getFrpDownloadUrls(version, archiveName) {
	return [`https://github.com/fatedier/frp/releases/download/v${version}/${archiveName}`];
}

export async function fetchFrpSha256(version, archiveName) {
	const candidates = [
		`https://github.com/fatedier/frp/releases/download/v${version}/frp_${version}_sha256_checksums.txt`,
		`https://github.com/fatedier/frp/releases/download/v${version}/frp_sha256_checksums.txt`,
	];
	for (const url of candidates) {
		try {
			const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
			if (!res.ok) continue;
			const lines = (await res.text()).split(/\r?\n/);
			for (const line of lines) {
				const parts = line.trim().split(/\s+/);
				if (parts.length >= 2 && /^[0-9a-f]{64}$/.test(parts[0]) && parts[1].replace(/^\*+/, "") === archiveName) {
					return parts[0];
				}
			}
		} catch {}
	}
	return null;
}

function sha256File(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export async function downloadFileWithFallback(urls, destPath) {
	for (let i = 0; i < urls.length; i++) {
		const url = urls[i];
		try {
			const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const arrayBuffer = await res.arrayBuffer();
			writeFileSync(destPath, Buffer.from(arrayBuffer));
			return;
		} catch (err) {
			if (i === urls.length - 1) {
				throw new Error(
					pick(
						`下载失败（已尝试所有镜像）: ${err?.message ?? err}`,
						`Download failed (all mirrors tried): ${err?.message ?? err}`,
					),
				);
			}
		}
	}
}

export function extractZipSingleFile(zipPath, targetFileName, outFilePath) {
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
			if (err) return reject(err);
			let found = false;

			zipfile.readEntry();
			zipfile.on("entry", (entry) => {
				const name = entry.fileName;
				if (
					name.endsWith(targetFileName) ||
					name.endsWith("/" + targetFileName) ||
					name.endsWith("\\" + targetFileName)
				) {
					found = true;
					zipfile.openReadStream(entry, (err, readStream) => {
						if (err) return reject(err);
						const writeStream = createWriteStream(outFilePath);
						readStream.pipe(writeStream);
						writeStream.on("finish", () => {
							resolve();
						});
						writeStream.on("error", reject);
					});
				} else {
					zipfile.readEntry();
				}
			});

			zipfile.on("end", () => {
				if (!found) {
					reject(
						new Error(
							pick(`未在压缩包中找到文件 ${targetFileName}`, `File ${targetFileName} not found in zip archive`),
						),
					);
				}
			});

			zipfile.on("error", reject);
		});
	});
}

export async function extractTarGzSingleFile(tarPath, targetFileName, outFilePath) {
	const tmpExtractDir = join(tmpdir(), `frp-extract-${Date.now()}`);
	mkdirSync(tmpExtractDir, { recursive: true });
	try {
		await tar.x({
			file: tarPath,
			cwd: tmpExtractDir,
		});
		const { readdirSync, statSync } = await import("node:fs");
		function findFile(dir) {
			const entries = readdirSync(dir);
			for (const e of entries) {
				const full = join(dir, e);
				if (statSync(full).isDirectory()) {
					const res = findFile(full);
					if (res) return res;
				} else if (e === targetFileName) {
					return full;
				}
			}
			return null;
		}

		const foundPath = findFile(tmpExtractDir);
		if (!foundPath) {
			throw new Error(
				pick(`未在 tar 压缩包中找到 ${targetFileName}`, `Could not find ${targetFileName} in tar archive`),
			);
		}

		const data = readFileSync(foundPath);
		writeFileSync(outFilePath, data);
	} finally {
		rmSync(tmpExtractDir, { recursive: true, force: true });
	}
}

export async function ensureLocalFrpc({ dataDir, version = DEFAULT_FRP_VERSION, force = false }) {
	const frpDir = getFrpDataDir(dataDir);
	mkdirSync(frpDir, { recursive: true });

	const { binName, archiveName, isZip } = getLocalPlatformArch();
	const binPath = join(frpDir, binName);

	if (existsSync(binPath) && !force) {
		return binPath;
	}

	console.log(
		pick(
			`📥 正在下载适用于本地系统的 FRP 客户端 (${binName})...`,
			`📥 Downloading FRP client for local system (${binName})...`,
		),
	);

	const arcName = archiveName(version);
	const urls = getFrpDownloadUrls(version, arcName);
	const tmpArchive = join(tmpdir(), `pi-web-ui-${arcName}`);

	try {
		await downloadFileWithFallback(urls, tmpArchive);
		const expectedSha = await fetchFrpSha256(version, arcName);
		if (!expectedSha) {
			rmSync(tmpArchive, { force: true });
			throw new Error(
				pick(
					`无法获取 ${arcName} 的官方 SHA256 校验和，已拒绝无校验安装（请升级 FRP_VERSION 或检查网络）`,
					`Official SHA256 checksum for ${arcName} unavailable; refusing unsigned install`,
				),
			);
		}
		const actualSha = sha256File(tmpArchive);
		if (actualSha !== expectedSha) {
			rmSync(tmpArchive, { force: true });
			throw new Error(
				pick(
					`SHA256 校验失败（期望 ${expectedSha}，实际 ${actualSha}），下载文件可能被篡改，已中止安装`,
					`SHA256 mismatch (expected ${expectedSha}, got ${actualSha}); download may be tampered, install aborted`,
				),
			);
		}
		console.log(pick(`✅ SHA256 校验通过`, `✅ SHA256 verified`));
		console.log(pick(`📦 下载完成，正在解压提取 ${binName}...`, `📦 Download complete, extracting ${binName}...`));

		if (isZip) {
			await extractZipSingleFile(tmpArchive, binName, binPath);
		} else {
			await extractTarGzSingleFile(tmpArchive, binName, binPath);
		}

		if (process.platform !== "win32") {
			chmodSync(binPath, 0o755);
		}
		console.log(pick(`✔ FRP 客户端就绪: ${binPath}`, `✔ FRP client ready: ${binPath}`));
		return binPath;
	} finally {
		rmSync(tmpArchive, { force: true });
	}
}

export function findDefaultSshKeys() {
	const home = homedir();
	const candidates = [join(home, ".ssh", "id_ed25519"), join(home, ".ssh", "id_rsa"), join(home, ".ssh", "id_ecdsa")];
	return candidates.filter((p) => existsSync(p));
}

export async function deployRemoteFrpsViaSsh({
	host,
	port = DEFAULT_SSH_PORT,
	username = DEFAULT_SSH_USER,
	password,
	privateKeyPath,
	serverPort = DEFAULT_SERVER_PORT,
	remotePort = DEFAULT_REMOTE_PORT,
	token,
	version = DEFAULT_FRP_VERSION,
	onLog = console.log,
}) {
	return new Promise((resolve, reject) => {
		const ssh = new SshClient();

		const sshConfig = {
			host,
			port,
			username,
			readyTimeout: 30_000,
		};

		if (password) {
			sshConfig.password = password;
		}

		if (privateKeyPath && existsSync(privateKeyPath)) {
			try {
				sshConfig.privateKey = readFileSync(privateKeyPath);
			} catch (err) {
				return reject(
					new Error(pick(`读取私钥文件失败: ${err.message}`, `Failed to read private key: ${err.message}`)),
				);
			}
		} else if (!password) {
			const keys = findDefaultSshKeys();
			if (keys.length > 0) {
				try {
					sshConfig.privateKey = readFileSync(keys[0]);
					onLog(pick(`🔑 使用本地密钥: ${keys[0]}`, `🔑 Using local key: ${keys[0]}`));
				} catch {}
			}
		}

		ssh.on("error", (err) => {
			reject(
				new Error(
					pick(`SSH 连接失败 (${username}@${host}:${port}): ${err.message}`, `SSH connection failed: ${err.message}`),
				),
			);
		});

		ssh.on("ready", async () => {
			onLog(
				pick(`✔ 已成功建立 SSH 连接到 ${username}@${host}:${port}`, `✔ SSH connected to ${username}@${host}:${port}`),
			);

			const runCommand = (cmd) => {
				return new Promise((res, rej) => {
					ssh.exec(cmd, (err, stream) => {
						if (err) return rej(err);
						let stdout = "";
						let stderr = "";
						stream.on("data", (d) => {
							stdout += d.toString();
						});
						stream.stderr.on("data", (d) => {
							stderr += d.toString();
						});
						stream.on("close", (code) => {
							res({ code, stdout: stdout.trim(), stderr: stderr.trim() });
						});
					});
				});
			};

			try {
				const osRes = await runCommand("uname -s");
				if (osRes.stdout !== "Linux") {
					throw new Error(
						pick(
							`远程系统为 ${osRes.stdout}，目前仅支持自动在 Linux 服务器上部署 frps`,
							`Remote OS is ${osRes.stdout}, only Linux is supported for auto frps deployment`,
						),
					);
				}

				const unameRes = await runCommand("uname -m");
				const archInfo = getRemotePlatformArch(unameRes.stdout);
				onLog(
					pick(
						`🔎 远程系统架构检测完成: Linux ${unameRes.stdout} (${archInfo.osArch})`,
						`🔎 Remote arch detected: Linux ${unameRes.stdout} (${archInfo.osArch})`,
					),
				);

				const uidRes = await runCommand("id -u");
				const isRoot = uidRes.stdout === "0";
				const sudoPrefix = isRoot ? "" : "sudo ";

				onLog(
					pick(
						`🚀 正在远程下载并安装 frps v${version}...`,
						`🚀 Downloading and installing frps v${version} on remote...`,
					),
				);
				const bashScript = generateRemoteBashScript({
					version,
					bindPort: serverPort,
					remotePort,
					token,
				});

				const remoteTmpScript = `/tmp/frps-deploy-${Date.now()}.sh`;
				const writeScriptCmd = `cat > "${remoteTmpScript}" << 'DEPLOY_SCRIPT_EOF'\n${bashScript}\nDEPLOY_SCRIPT_EOF\nchmod +x "${remoteTmpScript}" && ${sudoPrefix}"${remoteTmpScript}"\nrm -f "${remoteTmpScript}"`;

				const deployRes = await runCommand(writeScriptCmd);
				if (deployRes.stdout) onLog(deployRes.stdout);
				if (deployRes.code !== 0) {
					throw new Error(
						pick(
							`远程执行部署脚本失败 (exit code: ${deployRes.code}): ${deployRes.stderr || deployRes.stdout}`,
							`Remote deployment failed (exit code: ${deployRes.code}): ${deployRes.stderr || deployRes.stdout}`,
						),
					);
				}

				const statusRes = await runCommand(`${sudoPrefix}systemctl is-active frps`);
				if (statusRes.stdout.includes("active")) {
					onLog(pick(`✔ 远程 frps 服务运行正常 (active)`, `✔ Remote frps service is active`));
				} else {
					onLog(
						pick(
							`⚠ 远程服务状态未处于 active: ${statusRes.stdout} ${statusRes.stderr}`,
							`⚠ Remote service status is not active: ${statusRes.stdout} ${statusRes.stderr}`,
						),
					);
				}

				ssh.end();
				resolve();
			} catch (err) {
				ssh.end();
				reject(err);
			}
		});

		ssh.connect(sshConfig);
	});
}

export function isPidAlive(pid) {
	if (!pid || isNaN(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

export function saveFrpState(dataDir, state) {
	const frpDir = getFrpDataDir(dataDir);
	mkdirSync(frpDir, { recursive: true });
	const statePath = join(frpDir, "state.json");
	writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf8");
}

export function loadFrpState(dataDir) {
	const frpDir = getFrpDataDir(dataDir);
	const statePath = join(frpDir, "state.json");
	if (!existsSync(statePath)) return null;
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return null;
	}
}

export async function startLocalFrpc({ dataDir, version }) {
	const frpDir = getFrpDataDir(dataDir);
	const binPath = await ensureLocalFrpc({ dataDir, version });
	const configPath = join(frpDir, "frpc.toml");
	const pidPath = join(frpDir, "frpc.pid");
	const logPath = join(frpDir, "frpc.log");

	if (!existsSync(configPath)) {
		throw new Error(
			pick(
				`未找到客户端配置文件: ${configPath}\n请先运行 pi-web-ui frp deploy 进行部署配置。`,
				`Client configuration not found: ${configPath}\nPlease run "pi-web-ui frp deploy" first.`,
			),
		);
	}

	if (existsSync(pidPath)) {
		const oldPid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
		if (isPidAlive(oldPid)) {
			console.log(pick(`✔ 本地 frpc 已在运行中 (PID: ${oldPid})`, `✔ Local frpc is already running (PID: ${oldPid})`));
			return { pid: oldPid, running: true };
		}
		rmSync(pidPath, { force: true });
	}

	const logFd = createWriteStream(logPath, { flags: "a" });
	const child = spawn(binPath, ["-c", configPath], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		windowsHide: true,
	});

	child.unref();

	const pid = child.pid;
	writeFileSync(pidPath, String(pid), "utf8");

	await new Promise((r) => setTimeout(r, 1000));
	if (!isPidAlive(pid)) {
		let recentLog = "";
		try {
			recentLog = readFileSync(logPath, "utf8").split("\n").slice(-10).join("\n");
		} catch {}
		rmSync(pidPath, { force: true });
		throw new Error(
			pick(
				`frpc 启动失败，进程已退出。\n最近日志:\n${recentLog}`,
				`frpc failed to start, process exited.\nRecent logs:\n${recentLog}`,
			),
		);
	}

	console.log(pick(`✔ 本地 frpc 启动成功 (PID: ${pid})`, `✔ Local frpc started successfully (PID: ${pid})`));
	console.log(pick(`  日志文件: ${logPath}`, `  Log file: ${logPath}`));

	const state = loadFrpState(dataDir);
	if (state && state.serverAddr && state.remotePort) {
		console.log(
			pick(
				`  🌐 外网访问地址: http://${state.serverAddr}:${state.remotePort}`,
				`  🌐 Public Access URL: http://${state.serverAddr}:${state.remotePort}`,
			),
		);
	}

	return { pid, running: true };
}

export function stopLocalFrpc({ dataDir }) {
	const frpDir = getFrpDataDir(dataDir);
	const pidPath = join(frpDir, "frpc.pid");

	if (!existsSync(pidPath)) {
		console.log(pick("ℹ 本地 frpc 未运行 (无 PID 文件)", "ℹ Local frpc is not running (no PID file)"));
		return;
	}

	const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	if (!isPidAlive(pid)) {
		rmSync(pidPath, { force: true });
		console.log(
			pick(
				`ℹ 本地 frpc (PID: ${pid}) 已停止，已清理 PID 文件`,
				`ℹ Local frpc (PID: ${pid}) was not running, PID file cleaned`,
			),
		);
		return;
	}

	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
		} else {
			process.kill(pid, "SIGTERM");
		}
	} catch (err) {
		console.warn(pick(`停止进程警告: ${err.message}`, `Warning stopping process: ${err.message}`));
	}

	rmSync(pidPath, { force: true });
	console.log(pick(`✔ 已停止本地 frpc 服务 (PID: ${pid})`, `✔ Stopped local frpc service (PID: ${pid})`));
}

export async function runLocalFrpcForeground({ dataDir, version }) {
	const frpDir = getFrpDataDir(dataDir);
	const binPath = await ensureLocalFrpc({ dataDir, version });
	const configPath = join(frpDir, "frpc.toml");

	if (!existsSync(configPath)) {
		throw new Error(
			pick(
				`未找到客户端配置文件: ${configPath}\n请先运行 pi-web-ui frp deploy 进行部署配置。`,
				`Client configuration not found: ${configPath}\nPlease run "pi-web-ui frp deploy" first.`,
			),
		);
	}

	console.log(pick(`🚀 正在前台运行 frpc (Ctrl+C 退出)...`, `🚀 Running frpc in foreground (Ctrl+C to quit)...`));
	console.log(`> ${binPath} -c ${configPath}\n`);

	const child = spawn(binPath, ["-c", configPath], {
		stdio: "inherit",
	});

	return new Promise((resolve) => {
		child.on("exit", (code) => {
			console.log(pick(`frpc 进程已退出 (代码: ${code})`, `frpc process exited with code ${code}`));
			resolve(code);
		});
	});
}

export function statusLocalFrpc({ dataDir }) {
	const frpDir = getFrpDataDir(dataDir);
	const pidPath = join(frpDir, "frpc.pid");
	const configPath = join(frpDir, "frpc.toml");
	const logPath = join(frpDir, "frpc.log");
	const state = loadFrpState(dataDir);

	console.log("================================================================================");
	console.log(pick("📡 pi-web-ui FRP 隧道状态", "📡 pi-web-ui FRP Tunnel Status"));
	console.log("================================================================================");

	let isRunning = false;
	let currentPid = null;
	if (existsSync(pidPath)) {
		currentPid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
		if (isPidAlive(currentPid)) {
			isRunning = true;
		}
	}

	if (isRunning) {
		console.log(
			pick(`  客户端状态 : 🟢 运行中 (PID: ${currentPid})`, `  Client Status  : 🟢 Running (PID: ${currentPid})`),
		);
	} else {
		console.log(pick(`  客户端状态 : ⚪ 未运行`, `  Client Status  : ⚪ Stopped`));
	}

	if (state) {
		console.log(
			pick(
				`  远程服务器 : ${state.serverAddr}:${state.serverPort}`,
				`  Remote Server  : ${state.serverAddr}:${state.serverPort}`,
			),
		);
		console.log(
			pick(
				`  端口映射   : 本地 127.0.0.1:${state.localPort}  ==>  远程 :${state.remotePort}`,
				`  Port Mapping   : Local 127.0.0.1:${state.localPort}  ==>  Remote :${state.remotePort}`,
			),
		);
		console.log(
			pick(
				`  🌐 外网链接 : http://${state.serverAddr}:${state.remotePort}`,
				`  🌐 Public URL  : http://${state.serverAddr}:${state.remotePort}`,
			),
		);
		if (state.updatedAt) {
			console.log(
				pick(
					`  上次更新   : ${new Date(state.updatedAt).toLocaleString()}`,
					`  Last Updated   : ${new Date(state.updatedAt).toLocaleString()}`,
				),
			);
		}
	} else {
		console.log(pick(`  配置状态   : 尚未进行部署配置`, `  Config Status  : Not deployed yet`));
	}

	console.log(pick(`  配置目录   : ${frpDir}`, `  Config Dir     : ${frpDir}`));
	if (existsSync(configPath)) {
		console.log(pick(`  配置文件   : ${configPath}`, `  Config File    : ${configPath}`));
	}
	if (existsSync(logPath)) {
		console.log(pick(`  运行日志   : ${logPath}`, `  Log File       : ${logPath}`));
	}
	console.log("================================================================================");
}

export function installLocalFrpcService({ dataDir }) {
	const frpDir = getFrpDataDir(dataDir);
	const { binName } = getLocalPlatformArch();
	const binPath = join(frpDir, binName);
	const configPath = join(frpDir, "frpc.toml");

	if (!existsSync(binPath) || !existsSync(configPath)) {
		throw new Error(
			pick(
				`未找到 frpc 二进制或配置文件，请先执行 pi-web-ui frp deploy 进行部署。`,
				`frpc binary or configuration not found, run "pi-web-ui frp deploy" first.`,
			),
		);
	}

	if (process.platform === "win32") {
		const vbsPath = join(frpDir, "start-frpc-hidden.vbs");
		const vbsContent = `CreateObject("WScript.Shell").Run """${binPath}"" -c ""${configPath}""", 0, False\n`;
		writeFileSync(vbsPath, "\uFEFF" + vbsContent, "utf16le");

		const regCmd = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "pi-web-ui-frpc" /t REG_SZ /d "wscript.exe \\"${vbsPath}\\"" /f`;
		spawnSync("cmd.exe", ["/c", regCmd], { stdio: "inherit" });
		console.log(
			pick(
				`✔ 已安装 Windows 开机自启项 (HKCU Run 键: pi-web-ui-frpc)`,
				`✔ Windows autostart item installed (HKCU Run: pi-web-ui-frpc)`,
			),
		);
	} else if (process.platform === "darwin") {
		const plistPath = join(homedir(), "Library", "LaunchAgents", "com.xingshuyin.pi-web-ui-frpc.plist");
		mkdirSync(dirname(plistPath), { recursive: true });
		const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.xingshuyin.pi-web-ui-frpc</string>
    <key>ProgramArguments</key>
    <array>
        <string>${binPath}</string>
        <string>-c</string>
        <string>${configPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(frpDir, "frpc.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(frpDir, "frpc.err")}</string>
</dict>
</plist>
`;
		writeFileSync(plistPath, plistContent, "utf8");
		spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
		spawnSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
		console.log(
			pick(
				`✔ 已安装 macOS launchd 自启服务 (${plistPath})`,
				`✔ Installed macOS launchd autostart service (${plistPath})`,
			),
		);
	} else {
		const userUnitDir = join(homedir(), ".config", "systemd", "user");
		mkdirSync(userUnitDir, { recursive: true });
		const unitPath = join(userUnitDir, "pi-web-ui-frpc.service");
		const unitContent = `[Unit]
Description=pi-web-ui FRP Client Service
After=network.target

[Service]
Type=simple
ExecStart=${binPath} -c ${configPath}
Restart=always
RestartSec=5s

[Install]
WantedBy=default.target
`;
		writeFileSync(unitPath, unitContent, "utf8");
		spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
		spawnSync("systemctl", ["--user", "enable", "--now", "pi-web-ui-frpc.service"], { stdio: "inherit" });
		console.log(
			pick(`✔ 已安装 Linux systemd 用户自启服务 (${unitPath})`, `✔ Installed Linux systemd user service (${unitPath})`),
		);
	}
}

export function uninstallLocalFrpcService({ dataDir }) {
	const frpDir = getFrpDataDir(dataDir);
	stopLocalFrpc({ dataDir });

	if (process.platform === "win32") {
		spawnSync(
			"reg",
			["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "pi-web-ui-frpc", "/f"],
			{ stdio: "ignore" },
		);
		const vbsPath = join(frpDir, "start-frpc-hidden.vbs");
		if (existsSync(vbsPath)) rmSync(vbsPath, { force: true });
		console.log(pick(`✔ 已移除 Windows 开机自启项`, `✔ Removed Windows autostart item`));
	} else if (process.platform === "darwin") {
		const plistPath = join(homedir(), "Library", "LaunchAgents", "com.xingshuyin.pi-web-ui-frpc.plist");
		if (existsSync(plistPath)) {
			spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
			rmSync(plistPath, { force: true });
			console.log(pick(`✔ 已移除 macOS launchd 服务`, `✔ Removed macOS launchd service`));
		}
	} else {
		const unitPath = join(homedir(), ".config", "systemd", "user", "pi-web-ui-frpc.service");
		if (existsSync(unitPath)) {
			spawnSync("systemctl", ["--user", "disable", "--now", "pi-web-ui-frpc.service"], { stdio: "ignore" });
			rmSync(unitPath, { force: true });
			spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
			console.log(pick(`✔ 已移除 Linux systemd 用户服务`, `✔ Removed Linux systemd user service`));
		}
	}
}

export function parseFrpArgs(argv) {
	const opts = {
		server: undefined,
		serverPort: undefined,
		remotePort: undefined,
		localPort: undefined,
		token: undefined,
		sshUser: undefined,
		sshPort: undefined,
		sshKey: undefined,
		sshPass: undefined,
		localOnly: false,
		remoteOnly: false,
		scriptOnly: false,
		dataDir: undefined,
		version: DEFAULT_FRP_VERSION,
		help: false,
	};

	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const key = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const take = (flag) => {
			if (inline !== undefined) return inline;
			if (i + 1 < argv.length) {
				i++;
				return argv[i];
			}
			throw new Error(pick(`缺少选项 ${flag} 的值`, `Option ${flag} is missing a value`));
		};

		switch (key) {
			case "--server":
			case "--server-addr":
			case "-s":
				opts.server = take(key);
				break;
			case "--server-port":
			case "-sp":
				opts.serverPort = parseInt(take(key), 10);
				break;
			case "--remote-port":
			case "-rp":
				opts.remotePort = parseInt(take(key), 10);
				break;
			case "--local-port":
			case "-lp":
				opts.localPort = parseInt(take(key), 10);
				break;
			case "--token":
			case "-t":
				opts.token = take(key);
				break;
			case "--ssh-user":
			case "-u":
				opts.sshUser = take(key);
				break;
			case "--ssh-port":
			case "-p":
				opts.sshPort = parseInt(take(key), 10);
				break;
			case "--ssh-key":
			case "-i":
				opts.sshKey = take(key);
				break;
			case "--ssh-pass":
				opts.sshPass = take(key);
				break;
			case "--local-only":
				opts.localOnly = true;
				break;
			case "--remote-only":
				opts.remoteOnly = true;
				break;
			case "--script":
				opts.scriptOnly = true;
				break;
			case "--data-dir":
				opts.dataDir = take(key);
				break;
			case "--frp-version":
				opts.version = take(key);
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				if (key.startsWith("-")) {
					throw new Error(pick(`未知选项: ${key}`, `Unknown option: ${key}`));
				}
				positionals.push(key);
				break;
		}
	}

	return { opts, positionals };
}

export async function runInteractiveWizard(initialOpts = {}) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log("\n================================================================================");
		console.log(pick("🧭 pi-web-ui FRP 内网穿透配置向导", "🧭 pi-web-ui FRP Reverse Proxy Setup Wizard"));
		console.log("================================================================================\n");

		const defaultLocalPort = getDefaultLocalPort();
		const saved = loadFrpState(initialOpts.dataDir) || {};

		let server = initialOpts.server || saved.serverAddr;
		while (!server) {
			const ans = await rl.question(pick("1. 远程服务器公网 IP 或域名: ", "1. Remote server public IP or hostname: "));
			server = ans.trim();
			if (!server) {
				console.log(pick("❌ 服务器地址不能为空，请重新输入", "❌ Server address cannot be empty"));
			}
		}

		let localPort = initialOpts.localPort || saved.localPort || defaultLocalPort;
		const localPortAns = await rl.question(
			pick(`2. 本地 pi-web-ui 端口 [默认 ${localPort}]: `, `2. Local pi-web-ui port [default ${localPort}]: `),
		);
		if (localPortAns.trim()) {
			const parsed = parseInt(localPortAns.trim(), 10);
			if (parsed > 0 && parsed < 65536) localPort = parsed;
		}

		let remotePort = initialOpts.remotePort || saved.remotePort || localPort;
		const remotePortAns = await rl.question(
			pick(
				`3. 远程外网访问端口 remotePort [默认 ${remotePort}]: `,
				`3. Remote public access port remotePort [default ${remotePort}]: `,
			),
		);
		if (remotePortAns.trim()) {
			const parsed = parseInt(remotePortAns.trim(), 10);
			if (parsed > 0 && parsed < 65536) remotePort = parsed;
		}

		let serverPort = initialOpts.serverPort || saved.serverPort || DEFAULT_SERVER_PORT;
		const serverPortAns = await rl.question(
			pick(
				`4. FRP 通信端口 serverPort [默认 ${serverPort}]: `,
				`4. FRP communication port serverPort [default ${serverPort}]: `,
			),
		);
		if (serverPortAns.trim()) {
			const parsed = parseInt(serverPortAns.trim(), 10);
			if (parsed > 0 && parsed < 65536) serverPort = parsed;
		}

		let token = initialOpts.token || saved.token;
		if (!token) {
			const defaultToken = generateRandomToken();
			const tokenAns = await rl.question(
				pick(`5. FRP 认证 Token [直接回车自动生成安全 Token]: `, `5. FRP Auth Token [press Enter to auto-generate]: `),
			);
			token = tokenAns.trim() || defaultToken;
		}

		let autoRemote = !initialOpts.localOnly;
		if (!initialOpts.remoteOnly && !initialOpts.localOnly) {
			const autoRemoteAns = await rl.question(
				pick(
					`6. 是否通过 SSH 自动安装/配置远程服务器 frps？(Y/n): `,
					`6. Automatically deploy frps to remote server via SSH? (Y/n): `,
				),
			);
			if (autoRemoteAns.trim().toLowerCase() === "n") {
				autoRemote = false;
			}
		}

		let sshUser = initialOpts.sshUser || DEFAULT_SSH_USER;
		let sshPort = initialOpts.sshPort || DEFAULT_SSH_PORT;
		let sshKey = initialOpts.sshKey;
		let sshPass = initialOpts.sshPass;

		if (autoRemote) {
			const sshUserAns = await rl.question(
				pick(`   - SSH 用户名 [默认 ${sshUser}]: `, `   - SSH Username [default ${sshUser}]: `),
			);
			if (sshUserAns.trim()) sshUser = sshUserAns.trim();

			const sshPortAns = await rl.question(
				pick(`   - SSH 端口 [默认 ${sshPort}]: `, `   - SSH Port [default ${sshPort}]: `),
			);
			if (sshPortAns.trim()) {
				const p = parseInt(sshPortAns.trim(), 10);
				if (p > 0 && p < 65536) sshPort = p;
			}

			const defaultKeys = findDefaultSshKeys();
			if (!sshKey && defaultKeys.length > 0) {
				const useDefaultKeyAns = await rl.question(
					pick(
						`   - 检测到本地密钥 ${defaultKeys[0]}，是否直接使用？(Y/n): `,
						`   - Found local key ${defaultKeys[0]}, use it? (Y/n): `,
					),
				);
				if (useDefaultKeyAns.trim().toLowerCase() !== "n") {
					sshKey = defaultKeys[0];
				}
			}

			if (!sshKey && !sshPass) {
				const passAns = await rl.question(
					pick(`   - SSH 密码（如使用密钥请输入密钥绝对路径）: `, `   - SSH Password (or path to private key): `),
				);
				const trimmed = passAns.trim();
				if (existsSync(trimmed)) {
					sshKey = trimmed;
				} else {
					sshPass = trimmed;
				}
			}
		}

		return {
			server,
			serverPort,
			localPort,
			remotePort,
			token,
			autoRemote,
			sshUser,
			sshPort,
			sshKey,
			sshPass,
			dataDir: initialOpts.dataDir,
			version: initialOpts.version || DEFAULT_FRP_VERSION,
		};
	} finally {
		rl.close();
	}
}

const FRP_HELP_ZH = `pi-web-ui frp — FRP 内网穿透自动部署与管理

用法:
  pi-web-ui frp                           进入交互式向导配置并部署 FRP
  pi-web-ui frp deploy [选项]              自动部署远程 frps 与本地 frpc
  pi-web-ui frp start                     后台启动本地 frpc 客户端
  pi-web-ui frp stop                      停止本地 frpc 客户端
  pi-web-ui frp restart                   重启本地 frpc 客户端
  pi-web-ui frp status                    查看本地客户端与远程穿透状态
  pi-web-ui frp run                       前台运行本地 frpc 并输出实时日志
  pi-web-ui frp install                   安装本地开机自启系统服务
  pi-web-ui frp uninstall                 卸载本地开机自启系统服务
  pi-web-ui frp script [选项]              生成远程服务器一键部署 bash 脚本
  pi-web-ui frp log                       查看本地运行日志

deploy / script 选项:
  --server, -s <host>        远程服务器公网 IP 或域名
  --remote-port, -rp <port>  外网访问端口（默认 8787 或等于 localPort）
  --local-port, -lp <port>   本地 pi-web-ui 服务端口（默认 8787 或 $PI_WEB_PORT）
  --server-port, -sp <port>  FRP 通信端口（默认 7000）
  --token, -t <secret>       认证 Token（不提供则自动随机生成）
  --ssh-user, -u <user>      远程 SSH 用户名（默认 root）
  --ssh-port, -p <port>      远程 SSH 端口（默认 22）
  --ssh-key, -i <path>       SSH 私钥文件路径
  --ssh-pass <pass>          SSH 登录密码
  --local-only               仅配置并启动本地 frpc（不连接远程 SSH）
  --remote-only              仅在远程服务器部署 frps（不配置本地）
  --data-dir <dir>           本地配置数据目录（默认 ~/.pi-web）
  --frp-version <ver>        指定 FRP 版本（默认 ${DEFAULT_FRP_VERSION}）
`;

const FRP_HELP_EN = `pi-web-ui frp — FRP reverse proxy automated deployment and management

Usage:
  pi-web-ui frp                           Interactive setup wizard for FRP
  pi-web-ui frp deploy [options]          Deploy remote frps and local frpc
  pi-web-ui frp start                     Start local frpc in background
  pi-web-ui frp stop                      Stop local frpc
  pi-web-ui frp restart                   Restart local frpc
  pi-web-ui frp status                    Show status and access URLs
  pi-web-ui frp run                       Run frpc in foreground with live logs
  pi-web-ui frp install                   Install system autostart service for frpc
  pi-web-ui frp uninstall                 Uninstall system autostart service
  pi-web-ui frp script [options]          Generate standalone bash script for remote server
  pi-web-ui frp log                       Show local frpc logs

deploy / script options:
  --server, -s <host>        Remote server public IP or hostname
  --remote-port, -rp <port>  Remote public access port (default 8787 or same as localPort)
  --local-port, -lp <port>   Local pi-web-ui port (default 8787 or $PI_WEB_PORT)
  --server-port, -sp <port>  FRP bind port (default 7000)
  --token, -t <secret>       Auth token (auto-generated if omitted)
  --ssh-user, -u <user>      Remote SSH username (default root)
  --ssh-port, -p <port>      Remote SSH port (default 22)
  --ssh-key, -i <path>       SSH private key path
  --ssh-pass <pass>          SSH password
  --local-only               Only configure and start local frpc (skip remote SSH)
  --remote-only              Only deploy frps on remote server
  --data-dir <dir>           Local data directory (default ~/.pi-web)
  --frp-version <ver>        Specify FRP version (default ${DEFAULT_FRP_VERSION})
`;

export async function frpCmd(argv) {
	const { opts, positionals } = parseFrpArgs(argv);

	if (opts.help) {
		console.log(ZH ? FRP_HELP_ZH : FRP_HELP_EN);
		return;
	}

	const subCmd = positionals[0] || (opts.scriptOnly ? "script" : opts.server ? "deploy" : "");

	switch (subCmd) {
		case "start":
			await startLocalFrpc({ dataDir: opts.dataDir, version: opts.version });
			break;
		case "stop":
			stopLocalFrpc({ dataDir: opts.dataDir });
			break;
		case "restart":
			stopLocalFrpc({ dataDir: opts.dataDir });
			await startLocalFrpc({ dataDir: opts.dataDir, version: opts.version });
			break;
		case "status":
			statusLocalFrpc({ dataDir: opts.dataDir });
			break;
		case "run":
			await runLocalFrpcForeground({ dataDir: opts.dataDir, version: opts.version });
			break;
		case "install":
			installLocalFrpcService({ dataDir: opts.dataDir });
			break;
		case "uninstall":
			uninstallLocalFrpcService({ dataDir: opts.dataDir });
			break;
		case "log": {
			const logPath = join(getFrpDataDir(opts.dataDir), "frpc.log");
			if (!existsSync(logPath)) {
				console.log(pick("暂无运行日志文件", "No log file found"));
			} else {
				console.log(readFileSync(logPath, "utf8"));
			}
			break;
		}
		case "script": {
			const serverPort = opts.serverPort || DEFAULT_SERVER_PORT;
			const localPort = opts.localPort || getDefaultLocalPort();
			const remotePort = opts.remotePort || localPort;
			const token = opts.token || generateRandomToken();
			const script = generateRemoteBashScript({
				version: opts.version,
				bindPort: serverPort,
				remotePort,
				token,
			});
			console.log(script);
			break;
		}
		case "deploy":
		case "": {
			let config = { ...opts };

			if (!config.server && process.stdin.isTTY) {
				const wizardConfig = await runInteractiveWizard(opts);
				config = { ...config, ...wizardConfig };
			} else if (!config.server && !opts.scriptOnly) {
				throw new Error(
					pick(
						`缺少 --server 参数。请通过 --server <host> 指定远程服务器公网地址，或运行交互向导。\n${FRP_HELP_ZH}`,
						`Missing --server option. Specify remote server IP via --server <host> or run wizard.\n${FRP_HELP_EN}`,
					),
				);
			}

			const serverAddr = config.server;
			const serverPort = config.serverPort || DEFAULT_SERVER_PORT;
			const localPort = config.localPort || getDefaultLocalPort();
			const remotePort = config.remotePort || localPort;
			const token = config.token || generateRandomToken();
			const version = config.version || DEFAULT_FRP_VERSION;

			console.log("\n================================================================================");
			console.log(pick("🚀 开始 FRP 穿透部署", "🚀 Starting FRP Deployment"));
			console.log("================================================================================");
			console.log(pick(`  远程服务器地址 : ${serverAddr}`, `  Remote Server  : ${serverAddr}`));
			console.log(pick(`  FRP 通信端口   : ${serverPort}`, `  FRP Port       : ${serverPort}`));
			console.log(pick(`  本地服务端口   : ${localPort}`, `  Local Port     : ${localPort}`));
			console.log(pick(`  外网访问端口   : ${remotePort}`, `  Remote Port    : ${remotePort}`));
			console.log(pick(`  安全 Token     : ${token}`, `  Auth Token     : ${token}`));
			console.log("================================================================================\n");

			const shouldDeployRemote = !config.localOnly && config.autoRemote !== false;
			if (shouldDeployRemote) {
				console.log(
					pick("步骤 1/2: 正在自动部署远程服务器端 (frps)...", "Step 1/2: Deploying remote server (frps)..."),
				);
				await deployRemoteFrpsViaSsh({
					host: serverAddr,
					port: config.sshPort || DEFAULT_SSH_PORT,
					username: config.sshUser || DEFAULT_SSH_USER,
					password: config.sshPass,
					privateKeyPath: config.sshKey,
					serverPort,
					remotePort,
					token,
					version,
				});
				console.log(pick("✔ 远程服务器端 (frps) 部署成功！\n", "✔ Remote server (frps) deployed successfully!\n"));
			} else if (config.localOnly) {
				console.log(pick("ℹ 已跳过远程部署 (--local-only)\n", "ℹ Skipped remote deployment (--local-only)\n"));
			}

			if (!config.remoteOnly) {
				console.log(
					pick(
						"步骤 2/2: 正在配置并启动本地客户端 (frpc)...",
						"Step 2/2: Configuring and starting local client (frpc)...",
					),
				);
				const frpDir = getFrpDataDir(config.dataDir);
				mkdirSync(frpDir, { recursive: true });

				await ensureLocalFrpc({ dataDir: config.dataDir, version });

				const frpcContent = generateFrpcToml({
					serverAddr,
					serverPort,
					token,
					localPort,
					remotePort,
				});
				const configPath = join(frpDir, "frpc.toml");
				writeFileSync(configPath, frpcContent, "utf8");
				console.log(pick(`✔ 已写入本地配置文件: ${configPath}`, `✔ Wrote local configuration: ${configPath}`));

				saveFrpState(config.dataDir, {
					serverAddr,
					serverPort,
					localPort,
					remotePort,
					token,
					version,
				});

				await startLocalFrpc({ dataDir: config.dataDir, version });
			}

			console.log("\n================================================================================");
			console.log(pick("🎉 FRP 隧道部署完成！", "🎉 FRP Tunnel Deployment Complete!"));
			console.log("================================================================================");
			console.log(
				pick(
					`👉 公网访问链接 : http://${serverAddr}:${remotePort}`,
					`👉 Public URL   : http://${serverAddr}:${remotePort}`,
				),
			);
			console.log(
				pick(`👉 本地映射目标 : http://127.0.0.1:${localPort}`, `👉 Local Target : http://127.0.0.1:${localPort}`),
			);
			console.log(
				pick(
					`👉 常用管理命令 : pi-web-ui frp status | start | stop | restart`,
					`👉 Management  : pi-web-ui frp status | start | stop | restart`,
				),
			);
			console.log("================================================================================\n");
			break;
		}
		default:
			throw new Error(
				pick(
					`未知子命令: ${subCmd}（支持 deploy / start / stop / restart / status / run / install / uninstall / script / log）`,
					`Unknown subcommand: ${subCmd} (supported: deploy / start / stop / restart / status / run / install / uninstall / script / log)`,
				),
			);
	}
}
