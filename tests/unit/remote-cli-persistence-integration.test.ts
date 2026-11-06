import { expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { Client, Server, type Connection } from "ssh2";
import * as nodePty from "node-pty";
import {
	attachPersistentRemoteNativeCli,
	openPersistentRemoteNativeCli,
	probeRemoteCliPersistence,
	probePersistentRemoteNativeCli,
	terminatePersistentRemoteNativeCli,
} from "../../server/remote-cli-persistence.js";
import { RemoteSshService, shellQuotePosix } from "../../server/remote-ssh-service.js";

const wslPrefix = process.env.PI_WEB_TEST_TMUX_WSL_PREFIX;
const binary = process.env.PI_WEB_TEST_TMUX_BINARY;
const enabled = process.platform === "win32" ? Boolean(wslPrefix) : Boolean(binary);
const toRemote = (file: string) =>
	process.platform === "win32"
		? file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`)
		: file;

it.skipIf(!enabled)(
	"keeps real tmux CLI alive across SSH/service loss without leaking credentials or stopping sibling channels",
	async () => {
		const root = await fs.mkdtemp(
			path.join(process.platform === "win32" ? "E:/tmp" : os.tmpdir(), "ssh-tmux-integration-"),
		);
		const remoteRoot = toRemote(root);
		const homeRoot = path.join(root, "long-home-".repeat(15));
		const remoteHome = toRemote(homeRoot);
		const prefix = process.platform === "win32" ? wslPrefix! : path.dirname(path.dirname(binary!));
		const executable = process.platform === "win32" ? "wsl.exe" : "/bin/sh";
		const remoteCommand = (command: string) => {
			const script = `export HOME=${shellQuotePosix(remoteHome)} PATH=${shellQuotePosix(`${prefix}/bin:/usr/bin:/bin`)} LD_LIBRARY_PATH=${shellQuotePosix(`${prefix}/lib`)} TERMINFO=${shellQuotePosix(`${prefix}/share/terminfo`)} TERM=xterm-256color; ${command}`;
			return process.platform === "win32"
				? ["-d", process.env.PI_WEB_TEST_WSL_DISTRO ?? "openEuler-24.03", "--exec", "/bin/sh", "-c", script]
				: ["-c", script];
		};
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs1", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const connections = new Set<Connection>();
		const services: RemoteSshService[] = [];
		const children = new Set<{ kill(): void }>();
		const handles: Awaited<ReturnType<typeof openPersistentRemoteNativeCli>>[] = [];
		const ownedSessions = new Set<string>();
		const commands: string[] = [];
		let rawOutput = "";
		let port = 0;
		const server = new Server({ hostKeys: [privateKey] }, (connection) => {
			connections.add(connection);
			connection.on("error", () => {});
			connection.once("close", () => connections.delete(connection));
			connection.on("authentication", (context) => context.accept());
			connection.on("ready", () =>
				connection.on("session", (accept) => {
					const session = accept();
					let ptyOptions: { cols: number; rows: number } | undefined;
					let pty: nodePty.IPty | undefined;
					session.on("pty", (accept, _reject, info) => {
						ptyOptions = info;
						accept?.();
					});
					session.on("window-change", (accept, _reject, info) => {
						pty?.resize(info.cols, info.rows);
						accept?.();
					});
					session.on("exec", (accept, _reject, info) => {
						commands.push(info.command);
						const stream = accept();
						stream.on("error", () => {});
						if (ptyOptions) {
							pty = nodePty.spawn(executable, remoteCommand(info.command), {
								name: "xterm-256color",
								cols: ptyOptions.cols,
								rows: ptyOptions.rows,
								cwd: root,
								env: process.env,
							});
							const child = pty;
							children.add(child);
							child.onData((data) => {
								rawOutput += data;
								if (!stream.destroyed) stream.write(data);
							});
							child.onExit(({ exitCode }) => {
								children.delete(child);
								if (!stream.destroyed) {
									stream.exit(exitCode);
									stream.end();
								}
							});
							stream.on("data", (data: Buffer) => child.write(data.toString("utf8")));
							stream.once("close", () => {
								try {
									child.kill();
								} catch {}
							});
						} else {
							const child = spawn(executable, remoteCommand(info.command), { cwd: root, windowsHide: true });
							children.add(child);
							child.stdout.on("data", (data: Buffer) => {
								if (!stream.destroyed) stream.write(data);
							});
							child.stderr.on("data", (data: Buffer) => {
								if (!stream.destroyed) stream.stderr.write(data);
							});
							child.on("close", (code) => {
								children.delete(child);
								if (!stream.destroyed) {
									stream.exit(code ?? 1);
									stream.end();
								}
							});
							child.on("error", () => {
								if (!stream.destroyed) {
									stream.exit(127);
									stream.end();
								}
							});
							stream.on("data", (data: Buffer) => child.stdin.write(data));
							stream.once("close", () => child.kill());
						}
					});
				}),
			);
		});
		const service = async () => {
			const client = new Client();
			client.on("error", () => {});
			await new Promise<void>((resolve, reject) => {
				client.once("ready", resolve).once("error", reject);
				client.connect({ host: "127.0.0.1", port, username: "fixture", readyTimeout: 10_000 });
			});
			const result = new RemoteSshService(root);
			services.push(result);
			const conn = (result as any).registerConnection(client, {
				host: "127.0.0.1",
				port,
				username: "fixture",
				auth: { type: "agent" },
			});
			vi.spyOn(result as any, "getOrConnectByUri").mockResolvedValue({ conn, parsed: { remotePath: remoteRoot } });
			return { service: result, conn };
		};
		const output = (pty: nodePty.IPty) => {
			let text = "";
			pty.onData((chunk) => {
				text += chunk;
			});
			return {
				wait: async (expected: string) => {
					await vi.waitFor(() => expect(stripVTControlCharacters(text)).toContain(expected), { timeout: 10_000 });
				},
			};
		};
		try {
			await fs.mkdir(homeRoot, { recursive: true });
			await fs.writeFile(
				path.join(root, "target"),
				[
					"#!/bin/sh",
					`printf "%s\\n" "$$" >> ${shellQuotePosix(`${remoteRoot}/starts`)}`,
					`printf "%s\\n" "$@" >> ${shellQuotePosix(`${remoteRoot}/arguments`)}`,
					'[ -z "${TMUX+x}" ] && [ -z "${TMUX_PANE+x}" ] || exit 22',
					'printf "TARGET_READY_%s_%s\\n" "${#MODEL_KEY}" "${#HEADERS}"',
					"hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }",
					'printf "KEY_HASH_"; printf "%s" "$MODEL_KEY" | hash',
					'printf "HEADERS_HASH_"; printf "%s" "$HEADERS" | hash',
					'while IFS= read -r line; do case "$line" in ping) printf "PONG\\n";; stop) exit 17;; esac; done',
					"",
				].join("\n"),
			);
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string" || address.port < 8900)
				throw new Error("Expected isolated port >=8900");
			port = address.port;
			const uri = `ssh://fixture@127.0.0.1:${port}${remoteRoot}`;
			const first = await service();
			const parallel = await service();
			expect(await probeRemoteCliPersistence(first.service, uri)).toEqual({ available: true });
			expect(
				(await first.service.execInWorkspace(uri, `chmod 700 ${shellQuotePosix(`${remoteRoot}/target`)}`)).exitCode,
			).toBe(0);
			const secret = `fixture-key-${randomUUID()}'$(touch injected)\nsecond`;
			const headers = `X-Fixture-A: one\nX-Fixture-B: two\tend\nX-Padding: ${"value".repeat(1500)}`;
			const launch = {
				file: `${remoteRoot}/target`,
				args: ["a b", "$(touch injected)", "x'y"],
				env: { MODEL_KEY: secret, HEADERS: headers },
			};
			const key = randomUUID();
			ownedSessions.add(`pi-web-cli-${key}`);
			expect(Buffer.byteLength(`${remoteHome}/.pi-web/native-cli/tmux/${key}.sock`)).toBeGreaterThan(107);
			const options = { key, cols: 100, rows: 40 };
			const [initial, concurrent] = await Promise.all([
				openPersistentRemoteNativeCli(first.service, uri, launch, options),
				openPersistentRemoteNativeCli(parallel.service, uri, launch, options),
			]);
			handles.push(initial, concurrent);
			expect([initial.created, concurrent.created].sort()).toEqual([false, true]);
			const initialOutput = output(initial.pty);
			await initialOutput.wait(`TARGET_READY_${secret.length}_${headers.length}`);
			await initialOutput.wait(`KEY_HASH_${createHash("sha256").update(secret).digest("hex")}`);
			await initialOutput.wait(`HEADERS_HASH_${createHash("sha256").update(headers).digest("hex")}`);
			expect((await fs.readFile(path.join(root, "starts"), "utf8")).trim().split("\n")).toHaveLength(1);
			const earlyAttachment = await attachPersistentRemoteNativeCli(first.service, uri, options);
			handles.push(earlyAttachment);
			earlyAttachment.pty.kill();
			initial.pty.kill();
			expect(await initial.probe()).toEqual({ alive: true });
			const beforeRestart = await fs.readFile(path.join(root, "starts"), "utf8");
			first.service.closeConnection(first.conn.id);
			parallel.service.closeConnection(parallel.conn.id);
			await expect(initial.probe()).rejects.toThrow();
			await expect(initial.terminate()).rejects.toThrow();
			await new Promise<void>((resolve) => setTimeout(resolve, 26_000));
			await fs.rename(path.join(root, "target"), path.join(root, "retired-target"));
			const next = await service();
			const [reattached, secondAttachment] = await Promise.all([
				attachPersistentRemoteNativeCli(next.service, uri, options),
				attachPersistentRemoteNativeCli(next.service, uri, options),
			]);
			handles.push(reattached, secondAttachment);
			expect(secondAttachment.created).toBe(false);
			expect(reattached.created).toBe(false);
			expect(await fs.readFile(path.join(root, "starts"), "utf8")).toBe(beforeRestart);
			expect(await fs.readFile(path.join(root, "arguments"), "utf8")).not.toContain("--resume");
			const reattachedOutput = output(reattached.pty);
			reattached.pty.write("ping\r");
			await reattachedOutput.wait("PONG");
			const tmuxEnvironment = await next.service.execInWorkspace(
				uri,
				`TMUX_TMPDIR=/tmp tmux -f /dev/null -L pi-web-cli-${key} show-environment -g`,
			);
			expect(tmuxEnvironment.exitCode).toBe(0);
			expect(tmuxEnvironment.stdout).not.toContain(secret);
			expect(tmuxEnvironment.stdout).not.toContain("MODEL_KEY=");
			expect(tmuxEnvironment.stdout).not.toContain("HEADERS=");
			await fs.rename(path.join(root, "retired-target"), path.join(root, "target"));
			const siblingKey = randomUUID();
			ownedSessions.add(`pi-web-cli-${siblingKey}`);
			const sibling = await openPersistentRemoteNativeCli(next.service, uri, launch, { ...options, key: siblingKey });
			handles.push(sibling);
			const deleting = await service();
			const createPty = next.service.createCommandPty.bind(next.service);
			const race = vi.spyOn(next.service, "createCommandPty").mockImplementationOnce(async (...args) => {
				await terminatePersistentRemoteNativeCli(deleting.service, uri, key);
				return createPty(...args);
			});
			await expect(attachPersistentRemoteNativeCli(next.service, uri, options)).rejects.toThrow(
				/disappeared or changed.*retry/,
			);
			race.mockRestore();
			await expect(attachPersistentRemoteNativeCli(next.service, uri, options)).rejects.toThrow(/missing.*retry/);
			expect(await reattached.probe()).toEqual({ alive: false });
			expect(await sibling.probe()).toEqual({ alive: true });
			const siblingOutput = output(sibling.pty);
			sibling.pty.write("ping\r");
			await siblingOutput.wait("PONG");
			sibling.pty.write("stop\r");
			await vi.waitFor(async () => expect(await sibling.probe()).toEqual({ alive: false, exitCode: 17 }), {
				timeout: 10_000,
			});
			expect(
				await probePersistentRemoteNativeCli(next.service, uri, sibling.sessionName.slice("pi-web-cli-".length)),
			).toEqual({ alive: false, exitCode: 17 });
			const deadAttachment = await attachPersistentRemoteNativeCli(next.service, uri, { ...options, key: siblingKey });
			handles.push(deadAttachment);
			expect(deadAttachment.created).toBe(false);
			expect(await deadAttachment.probe()).toEqual({ alive: false, exitCode: 17 });
			const resumed = await openPersistentRemoteNativeCli(
				next.service,
				uri,
				{ ...launch, args: ["--resume", "native-id"] },
				{ ...options, key: sibling.sessionName.slice("pi-web-cli-".length) },
			);
			handles.push(resumed);
			expect(resumed.created).toBe(true);
			await output(resumed.pty).wait("TARGET_READY");
			expect(await fs.readFile(path.join(root, "arguments"), "utf8")).toContain("--resume\nnative-id");
			expect(await sibling.probe()).toEqual({ alive: false });
			expect(await deadAttachment.probe()).toEqual({ alive: false });
			await sibling.terminate();
			await deadAttachment.terminate();
			expect(await resumed.probe()).toEqual({ alive: true });
			await terminatePersistentRemoteNativeCli(next.service, uri, sibling.sessionName.slice("pi-web-cli-".length));
			expect(await resumed.probe()).toEqual({ alive: false });
			expect(commands.join("\n")).not.toContain(secret);
			expect(commands.join("\n")).not.toContain("X-Fixture-A");
			expect(rawOutput).not.toContain(secret.slice(0, secret.indexOf("'")));
			expect(rawOutput).not.toContain("X-Fixture-A");
			expect(rawOutput).not.toContain("export MODEL_KEY");
			const checkFiles = async (directory: string): Promise<void> => {
				for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
					const file = path.join(directory, entry.name);
					if (entry.isDirectory()) await checkFiles(file);
					else if (entry.isFile()) {
						const contents = await fs.readFile(file);
						expect(contents.includes(Buffer.from(secret))).toBe(false);
						expect(contents.includes(Buffer.from(headers))).toBe(false);
					}
				}
			};
			await checkFiles(root);
			await expect(fs.stat(path.join(root, "injected"))).rejects.toThrow();
		} finally {
			// Kill only UUID servers created by this fixture, including a failed launch with no returned handle.
			await new Promise<void>((resolve) => {
				const cleanup = spawn(
					executable,
					remoteCommand(
						[
							...[...ownedSessions].map(
								(name) =>
									`TMUX_TMPDIR=/tmp tmux -f /dev/null -L ${shellQuotePosix(name)} kill-server >/dev/null 2>&1; rm -f "/tmp/tmux-$(id -u)/${name}"`,
							),
							"exit 0",
						].join("\n"),
					),
					{ windowsHide: true, stdio: "ignore" },
				);
				const timer = setTimeout(() => {
					cleanup.kill();
					resolve();
				}, 10_000);
				cleanup.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
				cleanup.once("error", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			for (const handle of handles) {
				try {
					await handle.terminate();
				} catch {}
				try {
					handle.pty.kill();
				} catch {}
			}
			for (const instance of services)
				for (const id of (instance as any).connections.keys()) instance.closeConnection(id);
			for (const connection of connections) connection.end();
			for (const child of children) {
				try {
					child.kill();
				} catch {}
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
			vi.restoreAllMocks();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	90_000,
);
