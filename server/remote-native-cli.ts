import { randomBytes } from "node:crypto";
import { ENGINE_CATALOG, type NativeCliEngineId } from "./engine-catalog.js";
import { nativeCliLaunchArgs, validateNativeCliConfig } from "./native-cli.js";
import { nativeCliModelLaunch, type NativeCliModelConnection } from "./native-cli-model.js";
import type { NativeCliConfig } from "./protocol.js";
import { shellQuotePosix, type RemoteSshService } from "./remote-ssh-service.js";

export interface RemoteNativeCliAvailability {
	preset: NativeCliEngineId;
	available: boolean;
	executable?: string;
	error?: string;
}

type RemoteExec = Pick<RemoteSshService, "execInWorkspace">;
const standalone = Object.values(ENGINE_CATALOG).filter((engine) => engine.cliCommand !== null);

async function inspectRemoteExecutables(
	service: RemoteExec,
	uri: string,
	requested: string[],
	signal?: AbortSignal,
): Promise<{ path: string; executables: string[] }> {
	const marker = `PI_WEB_DISCOVERY_${randomBytes(24).toString("hex")}`;
	for (const file of requested) {
		if (!file || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file) || /^(?:[A-Za-z]:|\\\\)/.test(file))
			throw new Error("Remote CLI requires a POSIX executable path or command name");
	}
	const script = [
		"set +x",
		'case "$(uname -s)" in Linux|Darwin|FreeBSD|OpenBSD|NetBSD|DragonFly|SunOS|AIX) ;; *) printf "%s\\n" "Remote CLI supports POSIX hosts only; Windows is unsupported" >&2; exit 125;; esac',
		"PATH=${PATH:-/usr/bin:/bin}",
		'for dir in "$HOME/.local/bin" "$HOME/bin" "$HOME/.claude/local" "$HOME/.agy/bin" "$HOME/.antigravity/bin" "${npm_config_prefix:-${NPM_CONFIG_PREFIX:-$HOME/.npm-global}}/bin" "$HOME/.npm-global/bin" "$HOME/.npm/bin" "$HOME/.npm-packages/bin" "${PNPM_HOME:-$HOME/.local/share/pnpm}" "$HOME/Library/pnpm" "$HOME/.pnpm" "$HOME/.pnpm-global/bin" "${NVM_BIN:-$HOME/.nvm/current/bin}" "${FNM_MULTISHELL_PATH:-$HOME/.fnm/current}/bin" "${VOLTA_HOME:-$HOME/.volta}/bin" "$HOME/.yarn/bin" "${FNM_DIR:-$HOME/.fnm}/current/bin" "${FNM_DIR:-$HOME/.fnm}"/node-versions/*/installation/bin "${XDG_DATA_HOME:-$HOME/.local/share}/fnm"/node-versions/*/installation/bin "$HOME/Library/Application Support/fnm"/node-versions/*/installation/bin "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin /usr/local/bin /opt/homebrew/bin /usr/bin /bin; do',
		'  if [ -d "$dir" ]; then PATH="$PATH:$dir"; fi',
		"done",
		"export PATH",
		`printf '%s\\000%s\\000' ${shellQuotePosix(marker)} "$PATH"`,
		...requested.flatMap((file) => [
			`candidate=${shellQuotePosix(file)}`,
			'case "$candidate" in "~") candidate=$HOME;; "~/"*) candidate="$HOME/${candidate#??}";; esac',
			'case "$candidate" in */*) ;; *) candidate=$(command -v "$candidate" 2>/dev/null) || candidate=;; esac',
			'case "$candidate" in /*) if [ ! -f "$candidate" ] || [ ! -x "$candidate" ]; then candidate=; fi;; *) candidate=;; esac',
			'printf "%s\\000" "$candidate"',
		]),
	].join("\n");
	const result = await service.execInWorkspace(uri, `/bin/sh -c ${shellQuotePosix(script)}`, {
		cwd: "/",
		timeoutMs: 25_000,
		signal,
	});
	if (result.exitCode !== 0) {
		if (result.exitCode === 125) throw new Error("Remote CLI supports POSIX hosts only; Windows is unsupported");
		throw new Error("Remote CLI discovery failed; a POSIX /bin/sh host is required (Windows is unsupported)");
	}
	const start = result.stdout.indexOf(`${marker}\0`);
	const fields = start < 0 ? [] : result.stdout.slice(start).split("\0");
	if (
		fields.length !== requested.length + 3 ||
		fields[0] !== marker ||
		!fields[1] ||
		fields[1].length > 32768 ||
		/[\x00-\x1f\x7f]/.test(fields[1])
	)
		throw new Error("Invalid remote CLI discovery response");
	const executables = fields.slice(2, -1);
	if (executables.some((file) => file && (!file.startsWith("/") || /[\x00-\x1f\x7f]/.test(file))))
		throw new Error("Invalid remote CLI executable response");
	return { path: fields[1], executables };
}

export async function discoverRemoteNativeClis(
	service: RemoteExec,
	uri: string,
	signal?: AbortSignal,
): Promise<RemoteNativeCliAvailability[]> {
	const inspected = await inspectRemoteExecutables(
		service,
		uri,
		standalone.map((engine) => engine.cliCommand!),
		signal,
	);
	return standalone.map((engine, index) => ({
		preset: engine.id,
		available: Boolean(inspected.executables[index]),
		...(inspected.executables[index]
			? { executable: inspected.executables[index] }
			: { error: `${engine.cliCommand} was not found in the remote PATH or common installation directories` }),
	}));
}

export async function resolveRemoteNativeCliLaunch(
	service: RemoteExec,
	value: NativeCliConfig,
	uri: string,
	connection?: NativeCliModelConnection,
	signal?: AbortSignal,
): Promise<{ file: string; args: string[]; env?: NodeJS.ProcessEnv; unsetEnv?: string[] }> {
	const config = validateNativeCliConfig(value);
	const requested = config.executable ?? (config.preset === "custom" ? "" : ENGINE_CATALOG[config.preset].cliCommand!);
	const inspected = await inspectRemoteExecutables(service, uri, [requested], signal);
	const file = inspected.executables[0];
	if (!file) throw new Error(`Remote CLI executable is unavailable: ${requested}`);
	const launchPath = `${file.slice(0, file.lastIndexOf("/")) || "/"}:${inspected.path}`;
	const model = nativeCliModelLaunch(config, connection, { PATH: launchPath });
	return {
		file,
		args: [...model.args, ...nativeCliLaunchArgs(config)],
		env: model.env ?? { PATH: launchPath },
		...(model.unsetEnv?.length ? { unsetEnv: model.unsetEnv } : {}),
	};
}
