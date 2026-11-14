import { constants } from "node:fs";
import { access, copyFile, link, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Filesystem paths belong to the authenticated machine, never to the relay. */
export function desktopFilePaths(home: string, restricted: boolean) {
	const within = (root: string, path: string) => {
		const rest = relative(root, path);
		return !rest || (!rest.startsWith(".." + sep) && rest !== ".." && !isAbsolute(rest));
	};
	async function source(value: unknown = "") {
		if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f]/.test(value) || /^\\\\|^\/\//.test(value))
			throw new Error("Invalid path");
		if (value.split(/[\\/]/).includes("..")) throw new Error("Parent traversal is not allowed");
		const target = resolve(home, value || "."),
			root = restricted ? await realpath(home) : parse(target).root;
		if (!within(root, target)) throw new Error("Path is outside the allowed folder");
		let current = root;
		for (const part of relative(root, target).split(sep).filter(Boolean)) {
			if (process.platform === "win32" && (part.includes(":") || /[. ]$/.test(part))) throw new Error("Invalid path");
			current = join(current, part);
			if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links and junctions are not supported");
			if (!within(root, await realpath(current))) throw new Error("Path changed");
		}
		return realpath(current);
	}
	async function roots() {
		const result = [{ name: "Home", path: await realpath(home) }];
		const candidates = restricted
			? []
			: process.platform === "win32"
				? Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i) + ":\\")
				: ["/"];
		for (const path of candidates)
			try {
				await access(path);
				result.push({ name: path, path });
			} catch {}
		for (const name of ["Desktop", "Documents", "Downloads"])
			try {
				result.push({ name, path: await source(join(home, name)) });
			} catch {}
		return result;
	}
	return { source, roots, parent: (path: string) => (restricted && path === home ? home : dirname(path)) };
}

export type PublishedFile = { path: string; ino: number; dev: number; directory: boolean };
/** Exclusive creation keeps existing files intact; records make a partial publication retryable. */
export async function publishDesktopFiles(root: string, destination: string, published: Map<string, PublishedFile>) {
	async function visit(source: string, parent: string, relativePath: string, renameOnConflict: boolean) {
		const info = await lstat(source);
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Source path changed");
		let saved = published.get(relativePath);
		if (saved) {
			const current = await lstat(saved.path);
			if (current.isSymbolicLink() || current.ino !== saved.ino || current.dev !== saved.dev)
				throw new Error("Destination changed during transfer");
		} else {
			const name = basename(source),
				extension = info.isDirectory() ? "" : extname(name);
			for (let n = 0; n < 10000; n++) {
				const path = join(parent, n ? name.slice(0, name.length - extension.length) + ` (${n + 1})` + extension : name);
				try {
					if (info.isDirectory()) await mkdir(path);
					else
						try {
							await link(source, path);
						} catch (error: any) {
							if (!["ENOTSUP", "EPERM", "EXDEV", "ENOSYS"].includes(error.code)) throw error;
							await copyFile(source, path, constants.COPYFILE_EXCL);
						}
					const created = await lstat(path);
					saved = { path, ino: created.ino, dev: created.dev, directory: info.isDirectory() };
					published.set(relativePath, saved);
					break;
				} catch (error: any) {
					if (error.code !== "EEXIST" || !renameOnConflict) throw error;
				}
			}
			if (!saved) throw new Error("Too many same-name files");
		}
		if (info.isDirectory())
			for (const name of await readdir(source))
				await visit(join(source, name), saved.path, relativePath + "/" + name, false);
	}
	for (const name of await readdir(root)) await visit(join(root, name), destination, name, true);
	return [...published.entries()].filter(([path]) => !path.includes("/")).map(([, entry]) => entry.path);
}
