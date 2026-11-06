import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
import { ENGINE_CATALOG, type NativeCliEngineId } from "./engine-catalog.js";
import { probeGlobalPackage } from "./global-loader.js";
import { findNativeCliExecutable, type NativeCliDiscoveryOptions } from "./native-cli-discovery.js";

export interface CliLaunch {
	file: string;
	args: string[];
}
export interface EngineCliLaunchOptions extends Omit<NativeCliDiscoveryOptions, "autoDetect"> {
	executablePath?: string;
	args?: readonly string[];
	refresh?: boolean;
}

function unwrapExecutable(file: string, args: readonly string[], options: NativeCliDiscoveryOptions): CliLaunch {
	const windows = (options.platform ?? process.platform) === "win32";
	if (!windows) {
		const script = realpathSync(file);
		if (/\.[cm]?js$/i.test(script)) {
			const node = findNativeCliExecutable(posix.join(posix.dirname(file), "node"), options);
			return { file: node ?? options.nodeExecutable ?? process.execPath, args: [script, ...args] };
		}
		return { file, args: [...args] };
	}
	const extension = win32.extname(file).toLowerCase();
	if (extension === ".exe" || extension === ".com") return { file, args: [...args] };
	if (/^\.[cm]?js$/.test(extension)) return { file: options.nodeExecutable ?? process.execPath, args: [file, ...args] };
	if (extension !== ".cmd") throw new Error("CLI requires an executable or an npm .cmd shim on Windows");
	if (statSync(file).size > 64 * 1024) throw new Error("CLI npm shim is too large");
	const shim = readFileSync(file, "utf8");
	const nodeTarget =
		/^\s*(?:endLocal\s*&\s*goto\s+#_undefined_#\s+2>NUL\s*\|\|\s*title\s+%COMSPEC%\s*&\s*)?(?:"%_prog%"|"%dp0%[\\/]node\.exe"|node(?:\.exe)?)\s+"%dp0%[\\/]([^"\r\n]+)"\s+%\*\s*$/im.exec(
			shim,
		)?.[1];
	const nativeTarget = /^\s*"%dp0%[\\/]([^"\r\n]+\.(?:exe|com))"\s+%\*\s*$/im.exec(shim)?.[1];
	const target = nodeTarget ?? nativeTarget;
	if (!target || (nodeTarget && !/\.(?:[cm]?js)$/i.test(nodeTarget)) || /[%\x00-\x1f]/.test(target))
		throw new Error("Unsupported CLI .cmd shim; configure its executable directly");
	const entryPoint = win32.resolve(win32.dirname(file), target);
	if (!statSync(entryPoint).isFile()) throw new Error("CLI npm entry point is not a file");
	if (!nodeTarget) return { file: entryPoint, args: [...args] };
	const localNode = win32.join(win32.dirname(file), "node.exe");
	return {
		file: existsSync(localNode) ? localNode : (options.nodeExecutable ?? process.execPath),
		args: [entryPoint, ...args],
	};
}

export function resolveCliExecutableLaunch(
	executable: string,
	args: readonly string[] = [],
	options: NativeCliDiscoveryOptions = {},
): CliLaunch {
	if ((options.platform ?? process.platform) !== "win32" && !options.autoDetect)
		return { file: executable, args: [...args] };
	const file = findNativeCliExecutable(executable, options);
	if (!file) throw new Error(`CLI executable not found: ${executable}`);
	return unwrapExecutable(file, args, options);
}

/** PATH/native installs first, then the same global package resolver used by engine detection. */
export function resolveEngineCliLaunch(id: NativeCliEngineId, options: EngineCliLaunchOptions = {}): CliLaunch {
	const meta = ENGINE_CATALOG[id];
	if (!meta.cliCommand) throw new Error(`${meta.name} has no standalone CLI`);
	const args = options.args ?? [];
	if (options.executablePath)
		return resolveCliExecutableLaunch(options.executablePath, args, { ...options, autoDetect: false });
	const file = findNativeCliExecutable(meta.cliCommand, { ...options, autoDetect: true });
	if (file) return unwrapExecutable(file, args, options);

	const pkg = meta.packageName ? probeGlobalPackage(meta.packageName, { refresh: options.refresh }) : undefined;
	if (pkg?.packagePath) {
		try {
			const manifest = JSON.parse(readFileSync(resolve(pkg.packagePath, "package.json"), "utf8")) as {
				bin?: string | Record<string, string>;
			};
			const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[meta.cliCommand];
			if (typeof bin === "string") {
				const entry = resolve(pkg.packagePath, bin);
				if (statSync(entry).isFile()) return unwrapExecutable(entry, args, options);
			}
		} catch {}
	}
	throw new Error(
		`${meta.name} CLI executable not found. Install it on the machine running pi-web-ui (${meta.installCommand}) or select Custom and configure its executable path.`,
	);
}

export async function probeEngineCliVersion(
	id: NativeCliEngineId,
	executablePath?: string,
): Promise<{ available: boolean; version?: string; error?: string }> {
	try {
		const launch = resolveEngineCliLaunch(id, { executablePath, args: ["--version"] });
		return await new Promise((done) => {
			execFile(launch.file, launch.args, { timeout: 4000, windowsHide: true, maxBuffer: 8192 }, (error, stdout) => {
				done(
					error ? { available: false, error: error.message } : { available: true, version: stdout.trim() || undefined },
				);
			});
		});
	} catch (error) {
		return { available: false, error: error instanceof Error ? error.message : String(error) };
	}
}
