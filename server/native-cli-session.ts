import { randomUUID } from "node:crypto";
import { chmod, glob, lstat, mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { NativeCliConfig } from "./protocol.js";
import type { RemoteSshService } from "./remote-ssh-service.js";
import {
	NATIVE_CLI_EVENT_BYTES,
	NATIVE_CLI_EVENT_LIMIT,
	nativeCliCodexHookConflicts,
	nativeCliEventId,
	nativeCliPiExtension,
	nativeCliPosixReporter,
	parseNativeCliHookEvent,
	quoteNativeCliShell as quote,
	type NativeCliHookEvent,
	type NativeCliSessionEvent,
} from "./native-cli-session-hooks.js";

export type { NativeCliSessionEvent } from "./native-cli-session-hooks.js";
export interface NativeCliSessionRef {
	key: string;
	nativeId?: string;
	storeDir?: string;
}
export interface NativeCliSessionCapabilities {
	resume: "exact" | "explicit-only" | "none";
	events: "hooks" | "process";
}
export interface NativeCliSessionLaunch {
	/** Launch-only copy. Never persist its internal hook flags as the descriptor. */
	config: NativeCliConfig;
	env?: NodeJS.ProcessEnv;
	ref: NativeCliSessionRef;
	capabilities: NativeCliSessionCapabilities;
	start(): () => void;
	/** Drain the final official events before a natural process exit is disposed. */
	flush(): Promise<void>;
	/** Stops observation, retaining transcripts and scripts referenced by live tmux processes. */
	dispose(): Promise<void>;
}
export interface NativeCliSessionContext {
	cwd: string;
	dataDir: string;
	service?: RemoteSshService;
	signal?: AbortSignal;
	/** Last committed raw spool cursor, which can differ from a semantic event ID. */
	lastEventId?: string;
	/** Observe an existing process without preparing or modifying its CLI launch. */
	observeOnly?: boolean;
	onEvent(event: NativeCliSessionEvent): void;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "PreToolUse", "PostToolUse"];
const EVENT_FILE = /^[a-zA-Z0-9_.-]{1,180}\.json$/;

function flag(args: readonly string[], names: string[]): boolean {
	return args.some((arg) =>
		names.some(
			(name) =>
				arg === name ||
				arg.startsWith(name + "=") ||
				(name.length === 2 && !name.startsWith("--") && arg.startsWith(name)),
		),
	);
}
function flagValue(args: readonly string[], names: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		for (const name of names) {
			if (args[index].startsWith(name + "=")) return args[index].slice(name.length + 1);
			if (name.length === 2 && !name.startsWith("--") && args[index].startsWith(name) && args[index].length > 2)
				return args[index].slice(2);
			if (args[index] === name && args[index + 1] && !args[index + 1].startsWith("-")) return args[index + 1];
		}
	}
	return undefined;
}
function codexSubcommand(args: string[]): number {
	const values = new Set([
		"--config",
		"-c",
		"--model",
		"-m",
		"--profile",
		"-p",
		"--sandbox",
		"-s",
		"--ask-for-approval",
		"-a",
		"--cd",
		"-C",
		"--image",
		"-i",
		"--add-dir",
		"--enable",
		"--disable",
		"--local-provider",
	]);
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--") break;
		if (values.has(args[index])) {
			index++;
			continue;
		}
		if (args[index].startsWith("-")) continue;
		return args[index] === "resume" || args[index] === "fork" ? index : -1;
	}
	return -1;
}
function addOptions(args: string[], options: string[]): string[] {
	const separator = args.indexOf("--");
	return separator < 0 ? [...options, ...args] : [...args.slice(0, separator), ...options, ...args.slice(separator)];
}

async function boundedRead(file: string, limit: number): Promise<string> {
	const handle = await open(file, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > limit) return "";
		const bytes = Buffer.alloc(Math.min(stat.size, limit));
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		return bytes.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/** Only the binding owner may choose key/cwd/preset; no cwd-based "latest" search is used here. */
export async function prepareNativeCliSessionLaunch(
	config: NativeCliConfig,
	inputRef: NativeCliSessionRef,
	ctx: NativeCliSessionContext,
): Promise<NativeCliSessionLaunch> {
	if (!UUID.test(inputRef.key)) throw new Error("Invalid native CLI session binding key");
	ctx.signal?.throwIfAborted();
	const ref = { ...inputRef };
	const args = [...(config.args ?? [])];
	const optionArgs = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
	const remote = Boolean(ctx.service);
	const exec = async (command: string): Promise<string> => {
		ctx.signal?.throwIfAborted();
		const result = await ctx.service!.execInWorkspace(ctx.cwd, command, { timeoutMs: 5000, signal: ctx.signal });
		ctx.signal?.throwIfAborted();
		if (result.exitCode !== 0) throw new Error("Native CLI session storage operation failed");
		return result.stdout.trim();
	};
	const home = remote ? await exec("printf '%s' \"$HOME\"") : homedir();
	if (!home || /[\x00-\x1f\x7f]/.test(home)) throw new Error("Invalid native CLI session home directory");
	const join = remote ? path.posix.join : path.join;
	const directory = remote
		? join(home, ".pi-web", "native-cli", ref.key)
		: path.resolve(ctx.dataDir, "native-cli", ref.key);
	const eventsDirectory = join(directory, "events");
	if (!ctx.observeOnly && remote) {
		await exec(
			`umask 077; [ ! -L ${quote(directory)} ] && [ ! -L ${quote(eventsDirectory)} ] && mkdir -p ${quote(eventsDirectory)} && chmod 700 ${quote(directory)} ${quote(eventsDirectory)}`,
		);
	} else if (!ctx.observeOnly) {
		await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });
		for (const dir of [directory, eventsDirectory]) {
			if ((await lstat(dir)).isSymbolicLink()) throw new Error("Native CLI session directory must not be a symlink");
			await chmod(dir, 0o700);
		}
	}
	const exists = async (file: string): Promise<boolean> => {
		if (remote) return (await exec(`if [ -f ${quote(file)} ]; then printf yes; fi`)) === "yes";
		try {
			return (await lstat(file)).isFile();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	};
	const readEvents = async (): Promise<NativeCliHookEvent[]> => {
		let contents: string[];
		if (remote) {
			const output = await exec(
				`[ -d ${quote(eventsDirectory)} ] && [ -r ${quote(eventsDirectory)} ] && [ ! -L ${quote(directory)} ] && [ ! -L ${quote(eventsDirectory)} ] || exit 1; n=0; for f in ${quote(eventsDirectory)}/*.json; do [ -f "$f" ] || continue; n=$((n+1)); [ "$n" -le ${NATIVE_CLI_EVENT_LIMIT} ] || break; size=$(wc -c < "$f"); [ "$size" -le ${NATIVE_CLI_EVENT_BYTES} ] || continue; dd if="$f" bs=${NATIVE_CLI_EVENT_BYTES} count=1 2>/dev/null; printf '\\n'; done`,
			);
			contents = output.split("\n");
		} else {
			if (
				ctx.observeOnly &&
				((await lstat(directory)).isSymbolicLink() || (await lstat(eventsDirectory)).isSymbolicLink())
			)
				throw new Error("Native CLI observer directory must not be a symlink");
			const names = (await readdir(eventsDirectory))
				.filter((name) => EVENT_FILE.test(name))
				.sort()
				.slice(-NATIVE_CLI_EVENT_LIMIT);
			contents = await Promise.all(
				names.map(async (name) => {
					try {
						return await boundedRead(join(eventsDirectory, name), NATIVE_CLI_EVENT_BYTES);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
						throw error;
					}
				}),
			);
		}
		return contents
			.map(parseNativeCliHookEvent)
			.filter((event): event is NativeCliHookEvent => Boolean(event))
			.sort((a, b) => a.eventId.localeCompare(b.eventId));
	};
	const put = async (name: string, content: string): Promise<string> => {
		const file = join(directory, name);
		const temporary = file + "." + randomUUID() + ".tmp";
		if (remote)
			await exec(
				`umask 077; printf '%s' ${quote(content)} > ${quote(temporary)} && chmod 600 ${quote(temporary)} && mv -f ${quote(temporary)} ${quote(file)}`,
			);
		else {
			try {
				if ((await lstat(file)).isSymbolicLink()) throw new Error("Native CLI hook must not be a symlink");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
			await rename(temporary, file);
		}
		return file.replace(/\\/g, "/");
	};

	let oldEvents: NativeCliHookEvent[] = [];
	let observationFailed = false;
	try {
		oldEvents = await readEvents();
	} catch (error) {
		if (!ctx.observeOnly || ctx.signal?.aborted) throw error;
		observationFailed = true;
	}
	let durableId: string | undefined;
	const bindingFile = join(directory, "native-id");
	try {
		if (remote)
			durableId = await exec(
				`if [ ! -L ${quote(directory)} ] && [ ! -L ${quote(bindingFile)} ] && [ -f ${quote(bindingFile)} ]; then size=$(wc -c < ${quote(bindingFile)}); [ "$size" -gt 1024 ] || dd if=${quote(bindingFile)} bs=1024 count=1 2>/dev/null; fi`,
			);
		else if (!(await lstat(directory)).isSymbolicLink() && !(await lstat(bindingFile)).isSymbolicLink())
			durableId = await boundedRead(bindingFile, 1024);
	} catch (error) {
		if (ctx.signal?.aborted || (!ctx.observeOnly && (error as NodeJS.ErrnoException).code !== "ENOENT")) throw error;
	}
	if (durableId && /[\x00-\x1f\x7f]/.test(durableId)) durableId = undefined;
	const explicit =
		config.preset === "claude"
			? flag(optionArgs, ["--session-id", "--resume", "-r", "--continue", "-c"])
			: config.preset === "codex"
				? codexSubcommand(optionArgs) >= 0
				: config.preset === "pi"
					? flag(optionArgs, [
							"--session",
							"--session-id",
							"--continue",
							"-c",
							"--resume",
							"-r",
							"--fork",
							"--no-session",
						])
					: flag(optionArgs, ["--conversation", "--continue", "-c"]);
	const recoveredId =
		durableId ||
		[...oldEvents].reverse().find((event) => event.type === "session" && event.nativeId)?.nativeId ||
		[...oldEvents].reverse().find((event) => event.nativeId)?.nativeId;
	const launchOptions: string[] = [];
	let capabilities: NativeCliSessionCapabilities = { resume: "none", events: "process" };
	let observedId = ref.nativeId;
	let acceptsEvents = false;
	let confirmNativeId = async (_id: string): Promise<boolean> => true;
	const scriptDirectory = directory.replace(/\\/g, "/");
	const reporter = async () => `sh ${quote(await put("hook.sh", nativeCliPosixReporter(scriptDirectory)))}`;

	if (ctx.observeOnly) {
		if (durableId) ref.nativeId = durableId;
		observedId = ref.nativeId;
		capabilities = {
			resume:
				config.preset === "custom" ? "none" : config.preset === "agy" || !ref.nativeId ? "explicit-only" : "exact",
			events: observationFailed ? "process" : "hooks",
		};
		acceptsEvents = true;
	} else if (config.preset === "claude") {
		capabilities.resume = "exact";
		const explicitId = flagValue(optionArgs, ["--session-id", "--resume", "-r"]);
		if (explicit && (!explicitId || !UUID.test(explicitId))) capabilities.resume = "explicit-only";
		if (explicitId && UUID.test(explicitId)) observedId = explicitId;
		let id = !explicit ? (ref.nativeId ?? ref.key) : explicitId;
		if (id && !UUID.test(id)) throw new Error("Invalid bound Claude session ID");
		const claudeRecord = async (nativeId: string): Promise<boolean> => {
			const claudeHome = remote
				? await exec("printf '%s' \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"")
				: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
			const projects = join(claudeHome, "projects");
			if (remote)
				return (
					(await exec(
						`for f in ${quote(projects)}/*/${quote(nativeId + ".jsonl")}; do if [ -f "$f" ]; then printf yes; break; fi; done`,
					)) === "yes"
				);
			try {
				for (const project of await readdir(projects))
					if (await exists(join(projects, project, nativeId + ".jsonl"))) return true;
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		};
		confirmNativeId = claudeRecord;
		if (!explicit) {
			const candidate = durableId || (!ref.nativeId ? recoveredId : undefined);
			if (candidate && UUID.test(candidate) && (await claudeRecord(candidate))) id = candidate;
			const persisted = await claudeRecord(id!);
			if (ref.nativeId && !persisted)
				throw new Error("Bound Claude session no longer exists; create a new CLI conversation to start over");
			if (persisted) ref.nativeId = id;
			launchOptions.push(persisted ? "--resume" : "--session-id", id!);
		}
		// A second --settings flag would replace the user's explicit settings argument.
		if (!flag(optionArgs, ["--settings", "--disable-hooks", "--bare"])) {
			const command = await reporter();
			const hook = (type: string, matcher?: string) => [
				{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${command} ${type}`, timeout: 5 }] },
			];
			launchOptions.push(
				"--settings",
				JSON.stringify({
					hooks: {
						SessionStart: hook("session"),
						UserPromptSubmit: hook("submitted"),
						Stop: hook("done"),
						PermissionRequest: hook("approval"),
						Notification: hook("notification"),
						StopFailure: hook("error"),
					},
				}),
			);
			capabilities.events = "hooks";
			acceptsEvents = true;
		}
	} else if (config.preset === "pi") {
		capabilities.resume = explicit && !flagValue(optionArgs, ["--session", "--session-id"]) ? "explicit-only" : "exact";
		if (!explicit) {
			ref.storeDir ??= join(directory, "sessions");
			if (remote) await exec(`umask 077; mkdir -p ${quote(ref.storeDir)} && chmod 700 ${quote(ref.storeDir)}`);
			else {
				await mkdir(ref.storeDir, { recursive: true, mode: 0o700 });
				await chmod(ref.storeDir, 0o700);
			}
			let sessionPath = ref.nativeId ?? join(ref.storeDir, "session.jsonl");
			const candidate = durableId || (!ref.nativeId ? recoveredId : undefined);
			if (candidate && (await exists(candidate))) sessionPath = candidate;
			if (ref.nativeId && !(await exists(sessionPath)))
				throw new Error("Bound Pi session no longer exists; create a new CLI conversation to start over");
			if (await exists(sessionPath)) ref.nativeId = sessionPath;
			launchOptions.push("--session-dir", ref.storeDir, "--session", sessionPath);
		}
		if (!flag(optionArgs, ["--no-extensions", "-ne"])) {
			launchOptions.push("--extension", await put("pi-extension.mjs", nativeCliPiExtension(scriptDirectory)));
			capabilities.events = "hooks";
			acceptsEvents = true;
		}
	} else if (config.preset === "codex") {
		const conflicts = new Set<string>();
		const configFiles = [join(process.env.CODEX_HOME || join(home, ".codex"), "config.toml")];
		if (remote) {
			const found = await exec(
				`scan() { [ -f "$1" ] || return 0; for ev in ${EVENTS.join(" ")}; do if grep -q "$ev" "$1"; then printf '%s\\n' "$ev"; fi; done; }; scan "\${CODEX_HOME:-$HOME/.codex}/config.toml"; d=$PWD; n=0; while [ "$n" -lt 32 ]; do scan "$d/.codex/config.toml"; [ "$d" = / ] && break; d=\${d%/*}; [ -n "$d" ] || d=/; n=$((n+1)); done`,
			);
			for (const name of found.split("\n")) if (EVENTS.includes(name)) conflicts.add(name);
		} else {
			let current = path.resolve(ctx.cwd);
			for (let depth = 0; depth < 32; depth++) {
				configFiles.push(join(current, ".codex", "config.toml"));
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
			}
			for (const file of configFiles) {
				try {
					if ((await lstat(file)).size > 256 * 1024) {
						for (const event of EVENTS) conflicts.add(event);
						continue;
					}
					for (const event of nativeCliCodexHookConflicts(await boundedRead(file, 256 * 1024))) conflicts.add(event);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") for (const event of EVENTS) conflicts.add(event);
				}
			}
		}
		for (const event of nativeCliCodexHookConflicts(optionArgs.join("\n"))) conflicts.add(event);
		if (!explicit) {
			const candidate = durableId || (!ref.nativeId ? recoveredId : undefined);
			if (candidate && UUID.test(candidate)) {
				const codexHome = remote
					? await exec("printf '%s' \"${CODEX_HOME:-$HOME/.codex}\"")
					: process.env.CODEX_HOME || join(home, ".codex");
				const suffix = candidate.toLowerCase() + ".jsonl";
				let persisted = false;
				if (remote) {
					persisted =
						(await exec(
							`for f in ${quote(codexHome)}/sessions/*/*/*/rollout-*-${quote(suffix)} ${quote(codexHome)}/archived_sessions/rollout-*-${quote(suffix)}; do if [ -f "$f" ]; then printf yes; break; fi; done`,
						)) === "yes";
				} else {
					const patterns = [
						path.join(codexHome, "sessions", "*", "*", "*", "rollout-*-" + suffix),
						path.join(codexHome, "archived_sessions", "rollout-*-" + suffix),
					].map((pattern) => pattern.replace(/\\/g, "/"));
					for await (const file of glob(patterns)) {
						if (await exists(file)) {
							persisted = true;
							break;
						}
					}
				}
				if (persisted) ref.nativeId = candidate;
			}
		}
		const id = ref.nativeId;
		let explicitExact = false;
		if (explicit) {
			const index = codexSubcommand(optionArgs);
			if (index >= 0 && optionArgs[index] === "resume" && UUID.test(optionArgs[index + 1] ?? "")) {
				observedId = optionArgs[index + 1];
				explicitExact = true;
			}
		} else if (id) {
			if (!UUID.test(id)) throw new Error("Invalid bound Codex session ID");
			// Official resume handles an absent exact ID with an error, never --last.
			args.unshift("resume", id);
		}
		const command = await reporter();
		const mappings: Array<[string, string, string?]> = [
			["SessionStart", "session"],
			["UserPromptSubmit", "submitted"],
			["PermissionRequest", "approval"],
			["Stop", "done"],
			["PreToolUse", "question", "request_user_input"],
			["PostToolUse", "working", "request_user_input"],
		];
		for (const [event, type, matcher] of mappings) {
			if (conflicts.has(event)) continue;
			const groups = [
				{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `${command} ${type}`, timeout: 5 }] },
			];
			const toml = groups
				.map(
					(group) =>
						`{ ${matcher ? `matcher = ${JSON.stringify(matcher)}, ` : ""}hooks = [{ type = "command", command = ${JSON.stringify(group.hooks[0].command)}, timeout = 5 }] }`,
				)
				.join(", ");
			launchOptions.push("--config", `hooks.${event}=[${toml}]`);
			acceptsEvents = true;
		}
		capabilities = {
			resume:
				explicit && !explicitExact
					? "explicit-only"
					: !conflicts.has("SessionStart") || Boolean(id)
						? "exact"
						: "explicit-only",
			events: !conflicts.has("UserPromptSubmit") && !conflicts.has("Stop") ? "hooks" : "process",
		};
	} else if (config.preset === "agy") {
		capabilities.resume = "explicit-only";
		if (!explicit && ref.nativeId) launchOptions.push("--conversation", ref.nativeId);
	}

	if (!explicit) observedId = ref.nativeId;
	ctx.signal?.throwIfAborted();
	let stopped = true;
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<void> | undefined;
	let generation = 0;
	const lastIndex = ctx.lastEventId
		? oldEvents.findIndex(
				(event) => event.eventId === ctx.lastEventId || event.eventId + ":session" === ctx.lastEventId,
			)
		: -1;
	const historicalCutoff = ctx.lastEventId
		? lastIndex < 0
			? 0
			: lastIndex + (ctx.lastEventId.endsWith(":session") && oldEvents[lastIndex].type !== "session" ? 0 : 1)
		: oldEvents.length;
	const seen = new Set(oldEvents.slice(0, historicalCutoff).map((event) => event.eventId));
	if (!ctx.observeOnly) {
		for (const event of oldEvents) {
			if (["working", "question", "approval"].includes(event.type) || (event.type === "session" && ref.nativeId))
				seen.add(event.eventId);
		}
	}
	const emit = (event: NativeCliSessionEvent) => {
		if (stopped || disposed || ctx.signal?.aborted) return;
		try {
			ctx.onEvent(event);
		} catch {}
	};
	const stop = () => {
		stopped = true;
		generation++;
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	const poll = async (run: number) => {
		if (stopped || disposed || ctx.signal?.aborted || generation !== run) return;
		try {
			const events = await readEvents();
			if (stopped || disposed || ctx.signal?.aborted || generation !== run) return;
			for (const event of events) {
				if (seen.has(event.eventId)) continue;
				// Child agents can inherit hooks. Only an official root SessionStart may switch identity.
				if (event.nativeId && observedId && event.nativeId !== observedId && event.type !== "session") {
					seen.add(event.eventId);
					continue;
				}
				if (
					event.nativeId &&
					event.nativeId !== ref.nativeId &&
					(config.preset === "pi" || UUID.test(event.nativeId)) &&
					(await confirmNativeId(event.nativeId))
				) {
					if (stopped || disposed || ctx.signal?.aborted || generation !== run) return;
					observedId = event.nativeId;
					ref.nativeId = event.nativeId;
					emit({
						type: "session",
						nativeId: event.nativeId,
						eventId: event.eventId + ":session",
						...(event.type === "session" ? { cursor: event.eventId } : {}),
					});
				}
				if (stopped || disposed || ctx.signal?.aborted || generation !== run) return;
				if (event.type === "error")
					emit({
						type: "error",
						code: "cli_error",
						message: "Native CLI reported a failed turn",
						eventId: event.eventId,
					});
				else if (event.type === "done")
					emit({ type: "done", eventId: event.eventId, ...(event.aborted ? { aborted: true } : {}) });
				else if (event.type !== "session") emit({ type: event.type, eventId: event.eventId });
				if (stopped || disposed || ctx.signal?.aborted || generation !== run) return;
				seen.add(event.eventId);
			}
			if (seen.size > NATIVE_CLI_EVENT_LIMIT * 4) {
				seen.clear();
				for (const event of events) seen.add(event.eventId);
			}
		} catch {
			if (!stopped && !disposed && !ctx.signal?.aborted && generation === run)
				emit({
					type: "error",
					eventId: nativeCliEventId(`${ref.key}:observer`),
					code: "event_observer",
					message: "Native CLI lifecycle event observation failed",
				});
		} finally {
			if (!stopped && !disposed && !ctx.signal?.aborted && generation === run) {
				timer = setTimeout(
					() => {
						queuePoll(run);
					},
					remote ? 1500 : 350,
				);
				timer.unref();
			}
		}
	};
	const queuePoll = (run: number): Promise<void> => {
		pending = (pending ?? Promise.resolve()).then(() => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			return poll(run);
		});
		return pending;
	};
	ctx.signal?.addEventListener("abort", stop, { once: true });
	return {
		config: ctx.observeOnly ? config : { ...config, args: addOptions(args, launchOptions) },
		ref,
		capabilities,
		start() {
			if (disposed || ctx.signal?.aborted || !acceptsEvents) return () => {};
			stop();
			stopped = false;
			const run = generation;
			queuePoll(run);
			return () => {
				if (generation === run) stop();
			};
		},
		async flush() {
			if (stopped || disposed || ctx.signal?.aborted || !acceptsEvents) return;
			await queuePoll(generation);
		},
		async dispose() {
			disposed = true;
			stop();
			ctx.signal?.removeEventListener("abort", stop);
			await pending;
		},
	};
}
