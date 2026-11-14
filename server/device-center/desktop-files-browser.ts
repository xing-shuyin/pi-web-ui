/** Browser-only controllers see only files/folders explicitly chosen by their user. */
export function desktopBrowserFiles(crc: (data: Uint8Array, previous?: number) => number) {
	const win = Reflect.get(globalThis, "window") as any,
		doc = win.document;
	let handle: any,
		virtual = new Map<string, any>(),
		generation = 0;
	const exports = new Map<string, any>(),
		jobs = new Map<string, any>();
	const uuid = () => String(++generation);
	const parts = (path: string) => {
		const result = path.replace(/^\//, "").split("/").filter(Boolean);
		if (result.some((p) => p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p))) throw new Error("Invalid file path");
		return result;
	};
	const busy = () => {
		if (exports.size || jobs.size) throw new Error("Finish or cancel transfers before choosing another local folder");
	};
	const encode = (bytes: Uint8Array) => {
		let s = "";
		for (let i = 0; i < bytes.length; i += 16384) s += String.fromCharCode(...bytes.subarray(i, i + 16384));
		return win.btoa(s);
	};
	async function directory(path: string) {
		if (!handle) throw new Error("Choose a local folder first");
		let current = handle;
		for (const name of parts(path)) current = await current.getDirectoryHandle(name);
		return current;
	}
	async function entries(path: string) {
		const result: any[] = [];
		if (handle) {
			for await (const [name, h] of (await directory(path)).entries()) {
				const f = h.kind === "file" ? await h.getFile() : null;
				result.push({
					name,
					path: (path === "/" ? "" : path) + "/" + name,
					directory: h.kind === "directory",
					size: f?.size || 0,
					modified: f?.lastModified,
				});
				if (result.length > 10000) throw new Error("Folder exceeds 10000 entries");
			}
		} else {
			const prefix = path === "/" ? "" : path;
			for (const [key, item] of virtual)
				if (key.slice(0, key.lastIndexOf("/")) === prefix)
					result.push({
						name: key.slice(key.lastIndexOf("/") + 1),
						path: key,
						directory: !item.file,
						size: item.file?.size || 0,
						modified: item.file?.lastModified,
					});
		}
		return result;
	}
	async function file(path: string) {
		if (!handle) {
			const f = virtual.get(path)?.file;
			if (!f) throw new Error("File is no longer selected");
			return f;
		}
		const p = parts(path),
			name = p.pop();
		return (await (await directory("/" + p.join("/"))).getFileHandle(name)).getFile();
	}
	const request = async (path: string, method = "GET", body?: any): Promise<any> => {
		const url = new URL(path, "https://files.invalid/"),
			route = url.pathname.slice(1),
			segments = route.split("/");
		if (route === "info")
			return {
				device: handle?.name || "Browser / 浏览器",
				home: "/",
				roots: [{ name: handle?.name || "Selected files / 已选择的文件", path: "/" }],
			};
		if (route === "list") {
			const path = url.searchParams.get("path") || "/";
			return { path, parent: "/" + parts(path).slice(0, -1).join("/"), entries: await entries(path) };
		}
		if (route === "mkdir") {
			const name = parts(body.name);
			if (name.length !== 1) throw new Error("Invalid folder name");
			await (await directory(body.path)).getDirectoryHandle(name[0], { create: true });
			return {};
		}
		if (route === "exports") {
			const result: any[] = [];
			let total = 0;
			async function visit(path: string, relative: string) {
				const item = handle ? null : virtual.get(path);
				let isDirectory = !!item && !item.file;
				if (handle) {
					const p = parts(path),
						name = p.pop();
					try {
						await (await directory("/" + p.join("/"))).getDirectoryHandle(name);
						isDirectory = true;
					} catch {
						isDirectory = false;
					}
				}
				const f = isDirectory ? null : await file(path);
				result.push({
					path: relative,
					source: path,
					directory: isDirectory,
					size: f?.size || 0,
					modified: f?.lastModified,
				});
				total += f?.size || 0;
				if (result.length > 10000 || total > 16 * 1024 ** 3)
					throw new Error("Transfer exceeds 10000 entries or 16 GiB");
				if (isDirectory) for (const item of await entries(path)) await visit(item.path, relative + "/" + item.name);
			}
			for (const path of body.paths) await visit(path, parts(path).at(-1)!);
			const id = uuid();
			exports.set(id, result);
			return { id, total, entries: result.map(({ path, size, directory }) => ({ path, size, directory })) };
		}
		if (segments[0] === "exports") {
			const selected = exports.get(segments[1]);
			if (method === "DELETE") {
				exports.delete(segments[1]);
				return null;
			}
			if (!selected) throw new Error("Source selection expired");
			const entry = selected[Number(url.searchParams.get("entry"))],
				offset = Number(url.searchParams.get("offset"));
			if (!entry || entry.directory || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.size)
				throw new Error("Invalid file offset");
			const f = await file(entry.source);
			if (f.size !== entry.size || f.lastModified !== entry.modified)
				throw new Error("Source file changed; select again");
			const bytes = new Uint8Array(await f.slice(offset, offset + 1024 ** 2).arrayBuffer());
			return { data: encode(bytes), length: bytes.length, crc: crc(bytes) };
		}
		if (route === "jobs") {
			const existing = [...jobs.values()].find((j) => j.key === body.key);
			if (existing) return existing.snapshot();
			const parent = await directory(body.destination),
				manifest = body.entries,
				ids = new Map<string, any>(),
				names = new Set<string>();
			for (const entry of manifest) {
				const p = parts(entry.path);
				if (
					!p.length ||
					p.join("/") !== entry.path ||
					names.has(entry.path.toLowerCase()) ||
					!Number.isSafeInteger(entry.size) ||
					entry.size < 0
				)
					throw new Error("Invalid file list");
				names.add(entry.path.toLowerCase());
			}
			async function reserve(parent: any, name: string, isDirectory: boolean) {
				const dot = isDirectory ? -1 : name.lastIndexOf(".");
				for (let i = 0; i < 10000; i++) {
					const candidate = i
						? dot > 0
							? name.slice(0, dot) + ` (${i + 1})` + name.slice(dot)
							: name + ` (${i + 1})`
						: name;
					let exists = false;
					for await (const [n] of parent.entries())
						if (n.toLowerCase() === candidate.toLowerCase()) {
							exists = true;
							break;
						}
					if (exists) continue;
					return {
						handle: await (isDirectory
							? parent.getDirectoryHandle(candidate, { create: true })
							: parent.getFileHandle(candidate, { create: true })),
						name: candidate,
					};
				}
				throw new Error("Too many duplicate names");
			}
			const roots = new Map<string, boolean>();
			for (const entry of manifest) {
				const p = parts(entry.path);
				roots.set(p[0], p.length > 1 || entry.directory || roots.get(p[0]) === true);
			}
			for (const [name, d] of roots) {
				const reserved = await reserve(parent, name, d);
				ids.set(name, reserved.handle);
			}
			for (const entry of [...manifest].sort((a, b) => parts(a.path).length - parts(b.path).length)) {
				const p = parts(entry.path);
				let current = ids.get(p[0]);
				for (let i = 1; i < p.length; i++) {
					const key = p.slice(0, i + 1).join("/");
					if (!ids.has(key))
						ids.set(
							key,
							await (i < p.length - 1 || entry.directory
								? current.getDirectoryHandle(p[i], { create: true })
								: current.getFileHandle(p[i], { create: true })),
						);
					current = ids.get(key);
				}
			}
			const id = uuid(),
				job: any = {
					id,
					key: body.key,
					entries: manifest.map(() => ({ offset: 0, crc: 0 })),
					manifest,
					handles: ids,
					writers: new Map(),
					complete: false,
					destination: body.destination,
				};
			job.snapshot = () => ({
				id,
				entries: job.entries.map(({ offset, crc }: any) => ({ offset, crc })),
				complete: job.complete,
				destination: job.destination,
			});
			jobs.set(id, job);
			return job.snapshot();
		}
		if (segments[0] === "jobs") {
			const job = jobs.get(segments[1]);
			if (!job) throw new Error("Transfer expired");
			if (method === "DELETE") {
				for (const writer of job.writers.values()) await writer.abort().catch(() => {});
				jobs.delete(job.id);
				return null;
			}
			if (segments[2] === "finish") {
				if (job.entries.some((e: any, i: number) => e.offset !== job.manifest[i].size || e.crc !== body.checksums[i]))
					throw new Error("File checksum mismatch");
				for (const writer of job.writers.values()) await writer.close();
				job.writers.clear();
				job.complete = true;
				return job.snapshot();
			}
			const i = Number(url.searchParams.get("entry")),
				offset = Number(url.searchParams.get("offset")),
				state = job.entries[i],
				entry = job.manifest[i],
				bytes = Uint8Array.from(win.atob(body.data), (c: any) => c.charCodeAt(0));
			if (crc(bytes) !== Number(url.searchParams.get("crc"))) throw new Error("File checksum mismatch");
			if (state?.last === offset && state.lastCrc === crc(bytes) && state.lastSize === bytes.length)
				return { offset: state.offset, crc: state.crc };
			if (!state || state.offset !== offset || offset + bytes.length > entry.size)
				throw new Error("Invalid file offset");
			let writer = job.writers.get(i);
			if (!writer) {
				writer = await job.handles.get(entry.path).createWritable();
				job.writers.set(i, writer);
			}
			await writer.write({ type: "write", position: offset, data: bytes });
			if (offset + bytes.length === entry.size) {
				await writer.close();
				job.writers.delete(i);
			}
			state.offset += bytes.length;
			state.crc = crc(bytes, state.crc);
			state.last = offset;
			state.lastCrc = crc(bytes);
			state.lastSize = bytes.length;
			return { offset: state.offset, crc: state.crc };
		}
		throw new Error("Unsupported file operation");
	};
	return {
		request,
		get writable() {
			return !!handle;
		},
		canChoose: typeof win.showDirectoryPicker === "function",
		async choose() {
			busy();
			handle = await win.showDirectoryPicker({ mode: "readwrite" });
			virtual.clear();
		},
		pick(folder: boolean, done: () => void) {
			try {
				busy();
			} catch (error: any) {
				win.alert(error.message);
				return;
			}
			const input = doc.createElement("input");
			input.type = "file";
			input.multiple = true;
			if (folder) input.setAttribute("webkitdirectory", "");
			input.onchange = () => {
				handle = undefined;
				virtual = new Map();
				for (const f of input.files) {
					const path = "/" + (f.webkitRelativePath || f.name),
						p = parts(path);
					for (let i = 1; i < p.length; i++) virtual.set("/" + p.slice(0, i).join("/"), {});
					virtual.set(path, { file: f });
				}
				done();
			};
			input.click();
		},
		close() {
			for (const job of jobs.values()) for (const writer of job.writers.values()) void writer.abort().catch(() => {});
			jobs.clear();
			exports.clear();
		},
	};
}
