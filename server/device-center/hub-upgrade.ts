import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, rm, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

export interface HubUpgradeJob {
	schemaVersion: 1;
	id: string;
	state: "queued" | "running" | "succeeded" | "failed";
	phase: string;
	createdAt: number;
	updatedAt: number;
	instanceId: string;
	fromVersion: string;
	fromBootId: string;
	targetVersion?: string;
	version?: string;
	bootId?: string;
	error?: string;
	requestedBy: string;
	serviceName?: string;
}
interface StoredHubUpgradeJob extends HubUpgradeJob {
	serviceConfigPath?: string;
}
const PUBLIC_JOB_FIELDS = [
	"schemaVersion",
	"id",
	"state",
	"phase",
	"createdAt",
	"updatedAt",
	"instanceId",
	"fromVersion",
	"fromBootId",
	"targetVersion",
	"version",
	"bootId",
	"error",
	"requestedBy",
	"serviceName",
] as const satisfies readonly (keyof HubUpgradeJob)[];
function publicJob(job: StoredHubUpgradeJob): HubUpgradeJob {
	return Object.fromEntries(
		PUBLIC_JOB_FIELDS.filter((key) => job[key] !== undefined).map((key) => [key, job[key]]),
	) as unknown as HubUpgradeJob;
}
export interface HubUpgradeManager {
	start(accountId: string): Promise<HubUpgradeJob>;
	status(id?: string): Promise<HubUpgradeJob | undefined>;
}
export class HubUpgradeError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
const MAX_AGE = 30 * 60_000;
export function createHubUpgradeManager(options: {
	dataDir: string;
	instanceId?: string;
	serviceConfigPath?: string;
	version: string;
	bootId: string;
	workerPath: string;
	launch?: (jobPath: string) => Promise<void>;
}): HubUpgradeManager {
	const path = join(options.dataDir, "hub-upgrade.json");
	let submitting = false;
	async function write(job: StoredHubUpgradeJob) {
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, `${JSON.stringify(job, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			await rename(temp, path);
		} finally {
			await rm(temp, { force: true });
		}
	}
	async function status(id?: string) {
		let job: StoredHubUpgradeJob;
		try {
			job = JSON.parse(await readFile(path, "utf8")) as StoredHubUpgradeJob;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (job.schemaVersion !== 1 || !["queued", "running", "succeeded", "failed"].includes(job.state))
			throw new HubUpgradeError(500, "Invalid Hub upgrade state");
		if (id && job.id !== id) return undefined;
		if ((job.state === "queued" || job.state === "running") && Date.now() - job.createdAt > MAX_AGE)
			return {
				...publicJob(job),
				state: "failed" as const,
				phase: "failed",
				error: "Hub upgrade timed out; inspect hub-upgrade.log and hub status --json",
			};
		return publicJob(job);
	}
	const launch =
		options.launch ??
		((jobPath: string) =>
			new Promise<void>((done, reject) => {
				const child = spawn(process.execPath, [options.workerPath, "--launch", jobPath], {
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let output = "";
				child.stdout.on("data", (chunk) => {
					output = (output + chunk).slice(-4096);
				});
				child.stderr.on("data", (chunk) => {
					output = (output + chunk).slice(-4096);
				});
				const timer = setTimeout(() => {
					child.kill();
					reject(new Error("Hub upgrade worker submission timed out"));
				}, 35_000);
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("exit", (code) => {
					clearTimeout(timer);
					if (code === 0) done();
					else reject(new Error(output.trim() || `Hub upgrade worker exited ${code}`));
				});
			}));
	return {
		status,
		async start(accountId) {
			if (submitting) throw new HubUpgradeError(409, "Hub upgrade is already in progress");
			submitting = true;
			let releaseSubmission: (() => void) | undefined;
			try {
				const lockRoot = join(options.dataDir, "hub-upgrade-submission");
				await mkdir(lockRoot, { recursive: true, mode: 0o700 });
				const lifecycle = (await import(
					pathToFileURL(join(dirname(options.workerPath), "device-hub-cli.mjs")).href
				)) as {
					acquireHubLock: (root: string) => () => void;
				};
				try {
					releaseSubmission = lifecycle.acquireHubLock(lockRoot);
				} catch (error) {
					throw new HubUpgradeError(409, error instanceof Error ? error.message : "Hub upgrade submission is locked");
				}
				if (!options.instanceId || !options.serviceConfigPath)
					throw new HubUpgradeError(409, "Hub updates require an installed service; install the Hub service first");
				const settings = JSON.parse(await readFile(options.serviceConfigPath, "utf8")) as Record<string, string>;
				if (
					settings.PI_DEVICE_HUB_INSTANCE_ID !== options.instanceId ||
					resolve(settings.PI_DEVICE_HUB_DATA_DIR) !== resolve(options.dataDir)
				)
					throw new HubUpgradeError(409, "Running Hub does not match the installed service");
				const previous = await status();
				if (previous?.state === "queued" || previous?.state === "running")
					throw new HubUpgradeError(409, "Hub upgrade is already in progress");
				const now = Date.now();
				const job: StoredHubUpgradeJob = {
					schemaVersion: 1,
					id: randomUUID(),
					state: "queued",
					phase: "queued",
					createdAt: now,
					updatedAt: now,
					instanceId: options.instanceId,
					fromVersion: options.version,
					fromBootId: options.bootId,
					requestedBy: accountId,
					serviceConfigPath: resolve(options.serviceConfigPath),
					...(settings.PI_DEVICE_HUB_SERVICE_NAME ? { serviceName: settings.PI_DEVICE_HUB_SERVICE_NAME } : {}),
				};
				await write(job);
				try {
					await launch(path);
				} catch (error) {
					await write({
						...job,
						state: "failed",
						phase: "failed",
						updatedAt: Date.now(),
						error: error instanceof Error ? error.message.slice(0, 4096) : "Hub upgrade submission failed",
					});
					throw new HubUpgradeError(503, error instanceof Error ? error.message : "Hub upgrade submission failed");
				}
				return (await status(job.id)) ?? publicJob(job);
			} finally {
				releaseSubmission?.();
				submitting = false;
			}
		},
	};
}
