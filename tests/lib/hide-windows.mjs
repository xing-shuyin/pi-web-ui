import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const installed = Symbol.for("pi-web-ui.tests.hide-windows");

export function hiddenWindowArgs(name, args) {
	const result = [...args];
	const index = name === "exec" || name === "execSync" ? 1 : Array.isArray(result[1]) ? 2 : 1;
	const options = result[index];
	if (options && typeof options === "object") {
		result[index] = { windowsHide: true, ...options };
	} else {
		result.splice(index, options == null ? 1 : 0, { windowsHide: true });
	}
	return result;
}

if (process.platform === "win32" && !childProcess[installed]) {
	Object.defineProperty(childProcess, installed, { value: true });
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
		const original = childProcess[name];
		const wrapped = function (...args) {
			return Reflect.apply(original, this, hiddenWindowArgs(name, args));
		};
		if (original[promisify.custom]) {
			wrapped[promisify.custom] = function (...args) {
				return Reflect.apply(original[promisify.custom], this, hiddenWindowArgs(name, args));
			};
		}
		childProcess[name] = wrapped;
	}
	syncBuiltinESMExports();
	const preload = `--import=${JSON.stringify(import.meta.url)}`;
	if (!process.env.NODE_OPTIONS?.includes(preload)) {
		process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
	}
}
