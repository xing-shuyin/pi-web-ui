import { randomBytes } from "node:crypto";
import type { IPty } from "node-pty";
import { shellQuotePosix, type RemoteSshService } from "./remote-ssh-service.js";

type PersistenceService = Pick<RemoteSshService, "execInWorkspace" | "createCommandPty">;
type Launch = { file: string; args: string[]; env?: NodeJS.ProcessEnv; unsetEnv?: string[] };
export interface PersistentRemoteNativeCli {
	pty: IPty;
	created: boolean;
	sessionName: string;
	terminate: () => Promise<void>;
	/** A failed SSH probe rejects: connectivity loss is not evidence of process completion. */
	probe: () => Promise<{ alive: boolean; exitCode?: number }>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const locks = new WeakMap<PersistenceService, Map<string, Promise<void>>>();
const cancelled = (signal?: AbortSignal) => {
	if (signal?.aborted) throw new Error("Remote CLI launch cancelled");
};

async function tmuxExecutable(service: PersistenceService, uri: string, signal?: AbortSignal): Promise<string> {
	cancelled(signal);
	const result = await service.execInWorkspace(
		uri,
		`/bin/sh -c ${shellQuotePosix("set +x; unset TMUX TMUX_PANE; command -v tmux && tmux -V")}`,
		{ cwd: "/", timeoutMs: 10_000, signal },
	);
	const [file, version] = result.stdout.trim().split(/\r?\n/);
	const match = /^tmux (\d+)\.(\d+)[a-z]?$/.exec(version ?? "");
	if (
		result.exitCode !== 0 ||
		!file?.startsWith("/") ||
		/[\x00-\x1f\x7f]/.test(file) ||
		!match ||
		Number(match[1]) < 3 ||
		(Number(match[1]) === 3 && Number(match[2]) < 2)
	)
		throw new Error("SSH keep-alive requires tmux 3.2 or newer on the remote host");
	return file;
}

export async function probeRemoteCliPersistence(
	service: PersistenceService,
	uri: string,
	signal?: AbortSignal,
): Promise<{ available: boolean; error?: string }> {
	try {
		await tmuxExecutable(service, uri, signal);
		return { available: true };
	} catch (error) {
		cancelled(signal);
		return { available: false, error: error instanceof Error ? error.message : "Remote tmux probe failed" };
	}
}

async function exclusive<T>(service: PersistenceService, id: string, action: () => Promise<T>): Promise<T> {
	let map = locks.get(service);
	if (!map) locks.set(service, (map = new Map()));
	const previous = map.get(id) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	map.set(id, current);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (map.get(id) === current) map.delete(id);
	}
}

function validateKey(key: string): void {
	// This validates a server-generated identifier; the caller must never accept a client-selected key.
	if (!uuid.test(key)) throw new Error("Invalid remote CLI persistence key");
}

async function remoteCliControl(service: PersistenceService, uri: string, key: string, signal?: AbortSignal) {
	validateKey(key);
	const sessionName = `pi-web-cli-${key}`;
	const lockId = `${uri}\0${key}`;
	cancelled(signal);
	const executable = await tmuxExecutable(service, uri, signal);
	const q = shellQuotePosix;
	const prelude = [
		"set +x",
		"unset TMUX TMUX_PANE",
		"umask 077",
		"PI_WEB_TMUX_UID=$(id -u) || exit 125",
		'case "$PI_WEB_TMUX_UID" in ""|*[!0-9]*) exit 125;; esac',
		`PI_WEB_SOCKET="/tmp/tmux-$PI_WEB_TMUX_UID/${sessionName}"`,
		'[ ! -L "$PI_WEB_SOCKET" ] || exit 125',
		`pi_tmux() { TMUX_TMPDIR=/tmp ${q(executable)} -f /dev/null -L ${q(sessionName)} "$@"; }`,
	].join("\n");
	const exec = async (script: string, requestSignal?: AbortSignal) => {
		cancelled(requestSignal);
		const result = await service.execInWorkspace(uri, `/bin/sh -c ${q(`${prelude}\n${script}`)}`, {
			cwd: "/",
			timeoutMs: 10_000,
			signal: requestSignal,
		});
		cancelled(requestSignal);
		return result;
	};
	type State = { alive: boolean; exitCode?: number; state?: string; pid?: string; id?: string; generation?: string };
	const inspect = async (requestSignal?: AbortSignal): Promise<State> => {
		const marker = randomBytes(16).toString("hex");
		const result = await exec(
			[
				`if PI_WEB_STATE=$(LC_ALL=C pi_tmux display-message -p -t ${q(sessionName)} ${q(`${marker}|#{@pi-web-owner}|#{@pi-web-state}|#{pane_dead}|#{pane_dead_status}|#{pid}|#{session_id}|#{@pi-web-generation}`)} 2>&1); then`,
				'    printf "%s\\n" "$PI_WEB_STATE"',
				"  else",
				// tmux leaves a stale Unix socket after the last session. These kernel/client errors prove
				// the private server is gone; SSH failures never reach this branch and still reject.
				'    case "$PI_WEB_STATE" in',
				'      "no server running on $PI_WEB_SOCKET"|"error connecting to $PI_WEB_SOCKET (Connection refused)"|"error connecting to $PI_WEB_SOCKET (No such file or directory)")',
				`        printf '%s\\n' ${q(`${marker}|absent`)};;`,
				"      *) exit 125;;",
				"    esac",
				"fi",
			].join("\n"),
			requestSignal,
		);
		if (result.exitCode !== 0) throw new Error("Remote CLI persistence state could not be verified");
		const line = result.stdout.trim();
		if (line === `${marker}|absent`) return { alive: false };
		const fields = line.split("|");
		if (
			fields.length !== 8 ||
			fields[0] !== marker ||
			fields[1] !== key ||
			!["starting", "running"].includes(fields[2]) ||
			!/^[01]$/.test(fields[3]) ||
			!/^\d+$/.test(fields[5]) ||
			!/^\$\d+$/.test(fields[6]) ||
			!/^[a-f0-9]{32}$/.test(fields[7])
		)
			throw new Error("Remote CLI tmux session ownership could not be verified");
		return {
			alive: fields[3] === "0",
			state: fields[2],
			pid: fields[5],
			id: fields[6],
			generation: fields[7],
			...(fields[3] === "1" && /^\d+$/.test(fields[4]) ? { exitCode: Number(fields[4]) } : {}),
		};
	};
	const probe = async (generation?: string) => {
		const state = await inspect();
		if (generation && state.generation !== generation) return { alive: false };
		return { alive: state.alive, ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }) };
	};
	const terminate = (generation?: string) =>
		exclusive(service, lockId, async () => {
			const state = await inspect();
			if (!state.id || (generation && state.generation !== generation)) return;
			const condition = `#{&&:#{==:#{pid},${state.pid}},#{&&:#{==:#{session_id},${state.id}},#{==:#{@pi-web-generation},${state.generation}}}}`;
			await exec(`pi_tmux if-shell -F -t ${q(sessionName)} ${q(condition)} ${q(`kill-session -t ${state.id}`)} ''`);
			const remaining = await inspect();
			if (remaining.id && (!generation || remaining.generation === generation))
				throw new Error("Remote CLI could not be stopped; retry explicit termination");
		});
	const bind = (generation: string) => ({ probe: () => probe(generation), terminate: () => terminate(generation) });
	return { sessionName, executable, prelude, exec, inspect, probe, terminate, bind };
}

export async function probePersistentRemoteNativeCli(service: PersistenceService, uri: string, key: string) {
	return (await remoteCliControl(service, uri, key)).probe();
}

export async function terminatePersistentRemoteNativeCli(
	service: PersistenceService,
	uri: string,
	key: string,
): Promise<void> {
	await (await remoteCliControl(service, uri, key)).terminate();
}

export async function attachPersistentRemoteNativeCli(
	service: PersistenceService,
	uri: string,
	options: { key: string; cols: number; rows: number; signal?: AbortSignal },
): Promise<PersistentRemoteNativeCli> {
	const { key, signal } = options;
	validateKey(key);
	return exclusive(service, `${uri}\0${key}`, async () => {
		const control = await remoteCliControl(service, uri, key, signal);
		const state = await control.inspect(signal);
		if (!state.id) throw new Error("Remote CLI tmux session is missing; retry to resume the CLI");
		const q = shellQuotePosix;
		const token = randomBytes(16).toString("hex");
		const prefix = `__PI_WEB_ATTACH_${token}_`;
		const condition = `#{&&:#{==:#{pid},${state.pid}},#{&&:#{==:#{session_id},${state.id}},#{&&:#{==:#{@pi-web-owner},${key}},#{==:#{@pi-web-generation},${state.generation}}}}}`;
		const args = [
			"-f",
			"/dev/null",
			"-L",
			control.sessionName,
			"if-shell",
			"-F",
			"-t",
			state.id,
			condition,
			`attach-session -t ${state.id}`,
			"display-message -p 'Remote CLI attachment changed; retry'",
		];
		let pty: IPty | undefined;
		try {
			pty = await service.createCommandPty(uri, { file: control.executable, args }, options.cols, options.rows, {
				signal,
				prepareBootstrap: async () => ({
					command: `/bin/sh -c ${q(
						[
							control.prelude,
							`printf '%s%s__\\n' ${q(prefix)} "$$"`,
							"export TMUX_TMPDIR=/tmp",
							`exec ${[control.executable, ...args].map(q).join(" ")}`,
						].join("\n"),
					)}`,
					skipHandshake: true,
				}),
			});
			const client = pty;
			const controller = new AbortController();
			const abort = () => controller.abort();
			const timer = setTimeout(abort, 10_000);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			let initialOutput = "";
			let clientPid: string | undefined;
			const subscribe = client.onData.bind(client);
			const data = subscribe((chunk) => {
				initialOutput += chunk;
				if (initialOutput.length > 256 * 1024) return abort();
				if (!clientPid) {
					const match = new RegExp(`${prefix}(\\d+)__`).exec(initialOutput);
					if (match) {
						clientPid = match[1];
						initialOutput = initialOutput.slice(0, match.index) + initialOutput.slice(match.index + match[0].length);
					}
				}
			});
			const exit = client.onExit(abort);
			try {
				for (;;) {
					cancelled(controller.signal);
					if (clientPid) {
						const marker = `${token}|${state.pid}|${state.id}|${clientPid}|${key}|${state.generation}`;
						const result = await control.exec(
							`pi_tmux list-clients -t ${q(state.id)} -F ${q(`${token}|#{pid}|#{session_id}|#{client_pid}|#{@pi-web-owner}|#{@pi-web-generation}`)}`,
							controller.signal,
						);
						cancelled(controller.signal);
						if (result.exitCode !== 0) throw new Error("Remote tmux attachment could not be confirmed");
						if (result.stdout.split(/\r?\n/).includes(marker)) break;
					}
					await new Promise<void>((resolve) => setTimeout(resolve, 50));
				}
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				data.dispose();
				exit.dispose();
			}
			const attachedPty = new Proxy(client, {
				get(target, property) {
					if (property === "onData")
						return (listener: (chunk: string) => void) => {
							if (initialOutput) {
								const buffered = initialOutput;
								initialOutput = "";
								listener(buffered);
							}
							return subscribe(listener);
						};
					return Reflect.get(target, property, target);
				},
			});
			return { pty: attachedPty, created: false, sessionName: control.sessionName, ...control.bind(state.generation!) };
		} catch (error) {
			pty?.kill();
			if (signal?.aborted) throw new Error("Remote CLI attachment cancelled");
			throw new Error("Remote CLI tmux session disappeared or changed before attachment; retry", { cause: error });
		}
	});
}

export async function openPersistentRemoteNativeCli(
	service: PersistenceService,
	uri: string,
	launch: Launch,
	options: { key: string; cols: number; rows: number; signal?: AbortSignal },
): Promise<PersistentRemoteNativeCli> {
	const { key, signal } = options;
	validateKey(key);
	return exclusive(service, `${uri}\0${key}`, async () => {
		const control = await remoteCliControl(service, uri, key, signal);
		const { executable, prelude, exec, inspect, sessionName } = control;
		const q = shellQuotePosix;
		let created = false;
		let generation: string | undefined;
		const pty = await service.createCommandPty(
			uri,
			{
				...launch,
				env: Object.fromEntries(
					Object.entries(launch.env ?? {}).filter(([name]) => name !== "TMUX" && name !== "TMUX_PANE"),
				),
				unsetEnv: [...new Set([...(launch.unsetEnv ?? []), "TMUX", "TMUX_PANE"])],
			},
			options.cols,
			options.rows,
			{
				signal,
				prepareBootstrap: async (bootstrap) => {
					let state = await inspect(signal);
					if (!state.alive && state.id) {
						const condition = `#{&&:#{==:#{pid},${state.pid}},#{&&:#{==:#{session_id},${state.id}},#{&&:#{==:#{@pi-web-generation},${state.generation}},#{pane_dead}}}}`;
						await exec(
							`pi_tmux if-shell -F -t ${q(sessionName)} ${q(condition)} ${q(`kill-session -t ${state.id}`)} ''`,
							signal,
						);
						state = await inspect(signal);
					}
					if (!state.alive) {
						const paneBootstrap = bootstrap
							.replace(
								`trap 'stty "$PI_WEB_BOOTSTRAP_TTY" 2>/dev/null' 0`,
								[
									"PI_WEB_BOOTSTRAP_PID=$$",
									'(sleep 25; kill -TERM "$PI_WEB_BOOTSTRAP_PID" 2>/dev/null) </dev/null >/dev/null 2>&1 &',
									"PI_WEB_BOOTSTRAP_WATCHDOG=$!",
									`trap 'kill "$PI_WEB_BOOTSTRAP_WATCHDOG" 2>/dev/null; stty "$PI_WEB_BOOTSTRAP_TTY" 2>/dev/null' 0`,
								].join("\n"),
							)
							.replace(
								'eval "$PI_WEB_BOOTSTRAP_PAYLOAD" || exit 125',
								[
									'kill "$PI_WEB_BOOTSTRAP_WATCHDOG" 2>/dev/null; wait "$PI_WEB_BOOTSTRAP_WATCHDOG" 2>/dev/null',
									"unset PI_WEB_BOOTSTRAP_WATCHDOG PI_WEB_BOOTSTRAP_PID",
									prelude,
									`pi_tmux set-option -t ${q(sessionName)} @pi-web-state running || exit 125`,
									'eval "$PI_WEB_BOOTSTRAP_PAYLOAD" || exit 125',
								].join("\n"),
							);
						const cols = Math.max(2, Math.floor(options.cols) || 80);
						const rows = Math.max(2, Math.floor(options.rows) || 24);
						const result = await exec(
							[
								`if pi_tmux new-session -d -s ${q(sessionName)} -x ${cols} -y ${rows} /bin/sh -c ${q(paneBootstrap)}`,
								`  \\; set-option -t ${q(sessionName)} @pi-web-owner ${q(key)}`,
								`  \\; set-option -t ${q(sessionName)} @pi-web-generation ${q(randomBytes(16).toString("hex"))}`,
								`  \\; set-option -t ${q(sessionName)} @pi-web-state starting`,
								`  \\; set-option -t ${q(sessionName)} update-environment ''`,
								`  \\; set-option -t ${q(sessionName)} status off`,
								`  \\; set-window-option -t ${q(sessionName)} remain-on-exit on; then`,
								"  printf 'created\\n'",
								"else",
								"  printf 'existing\\n'",
								"fi",
							]
								.join("\n")
								.replace(/\n  \\;/g, " \\;"),
							signal,
						);
						if (result.exitCode !== 0 || !["created", "existing"].includes(result.stdout.trim()))
							throw new Error("Remote CLI tmux session could not be created");
						created = result.stdout.trim() === "created";
						state = await inspect(signal);
					}
					const deadline = Date.now() + 20_000;
					while (!created && state.alive && state.state === "starting") {
						if (Date.now() >= deadline) throw new Error("Remote CLI startup is in progress; retry after 25 seconds");
						await new Promise<void>((resolve, reject) => {
							const abort = () => {
								clearTimeout(timer);
								reject(new Error("Remote CLI launch cancelled"));
							};
							const timer = setTimeout(() => {
								signal?.removeEventListener("abort", abort);
								resolve();
							}, 100);
							signal?.addEventListener("abort", abort, { once: true });
							if (signal?.aborted) abort();
						});
						state = await inspect(signal);
					}
					if (!state.alive) throw new Error("Remote CLI tmux pane exited before attachment");
					generation = state.generation;
					const condition = `#{&&:#{==:#{pid},${state.pid}},#{&&:#{==:#{session_id},${state.id}},#{==:#{@pi-web-generation},${generation}}}}`;
					const attach = [
						executable,
						"-f",
						"/dev/null",
						"-L",
						sessionName,
						"if-shell",
						"-F",
						"-t",
						state.id!,
						condition,
						`attach-session -t ${state.id}`,
						"display-message -p 'Remote CLI attachment changed; retry'",
					];
					return {
						command: `/bin/sh -c ${q(`${prelude}\nexport TMUX_TMPDIR=/tmp\nexec ${attach.map(q).join(" ")}`)}`,
						skipHandshake: !created,
					};
				},
			},
		);
		try {
			if ((await inspect(signal)).generation !== generation)
				throw new Error("Remote CLI tmux session changed before attachment; retry");
		} catch (error) {
			pty.kill();
			throw error;
		}
		return {
			pty,
			created,
			sessionName,
			...control.bind(generation!),
		};
	});
}
