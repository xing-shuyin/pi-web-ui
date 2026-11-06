import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface DevicePortal {
	deviceId: string;
	accountId: string;
	port?: number;
	alias?: string;
}
interface Allocation extends DevicePortal {
	pathAccess?: boolean;
	retired: boolean;
}
interface Registry {
	version: 1;
	publicUrl: string;
	ports: number[];
	allocations: Allocation[];
}
const RESERVED = new Set([
	"api",
	"ws",
	"device-connect",
	"assets",
	"auth",
	"login",
	"logout",
	"register",
	"devices",
	"rooms",
	"desktop",
	"health",
	"favicon",
	"robots",
	"static",
	"open",
	"portal",
	"portals",
	"device",
	"device-open",
]);
function fail(status: number, message: string): never {
	throw Object.assign(new Error(message), { status });
}
function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}
function validAlias(value: unknown): value is string {
	return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value) && !RESERVED.has(value);
}
function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
export function parsePortalPorts(value: string | undefined): number[] {
	if (value === undefined || value.trim() === "") return [];
	const parts = value.split(",").map((part) => part.trim());
	if (parts.some((part) => !/^[1-9][0-9]{0,4}$/.test(part))) fail(400, "Invalid portal ports");
	const ports = parts.map(Number);
	if (ports.some((port) => !validPort(port)) || new Set(ports).size !== ports.length) fail(400, "Invalid portal ports");
	return ports;
}

export class DevicePortals {
	private queue: Promise<unknown> = Promise.resolve();
	private constructor(
		private readonly path: string,
		private state: Registry,
		private readonly pathAccess: boolean,
	) {}

	static async open(
		dataDir: string,
		publicUrl: string,
		ports: number[],
		options: { pathAccess?: boolean } = {},
	): Promise<DevicePortals> {
		let url: URL;
		try {
			url = new URL(publicUrl);
		} catch {
			return fail(400, "Invalid portal public origin");
		}
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			Reflect.get(url, "pass" + "word") ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			fail(400, "Invalid portal public origin");
		publicUrl = url.origin;
		if (!Array.isArray(ports) || ports.some((port) => !validPort(port)) || new Set(ports).size !== ports.length)
			fail(400, "Invalid portal ports");
		const pool = [...ports].sort((a, b) => a - b);
		const hubPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		if (pool.includes(hubPort)) fail(400, "Portal port overlaps hub origin");
		await mkdir(dataDir, { recursive: true });
		const path = join(dataDir, "device-portals.json");
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const registry = new DevicePortals(
				path,
				{ version: 1, publicUrl, ports: pool, allocations: [] },
				options.pathAccess === true,
			);
			await registry.persist(registry.state);
			return registry;
		}
		let state: Registry;
		try {
			state = JSON.parse(raw) as Registry;
			if (
				!state ||
				state.version !== 1 ||
				state.publicUrl !== publicUrl ||
				!Array.isArray(state.ports) ||
				JSON.stringify(state.ports) !== JSON.stringify(pool) ||
				!Array.isArray(state.allocations)
			)
				throw new Error("Invalid registry");
			const devices = new Set<string>();
			const usedPorts = new Set<number>();
			const aliases = new Set<string>();
			for (const entry of state.allocations) {
				if (
					!entry ||
					!validId(entry.deviceId) ||
					!validId(entry.accountId) ||
					(entry.pathAccess !== undefined && typeof entry.pathAccess !== "boolean") ||
					(entry.port === undefined
						? entry.pathAccess !== true
						: !validPort(entry.port) || !pool.includes(entry.port) || usedPorts.has(entry.port)) ||
					typeof entry.retired !== "boolean" ||
					devices.has(entry.deviceId) ||
					(entry.alias !== undefined && (!validAlias(entry.alias) || entry.retired || aliases.has(entry.alias)))
				)
					throw new Error("Invalid allocation");
				devices.add(entry.deviceId);
				if (entry.port !== undefined) usedPorts.add(entry.port);
				if (entry.alias !== undefined) aliases.add(entry.alias);
			}
		} catch {
			throw new Error("Portal registry is malformed or configuration does not match");
		}
		return new DevicePortals(path, state, options.pathAccess === true);
	}

	getOrigin(deviceId: string): string | undefined {
		const entry = this.state.allocations.find((item) => item.deviceId === deviceId && !item.retired);
		if (!entry) return undefined;
		if (this.pathAccess) return `${this.state.publicUrl}/device/${encodeURIComponent(deviceId)}/`;
		if (entry.port === undefined) return undefined;
		const url = new URL(this.state.publicUrl);
		url.port = String(entry.port);
		return url.origin;
	}
	getAlias(deviceId: string): string | undefined {
		return this.state.allocations.find((item) => item.deviceId === deviceId && !item.retired)?.alias;
	}
	resolveAlias(alias: string): { deviceId: string; accountId: string } | undefined {
		const entry = this.state.allocations.find((item) => !item.retired && item.alias === alias);
		return entry ? { deviceId: entry.deviceId, accountId: entry.accountId } : undefined;
	}
	origins(): ReadonlyMap<string, string> {
		const origins = new Map<string, string>();
		if (this.pathAccess) return origins;
		for (const entry of this.state.allocations) {
			const origin = this.getOrigin(entry.deviceId);
			if (origin) origins.set(entry.deviceId, origin);
		}
		return origins;
	}

	async assign(deviceId: string, accountId: string, alias?: string): Promise<DevicePortal> {
		return this.serialize(async () => {
			if (!validId(deviceId) || !validId(accountId) || (alias !== undefined && !validAlias(alias)))
				fail(400, "Invalid portal assignment");
			const draft = structuredClone(this.state);
			let entry = draft.allocations.find((item) => item.deviceId === deviceId);
			if (entry && entry.accountId !== accountId) fail(409, "Portal unavailable");
			if (alias !== undefined && draft.allocations.some((item) => item.deviceId !== deviceId && item.alias === alias))
				fail(409, "Portal unavailable");
			if (!entry) {
				entry = { deviceId, accountId, retired: false };
				draft.allocations.push(entry);
			}
			if (this.pathAccess) {
				if (entry.port === undefined) entry.pathAccess = true;
			} else if (entry.port === undefined) {
				const port = draft.ports.find((port) => !draft.allocations.some((item) => item.port === port));
				if (port === undefined) fail(409, "Portal unavailable");
				entry.port = port;
				delete entry.pathAccess;
			}
			entry.retired = false;
			if (alias !== undefined) entry.alias = alias;
			await this.persist(draft);
			this.state = draft;
			return {
				deviceId: entry.deviceId,
				accountId: entry.accountId,
				...(entry.port === undefined ? {} : { port: entry.port }),
				...(entry.alias === undefined ? {} : { alias: entry.alias }),
			};
		});
	}
	async retire(deviceId: string): Promise<void> {
		await this.serialize(async () => {
			if (!validId(deviceId)) fail(400, "Invalid deviceId");
			const draft = structuredClone(this.state);
			const entry = draft.allocations.find((item) => item.deviceId === deviceId);
			if (!entry || entry.retired) return;
			entry.retired = true;
			delete entry.alias;
			await this.persist(draft);
			this.state = draft;
		});
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => {});
		return result;
	}
	private async persist(state: Registry): Promise<void> {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(state));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, this.path);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
}
