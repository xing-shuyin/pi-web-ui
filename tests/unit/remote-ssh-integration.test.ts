import { expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Server, utils, type Connection } from "ssh2";
import * as nodePty from "node-pty";
import { RemoteSshService, shellQuotePosix } from "../../server/remote-ssh-service.js";

const posix = (file: string) =>
	file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
const shell =
	process.platform === "win32"
		? path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe")
		: "/bin/sh";

it("uses saved authentication and known_hosts over real SSH, transfers env without echo and closes only its PTY channel", async () => {
	const root = await fs.mkdtemp(
		path.join(process.platform === "win32" ? "E:/tmp" : os.tmpdir(), "remote-ssh-integration-"),
	);
	const service = new RemoteSshService(root);
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const parsedKey = utils.parseKey(privateKey);
	if (parsedKey instanceof Error || Array.isArray(parsedKey)) throw new Error("Invalid fixture SSH host key");
	const publicKey = parsedKey.getPublicSSH();
	const clients = new Set<Connection>();
	const children = new Set<nodePty.IPty>();
	const commands: string[] = [];
	let rawPtyOutput = "";
	let authenticationCount = 0;
	let acceptedConnections = 0;
	let serverStarted = false;
	const server = new Server({ hostKeys: [privateKey] }, (client) => {
		acceptedConnections++;
		clients.add(client);
		client.on("error", () => {});
		client.once("close", () => clients.delete(client));
		client.on("authentication", (context) => {
			if (context.method === "password") authenticationCount++;
			if (
				context.method === "password" &&
				context.username === "fixture" &&
				context.password === "fixture-ssh-password"
			)
				context.accept();
			else context.reject();
		});
		client.on("ready", () =>
			client.on("session", (accept) => {
				const session = accept();
				session.on("pty", (accept) => accept?.());
				session.on("window-change", (accept) => accept?.());
				session.on("sftp", (accept) => {
					const stream = accept();
					stream.on("error", () => {});
				});
				session.on("exec", (accept, _reject, info) => {
					commands.push(info.command);
					const stream = accept();
					stream.on("error", () => {});
					if (!info.command.includes("PI_WEB_READY_")) {
						stream.write("SHARED_CONNECTION_ALIVE");
						stream.exit(0);
						stream.end();
						return;
					}
					const child = nodePty.spawn(
						shell,
						["-c", `PATH=${shellQuotePosix(`${posix(root)}/bin:/usr/bin:/bin`)}; export PATH; ${info.command}`],
						{
							name: "xterm-256color",
							cols: 80,
							rows: 24,
							cwd: root,
							env: { ...process.env, HOME: posix(root), CONFLICT: "remote-login" },
						},
					);
					children.add(child);
					child.onData((data) => {
						rawPtyOutput += data;
						if (!stream.destroyed) stream.write(data);
					});
					child.onExit(({ exitCode }) => {
						children.delete(child);
						if (!stream.destroyed) {
							try {
								stream.exit(exitCode);
								stream.end();
							} catch {}
						}
					});
					stream.on("data", (data: Buffer) => child.write(data.toString("utf8")));
					stream.once("close", () => {
						children.delete(child);
						try {
							child.kill();
						} catch {}
					});
				});
			}),
		);
	});
	const knownHosts = path.join(root, "known_hosts");
	vi.stubEnv("PI_WEB_SSH_KNOWN_HOSTS", knownHosts);
	try {
		await fs.mkdir(path.join(root, "bin"));
		await fs.writeFile(path.join(root, "bin/uname"), "#!/bin/sh\nprintf '%s\\n' Linux\n", { mode: 0o755 });
		await fs.chmod(path.join(root, "bin/uname"), 0o755);
		const target = path.join(root, "bin/target");
		await fs.writeFile(
			target,
			"#!/bin/sh\n[ -z \"${CONFLICT+x}\" ] || exit 22\nprintf 'TARGET_ENV_LENGTH=%s\\n' \"${#SECRET}\"\nwhile IFS= read -r input; do printf 'PONG\\n'; done\n",
			{ mode: 0o755 },
		);
		await fs.chmod(target, 0o755);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				serverStarted = true;
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string" || address.port < 8900)
			throw new Error("Expected isolated test port >=8900");
		const port = address.port;
		const uri = `ssh://fixture@127.0.0.1:${port}${posix(root)}`;
		await service.saveProfile("local-fixture", {
			host: "127.0.0.1",
			port,
			username: "fixture",
			auth: { type: "password", password: "fixture-ssh-password" },
		});
		await fs.writeFile(knownHosts, "");
		await expect(service.getOrConnectHost("127.0.0.1", port, "fixture")).rejects.toThrow(/untrusted|未受信任/);
		expect(authenticationCount).toBe(0);
		await fs.writeFile(knownHosts, `[127.0.0.1]:${port} ${parsedKey.type} ${publicKey.toString("base64")}\n`);
		const credential = "fixture-api-credential-'$(touch injected)\nsecond-line";
		const pty = await service.createCommandPty(
			uri,
			{ file: posix(target), args: [], env: { SECRET: credential }, unsetEnv: ["CONFLICT"] },
			80,
			24,
		);
		const waitForOutput = (pty: nodePty.IPty, expected: string) =>
			new Promise<void>((resolve, reject) => {
				let output = "";
				let subscription: { dispose(): void } | undefined;
				const timer = setTimeout(() => {
					subscription?.dispose();
					reject(new Error("Expected remote output was not received"));
				}, 5000);
				subscription = pty.onData((data) => {
					output += data;
					if (output.includes(expected)) {
						clearTimeout(timer);
						subscription?.dispose();
						resolve();
					}
				});
			});
		await waitForOutput(pty, `TARGET_ENV_LENGTH=${credential.length}`);
		const sibling = await service.createCommandPty(
			uri,
			{ file: posix(target), args: [], env: { SECRET: "second-fixture" }, unsetEnv: ["CONFLICT"] },
			80,
			24,
		);
		await waitForOutput(sibling, "TARGET_ENV_LENGTH=14");
		const conn = await service.getOrConnectHost("127.0.0.1", port, "fixture");
		expect(conn.activeOperations).toBe(2);
		pty.kill();
		expect(conn.alive).toBe(true);
		expect(conn.activeOperations).toBe(1);
		const siblingOutput = waitForOutput(sibling, "PONG");
		sibling.write("ping\r");
		await siblingOutput;
		const result = await service.execInWorkspace(uri, "printf SHARED_CONNECTION_ALIVE");
		expect(result).toEqual({ stdout: "SHARED_CONNECTION_ALIVE", stderr: "", exitCode: 0 });
		expect(authenticationCount).toBe(1);
		expect(acceptedConnections).toBe(2);
		expect(commands.join("\n")).not.toContain("fixture-api-credential");
		expect(rawPtyOutput).not.toContain("fixture-api-credential");
		expect(rawPtyOutput).not.toContain("export SECRET");
		await expect(fs.stat(path.join(root, "injected"))).rejects.toThrow();
		sibling.kill();
		expect(conn.activeOperations).toBe(0);
		expect(conn.alive).toBe(true);
	} finally {
		for (const conn of (service as any).connections.values()) service.closeConnection(conn.id);
		for (const child of children) {
			try {
				child.kill();
			} catch {}
		}
		for (const client of clients) client.end();
		if (serverStarted) await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.unstubAllEnvs();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
