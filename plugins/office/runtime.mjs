import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function documentKey(absPath) {
	return createHash("sha256").update(absPath).digest("hex");
}

export function resolvePreviewPath(inputPath, cwd) {
	return fs.realpathSync(path.resolve(cwd, inputPath));
}

export function fileVersion(filePath) {
	try {
		const { dev, ino, size, mtimeMs, ctimeMs } = fs.statSync(filePath);
		return { dev, ino, size, mtimeMs, ctimeMs };
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function workspaceError() {
	return Object.assign(new Error("路径超出工作区 (outside workspace)"), { statusCode: 403 });
}

function contained(candidate, root) {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function safeWorkspacePath(absPath, cwd) {
	if (!path.isAbsolute(absPath) || !path.isAbsolute(cwd)) throw new TypeError("Absolute paths required");
	const absolute = path.resolve(absPath);
	if (!contained(absolute, path.resolve(cwd))) throw workspaceError();
	const root = fs.realpathSync(cwd);
	let ancestor = absolute;
	const suffix = [];
	for (;;) {
		try {
			const resolved = fs.realpathSync(ancestor);
			if (!contained(resolved, root)) throw workspaceError();
			return path.join(resolved, ...suffix);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			try {
				fs.lstatSync(ancestor);
				throw new Error("Cannot resolve existing workspace path");
			} catch (statError) {
				if (statError.code !== "ENOENT") throw statError;
			}
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.unshift(path.basename(ancestor));
			ancestor = parent;
		}
	}
}

function conflict() {
	return Object.assign(new Error("Document changed or destination already exists"), { statusCode: 409 });
}

function sameVersion(actual, expected) {
	return (
		actual !== null &&
		expected != null &&
		["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => actual[key] === expected[key])
	);
}

/**
 * Synchronous optimistic save. Existing destinations require overwrite + an exact version.
 * New destinations use an exclusive hard-link commit; rename is reserved for replacement.
 * Returns the committed stat identity. Parent directories must already exist.
 * @param {string} outPath
 * @param {Buffer} buffer
 * Canonical parent paths are rechecked before commit; this is not an OS-level directory lock.
 * @param {{expectedVersion?: ReturnType<typeof fileVersion>, overwrite?: boolean, maxBytes?: number, expectedParentRealpath?: string}} [options]
 */
export function writeDocumentAtomic(
	outPath,
	buffer,
	{ expectedVersion, overwrite = false, maxBytes = 64 * 1024 * 1024, expectedParentRealpath } = {},
) {
	if (!Buffer.isBuffer(buffer)) throw new TypeError("Document must be a Buffer");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid document size limit");
	if (buffer.length > maxBytes) throw Object.assign(new Error("Document exceeds size limit"), { statusCode: 413 });
	const requestedParent = path.dirname(path.resolve(outPath));
	const parent = fs.realpathSync(requestedParent);
	if (expectedParentRealpath !== undefined && path.relative(parent, expectedParentRealpath) !== "") throw conflict();
	outPath = path.join(parent, path.basename(outPath));
	const initial = fileVersion(outPath);
	if (initial ? !overwrite || !sameVersion(initial, expectedVersion) : expectedVersion != null) throw conflict();
	const metadata = initial ? fs.statSync(outPath) : null;
	if (initial && !sameVersion(metadata, initial)) throw conflict();
	const mode = metadata ? metadata.mode & 0o7777 : 0o600;
	const tempPath = path.join(path.dirname(outPath), `.office-${randomUUID()}.tmp`);
	let fd;
	let ownsTemp = false;
	try {
		fd = fs.openSync(tempPath, "wx", mode);
		ownsTemp = true;
		fs.writeFileSync(fd, buffer);
		if (metadata) {
			if (process.platform !== "win32") {
				const staged = fs.fstatSync(fd);
				if (staged.uid !== metadata.uid || staged.gid !== metadata.gid) fs.fchownSync(fd, metadata.uid, metadata.gid);
			}
			fs.fchmodSync(fd, mode);
		}
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		if (path.relative(parent, fs.realpathSync(requestedParent)) !== "") throw conflict();
		if (initial) {
			if (!sameVersion(fileVersion(outPath), expectedVersion)) throw conflict();
			fs.renameSync(tempPath, outPath);
			ownsTemp = false;
		} else {
			try {
				fs.linkSync(tempPath, outPath);
			} catch (error) {
				if (error.code === "EEXIST") throw conflict();
				throw error;
			}
			fs.unlinkSync(tempPath);
			ownsTemp = false;
		}
		return fileVersion(outPath);
	} finally {
		try {
			if (fd !== undefined) fs.closeSync(fd);
		} finally {
			if (ownsTemp) fs.unlinkSync(tempPath);
		}
	}
}
