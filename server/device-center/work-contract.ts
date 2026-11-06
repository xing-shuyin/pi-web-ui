import { createHash, randomUUID } from "node:crypto";
import type {
	ContextManifest,
	DeviceArtifact,
	DeviceArtifactBaseline,
	DeviceExecutionMode,
	DeviceWorkContract,
	DeviceWorkContractInput,
} from "../protocol.js";

const COMMIT_SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const TREE_HEX_REGEX = /^[0-9a-fA-F]{40}$/;
const STRICT_BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LOCAL_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\/(\/|[a-zA-Z0-9_-]+[\\/])|[\\/]/;

export const MAX_GOAL_CHARS = 16_384;
export const MAX_ID_CHARS = 128;
export const MAX_ARRAY_ITEMS = 64;
export const MAX_ITEM_CHARS = 2_048;
export const MAX_REPO_ID_CHARS = 256;
export const MAX_POLICY_REF_CHARS = 256;
export const MAX_TRUNCATION_BUDGET = 10_000_000;
export const MAX_PATCH_BYTES = 128 * 1024;
export const MAX_INPUT_ARTIFACTS = 8;
export const MAX_WORK_CONTRACT_BYTES = 256 * 1024;
export const MAX_CONTEXT_MANIFEST_BYTES = 96 * 1024;
export const MAX_CONTRACT_REQUEST_BYTES = 384 * 1024;

export function contractInputReferences(contract: DeviceWorkContract): { id: string; digest: string }[] | null {
	return contract.inputArtifacts?.length ? contract.inputArtifacts.map(({ id, digest }) => ({ id, digest })) : null;
}

const CONTRACT_ALLOWED_KEYS = new Set([
	"id",
	"revision",
	"digest",
	"executionMode",
	"goal",
	"constraints",
	"acceptanceCriteria",
	"baseline",
	"inputArtifacts",
	"createdAt",
]);

const CONTRACT_INPUT_ALLOWED_KEYS = new Set([
	"id",
	"revision",
	"executionMode",
	"goal",
	"constraints",
	"acceptanceCriteria",
	"baseline",
	"inputArtifacts",
]);

const BASELINE_ALLOWED_KEYS = new Set(["repositoryId", "commit"]);

const PRODUCER_ALLOWED_KEYS = new Set(["deviceId", "botId", "taskId", "attemptId", "contractDigest", "manifestDigest"]);

const ARTIFACT_ALLOWED_KEYS = new Set([
	"id",
	"digest",
	"producer",
	"baseline",
	"inputTree",
	"outputTree",
	"patchBase64",
	"patchSha256",
	"createdAt",
]);

const MANIFEST_ALLOWED_KEYS = new Set([
	"version",
	"digest",
	"contractId",
	"contractRevision",
	"contractDigest",
	"executionPolicy",
	"context",
	"taskState",
	"inputs",
	"policyRef",
	"truncationBudget",
	"createdAt",
]);

function checkAllowedKeys(obj: Record<string, unknown>, allowed: Set<string>, context: string): string | null {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			return `Unknown field '${key}' in ${context}`;
		}
	}
	return null;
}

export function deepFreeze<T>(obj: T): Readonly<T> {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}
	const seen = new Set<unknown>();
	function freezeInternal(val: unknown) {
		if (val === null || typeof val !== "object" || seen.has(val)) {
			return;
		}
		seen.add(val);
		Object.freeze(val);
		for (const key of Object.getOwnPropertyNames(val)) {
			freezeInternal((val as Record<string, unknown>)[key]);
		}
	}
	freezeInternal(obj);
	return obj as Readonly<T>;
}

function safeClone<T>(val: T): T {
	const ancestors = new Set<object>();
	let bytes = 0;
	function visit(value: unknown, depth: number): void {
		if (depth > 64) throw new Error("JSON input exceeds maximum depth of 64");
		if (value === null || typeof value === "boolean") return;
		if (typeof value === "string") bytes += Buffer.byteLength(value);
		else if (typeof value === "number" && Number.isFinite(value)) bytes += 8;
		else if (typeof value === "object") {
			if (ancestors.has(value)) throw new Error("JSON input contains a cycle");
			if (
				!Array.isArray(value) &&
				Object.getPrototypeOf(value) !== Object.prototype &&
				Object.getPrototypeOf(value) !== null
			)
				throw new Error("JSON input must contain plain objects");
			if (Object.getOwnPropertySymbols(value).length) throw new Error("JSON input contains symbol keys");
			ancestors.add(value);
			for (const key of Object.keys(value)) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
				if (!("value" in descriptor)) throw new Error("JSON input contains an accessor");
				bytes += Buffer.byteLength(key) + 4;
				if (descriptor.value !== undefined || Array.isArray(value)) visit(descriptor.value, depth + 1);
			}
			if (Array.isArray(value) && Object.keys(value).length !== value.length)
				throw new Error("JSON input contains a sparse array");
			ancestors.delete(value);
		} else throw new Error("JSON input contains a non-JSON value");
		if (bytes > 16 * 1024 * 1024) throw new Error("JSON input exceeds maximum size of 16 MiB");
	}
	visit(val, 0);
	return JSON.parse(JSON.stringify(val));
}

export function canonicalizeJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return "[" + value.map((item) => canonicalizeJson(item)).join(",") + "]";
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const entries: string[] = [];
	for (const key of keys) {
		const val = (value as Record<string, unknown>)[key];
		if (val !== undefined) {
			entries.push(JSON.stringify(key) + ":" + canonicalizeJson(val));
		}
	}
	return "{" + entries.join(",") + "}";
}

export function computeContractDigest(contract: Omit<DeviceWorkContract, "digest"> | DeviceWorkContract): string {
	const canonicalPayload = {
		id: contract.id,
		revision: contract.revision,
		executionMode: contract.executionMode,
		goal: contract.goal,
		constraints: contract.constraints ?? [],
		acceptanceCriteria: contract.acceptanceCriteria ?? [],
		baseline: contract.baseline
			? {
					repositoryId: contract.baseline.repositoryId,
					commit: contract.baseline.commit,
				}
			: null,
		inputArtifacts: (contract.inputArtifacts ?? []).map((a) => ({
			id: a.id,
			digest: a.digest,
			producer: {
				deviceId: a.producer.deviceId,
				botId: a.producer.botId,
				taskId: a.producer.taskId,
				attemptId: a.producer.attemptId,
				contractDigest: a.producer.contractDigest ?? null,
				manifestDigest: a.producer.manifestDigest ?? null,
			},
			baseline: a.baseline
				? {
						repositoryId: a.baseline.repositoryId,
						commit: a.baseline.commit,
					}
				: null,
			inputTree: a.inputTree ?? null,
			outputTree: a.outputTree ?? null,
			patchBase64: a.patchBase64 ?? null,
			patchSha256: a.patchSha256 ?? null,
			createdAt: a.createdAt,
		})),
	};
	return createHash("sha256").update(canonicalizeJson(canonicalPayload)).digest("hex");
}

export function computeManifestDigest(manifest: Omit<ContextManifest, "digest"> | ContextManifest): string {
	const canonicalPayload = {
		version: manifest.version,
		contractId: manifest.contractId,
		contractRevision: manifest.contractRevision,
		contractDigest: manifest.contractDigest,
		executionPolicy: manifest.executionPolicy ?? null,
		context: manifest.context ?? null,
		taskState: manifest.taskState ?? null,
		inputs: manifest.inputs ?? null,
		policyRef: manifest.policyRef ?? null,
		truncationBudget: manifest.truncationBudget ?? null,
	};
	return createHash("sha256").update(canonicalizeJson(canonicalPayload)).digest("hex");
}

export function computeArtifactDigest(artifact: Omit<DeviceArtifact, "digest"> | DeviceArtifact): string {
	const canonicalPayload = {
		id: artifact.id,
		producer: {
			deviceId: artifact.producer.deviceId,
			botId: artifact.producer.botId,
			taskId: artifact.producer.taskId,
			attemptId: artifact.producer.attemptId,
			contractDigest: artifact.producer.contractDigest ?? null,
			manifestDigest: artifact.producer.manifestDigest ?? null,
		},
		baseline: artifact.baseline
			? {
					repositoryId: artifact.baseline.repositoryId,
					commit: artifact.baseline.commit,
				}
			: null,
		inputTree: artifact.inputTree ?? null,
		outputTree: artifact.outputTree ?? null,
		patchBase64: artifact.patchBase64 ?? null,
		patchSha256: artifact.patchSha256 ?? null,
		createdAt: artifact.createdAt,
	};
	return createHash("sha256").update(canonicalizeJson(canonicalPayload)).digest("hex");
}

export function validateDeviceArtifact(
	artifact: unknown,
): { valid: true; artifact: DeviceArtifact } | { valid: false; reason: string } {
	try {
		if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
			return { valid: false, reason: "Artifact must be a non-null object" };
		}
		const a = safeClone(artifact) as Record<string, unknown>;

		const rootUnknown = checkAllowedKeys(a, ARTIFACT_ALLOWED_KEYS, "artifact");
		if (rootUnknown) {
			return { valid: false, reason: rootUnknown };
		}

		if (typeof a.id !== "string" || !a.id.trim() || a.id.length > MAX_ID_CHARS) {
			return { valid: false, reason: `Artifact id must be a non-empty string up to ${MAX_ID_CHARS} chars` };
		}
		if (typeof a.digest !== "string" || !HEX_64_REGEX.test(a.digest)) {
			return { valid: false, reason: "Artifact digest must be a 64-character hex SHA-256 digest" };
		}
		if (typeof a.createdAt !== "number" || !Number.isFinite(a.createdAt) || a.createdAt < 0) {
			return { valid: false, reason: "Artifact createdAt must be a valid positive timestamp" };
		}

		if (!a.producer || typeof a.producer !== "object" || Array.isArray(a.producer)) {
			return { valid: false, reason: "Artifact producer must be an object" };
		}
		const p = a.producer as Record<string, unknown>;

		const prodUnknown = checkAllowedKeys(p, PRODUCER_ALLOWED_KEYS, "artifact.producer");
		if (prodUnknown) {
			return { valid: false, reason: prodUnknown };
		}

		if (typeof p.deviceId !== "string" || !p.deviceId.trim() || p.deviceId.length > MAX_ID_CHARS) {
			return { valid: false, reason: "Artifact producer.deviceId is required" };
		}
		if (typeof p.botId !== "string" || !p.botId.trim() || p.botId.length > MAX_ID_CHARS) {
			return { valid: false, reason: "Artifact producer.botId is required" };
		}
		if (typeof p.taskId !== "string" || !p.taskId.trim() || p.taskId.length > MAX_ID_CHARS) {
			return { valid: false, reason: "Artifact producer.taskId is required" };
		}
		if (typeof p.attemptId !== "string" || !p.attemptId.trim() || p.attemptId.length > MAX_ID_CHARS) {
			return { valid: false, reason: "Artifact producer.attemptId is required" };
		}
		if (
			p.contractDigest !== undefined &&
			(typeof p.contractDigest !== "string" || !HEX_64_REGEX.test(p.contractDigest))
		) {
			return { valid: false, reason: "Artifact producer.contractDigest must be a 64-character hex SHA-256 string" };
		}
		if (
			p.manifestDigest !== undefined &&
			(typeof p.manifestDigest !== "string" || !HEX_64_REGEX.test(p.manifestDigest))
		) {
			return { valid: false, reason: "Artifact producer.manifestDigest must be a 64-character hex SHA-256 string" };
		}

		if (a.baseline !== undefined && a.baseline !== null) {
			if (typeof a.baseline !== "object" || Array.isArray(a.baseline)) {
				return { valid: false, reason: "Artifact baseline must be an object" };
			}
			const b = a.baseline as Record<string, unknown>;
			const baseUnknown = checkAllowedKeys(b, BASELINE_ALLOWED_KEYS, "artifact.baseline");
			if (baseUnknown) {
				return { valid: false, reason: baseUnknown };
			}
			if (typeof b.repositoryId !== "string" || !b.repositoryId.trim() || b.repositoryId.length > MAX_REPO_ID_CHARS) {
				return { valid: false, reason: "Artifact baseline.repositoryId must be a non-empty string" };
			}
			if (typeof b.commit !== "string" || !COMMIT_SHA_REGEX.test(b.commit)) {
				return { valid: false, reason: "Artifact baseline.commit must be a 40-character hex commit SHA" };
			}
		}

		if (a.inputTree !== undefined && a.inputTree !== null) {
			if (typeof a.inputTree !== "string" || !TREE_HEX_REGEX.test(a.inputTree)) {
				return { valid: false, reason: "Artifact inputTree must be a 40-character hex tree SHA" };
			}
			if (LOCAL_PATH_REGEX.test(a.inputTree)) {
				return { valid: false, reason: "Artifact inputTree must not be a machine-local file path" };
			}
		}
		if (a.outputTree !== undefined && a.outputTree !== null) {
			if (typeof a.outputTree !== "string" || !TREE_HEX_REGEX.test(a.outputTree)) {
				return { valid: false, reason: "Artifact outputTree must be a 40-character hex tree SHA" };
			}
			if (LOCAL_PATH_REGEX.test(a.outputTree)) {
				return { valid: false, reason: "Artifact outputTree must not be a machine-local file path" };
			}
		}

		if ((a.patchBase64 === undefined) !== (a.patchSha256 === undefined)) {
			return { valid: false, reason: "Artifact patchBase64 and patchSha256 must be provided together" };
		}
		if (a.patchBase64 !== undefined) {
			if (typeof a.patchBase64 !== "string") {
				return { valid: false, reason: "Artifact patchBase64 must be a string" };
			}
			if (a.patchBase64.length > 4 * Math.ceil(MAX_PATCH_BYTES / 3)) {
				return { valid: false, reason: `Artifact patch exceeds maximum bounded size of ${MAX_PATCH_BYTES} bytes` };
			}
			if (!STRICT_BASE64_REGEX.test(a.patchBase64)) {
				return { valid: false, reason: "Artifact patchBase64 contains invalid base64 characters or padding" };
			}
			if (typeof a.patchSha256 !== "string" || !HEX_64_REGEX.test(a.patchSha256)) {
				return { valid: false, reason: "Artifact patchSha256 must be a 64-character hex SHA-256 string" };
			}
			const decoded = Buffer.from(a.patchBase64, "base64");
			if (decoded.byteLength > MAX_PATCH_BYTES) {
				return { valid: false, reason: `Artifact patch exceeds maximum bounded size of ${MAX_PATCH_BYTES} bytes` };
			}
			if (decoded.toString("base64") !== a.patchBase64) {
				return { valid: false, reason: "Artifact patchBase64 is not strictly canonical" };
			}
			const computedPatchSha256 = createHash("sha256").update(decoded).digest("hex");
			if (computedPatchSha256.toLowerCase() !== a.patchSha256.toLowerCase()) {
				return { valid: false, reason: "Artifact patchSha256 does not match patchBase64 content" };
			}
		}

		const typedArtifact = a as unknown as DeviceArtifact;
		const computedDigest = computeArtifactDigest(typedArtifact);
		if (computedDigest.toLowerCase() !== typedArtifact.digest.toLowerCase()) {
			return {
				valid: false,
				reason: `Artifact digest mismatch: expected ${computedDigest}, got ${typedArtifact.digest}`,
			};
		}

		return { valid: true, artifact: deepFreeze(typedArtifact) };
	} catch (err: any) {
		return { valid: false, reason: `Malformed artifact: ${err?.message ?? "unknown error"}` };
	}
}

function codeArtifactProofError(artifact: DeviceArtifact): string | undefined {
	if (!artifact.baseline) return "Code artifact requires complete baseline";
	if (!artifact.inputTree || !artifact.outputTree)
		return "Code artifact requires 40-character hex inputTree and outputTree";
	if (typeof artifact.patchBase64 !== "string" || !artifact.patchSha256)
		return "Code artifact requires patchBase64 and patchSha256 (empty patch is allowed)";
	if (!artifact.producer.contractDigest || !artifact.producer.manifestDigest)
		return "Code artifact requires producer contractDigest and manifestDigest";
}

export function validateInputArtifacts(
	artifacts: unknown,
	baseline?: DeviceArtifactBaseline,
	executionMode?: DeviceExecutionMode,
): { valid: true; artifacts: DeviceArtifact[] } | { valid: false; reason: string } {
	try {
		if (artifacts === undefined) {
			return { valid: true, artifacts: [] };
		}
		if (!Array.isArray(artifacts)) {
			return { valid: false, reason: "inputArtifacts must be an array" };
		}
		if (artifacts.length === 0) {
			return { valid: true, artifacts: [] };
		}

		if (executionMode === "chat") {
			return { valid: false, reason: "Chat execution mode does not support inputArtifacts synthesis" };
		}
		if (artifacts.length > MAX_INPUT_ARTIFACTS) {
			return { valid: false, reason: `inputArtifacts exceeds maximum limit of ${MAX_INPUT_ARTIFACTS} items` };
		}

		const validated: DeviceArtifact[] = [];
		const seenIds = new Set<string>();

		for (let i = 0; i < artifacts.length; i++) {
			const raw = artifacts[i];
			const res = validateDeviceArtifact(raw);
			if (!res.valid) {
				return { valid: false, reason: `inputArtifacts[${i}] is invalid: ${res.reason}` };
			}
			const art = res.artifact;

			if (seenIds.has(art.id)) {
				return { valid: false, reason: `Duplicate artifact id in inputArtifacts: ${art.id}` };
			}
			seenIds.add(art.id);

			if (baseline && art.baseline) {
				if (art.baseline.repositoryId !== baseline.repositoryId) {
					return {
						valid: false,
						reason: `Artifact baseline repository mismatch: artifact has '${art.baseline.repositoryId}', contract requires '${baseline.repositoryId}'`,
					};
				}
				if (art.baseline.commit.toLowerCase() !== baseline.commit.toLowerCase()) {
					return {
						valid: false,
						reason: `Artifact baseline commit mismatch: artifact has '${art.baseline.commit}', contract requires '${baseline.commit}'`,
					};
				}
			}

			const proofError = codeArtifactProofError(art);
			if (proofError) return { valid: false, reason: `inputArtifacts[${i}]: ${proofError}` };
			if (!baseline) return { valid: false, reason: "inputArtifacts require a contract baseline" };
			validated.push(art);
		}

		return { valid: true, artifacts: validated };
	} catch (err: any) {
		return { valid: false, reason: `Malformed inputArtifacts: ${err?.message ?? "unknown error"}` };
	}
}

export function createWorkContract(input: DeviceWorkContractInput, fallbackGoal?: string): DeviceWorkContract {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("Contract input must be a non-null object");
	}

	input = safeClone(input);
	const unknownKey = checkAllowedKeys(input as Record<string, unknown>, CONTRACT_INPUT_ALLOWED_KEYS, "contract input");
	if (unknownKey) {
		throw new Error(unknownKey);
	}

	const executionMode: DeviceExecutionMode = input.executionMode === undefined ? "chat" : input.executionMode;
	if (executionMode !== "chat" && executionMode !== "code") {
		throw new Error(`Invalid executionMode: expected 'chat' or 'code', got '${executionMode}'`);
	}

	const rawGoal = input.goal === undefined ? (fallbackGoal ?? "") : input.goal;
	if (typeof rawGoal !== "string" || !rawGoal.trim()) {
		throw new Error("Contract goal must be a non-empty string");
	}
	const goal = rawGoal.trim();
	if (goal.length > MAX_GOAL_CHARS) {
		throw new Error(`Contract goal exceeds maximum length of ${MAX_GOAL_CHARS} characters`);
	}

	if (input.id !== undefined && (typeof input.id !== "string" || !input.id.trim()))
		throw new Error("Contract id must be a non-empty string");
	const id = input.id?.trim() ?? `contract-${randomUUID()}`;
	if (id.length > MAX_ID_CHARS) {
		throw new Error(`Contract id exceeds maximum length of ${MAX_ID_CHARS} characters`);
	}

	const revision = input.revision === undefined ? 1 : input.revision;
	if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000) {
		throw new Error(`Contract revision must be a positive integer up to 1,000,000, got ${revision}`);
	}

	let constraints: string[] | undefined;
	if (input.constraints !== undefined) {
		if (!Array.isArray(input.constraints)) {
			throw new Error("Contract constraints must be an array of strings");
		}
		if (input.constraints.length > MAX_ARRAY_ITEMS) {
			throw new Error(`Contract constraints exceeds limit of ${MAX_ARRAY_ITEMS} items`);
		}
		for (let i = 0; i < input.constraints.length; i++) {
			const item = input.constraints[i];
			if (typeof item !== "string" || item.length > MAX_ITEM_CHARS) {
				throw new Error(`Contract constraints[${i}] must be a string up to ${MAX_ITEM_CHARS} characters`);
			}
		}
		constraints = [...input.constraints];
	}

	let acceptanceCriteria: string[] | undefined;
	if (input.acceptanceCriteria !== undefined) {
		if (!Array.isArray(input.acceptanceCriteria)) {
			throw new Error("Contract acceptanceCriteria must be an array of strings");
		}
		if (input.acceptanceCriteria.length > MAX_ARRAY_ITEMS) {
			throw new Error(`Contract acceptanceCriteria exceeds limit of ${MAX_ARRAY_ITEMS} items`);
		}
		for (let i = 0; i < input.acceptanceCriteria.length; i++) {
			const item = input.acceptanceCriteria[i];
			if (typeof item !== "string" || item.length > MAX_ITEM_CHARS) {
				throw new Error(`Contract acceptanceCriteria[${i}] must be a string up to ${MAX_ITEM_CHARS} characters`);
			}
		}
		acceptanceCriteria = [...input.acceptanceCriteria];
	}

	let baseline: DeviceArtifactBaseline | undefined;
	if (executionMode === "code") {
		if (!input.baseline || typeof input.baseline !== "object" || Array.isArray(input.baseline)) {
			throw new Error("Code executionMode requires a baseline with repositoryId and commit SHA");
		}
		const baseUnknown = checkAllowedKeys(
			input.baseline as unknown as Record<string, unknown>,
			BASELINE_ALLOWED_KEYS,
			"baseline",
		);
		if (baseUnknown) {
			throw new Error(baseUnknown);
		}
		if (typeof input.baseline.repositoryId !== "string" || !input.baseline.repositoryId.trim()) {
			throw new Error("Code baseline.repositoryId must be a non-empty string");
		}
		if (input.baseline.repositoryId.trim().length > MAX_REPO_ID_CHARS) {
			throw new Error(`Code baseline.repositoryId exceeds maximum length of ${MAX_REPO_ID_CHARS}`);
		}
		if (typeof input.baseline.commit !== "string" || !COMMIT_SHA_REGEX.test(input.baseline.commit)) {
			throw new Error("Code baseline.commit must be a 40-character hex commit SHA");
		}
		baseline = {
			repositoryId: input.baseline.repositoryId.trim(),
			commit: input.baseline.commit.trim().toLowerCase(),
		};
	} else if (input.baseline !== undefined) {
		if (!input.baseline || typeof input.baseline !== "object" || Array.isArray(input.baseline)) {
			throw new Error("Contract baseline must be an object");
		}
		const baseUnknown = checkAllowedKeys(
			input.baseline as unknown as Record<string, unknown>,
			BASELINE_ALLOWED_KEYS,
			"baseline",
		);
		if (baseUnknown) {
			throw new Error(baseUnknown);
		}
		if (typeof input.baseline.repositoryId !== "string" || !input.baseline.repositoryId.trim()) {
			throw new Error("baseline.repositoryId must be a non-empty string");
		}
		if (input.baseline.repositoryId.trim().length > MAX_REPO_ID_CHARS) {
			throw new Error(`baseline.repositoryId exceeds maximum length of ${MAX_REPO_ID_CHARS}`);
		}
		if (typeof input.baseline.commit !== "string" || !COMMIT_SHA_REGEX.test(input.baseline.commit)) {
			throw new Error("baseline.commit must be a 40-character hex commit SHA");
		}
		baseline = {
			repositoryId: input.baseline.repositoryId.trim(),
			commit: input.baseline.commit.trim().toLowerCase(),
		};
	}

	const clonedArtifacts = input.inputArtifacts === undefined ? undefined : safeClone(input.inputArtifacts);
	const synthCheck = validateInputArtifacts(clonedArtifacts, baseline, executionMode);
	if (!synthCheck.valid) {
		throw new Error(`Cannot safely synthesize input artifacts: ${synthCheck.reason}`);
	}

	const contractWithoutDigest: Omit<DeviceWorkContract, "digest"> = {
		id,
		revision,
		executionMode,
		goal,
		constraints,
		acceptanceCriteria,
		baseline,
		inputArtifacts: synthCheck.artifacts.length > 0 ? synthCheck.artifacts : undefined,
		createdAt: Date.now(),
	};

	const digest = computeContractDigest(contractWithoutDigest);
	const contract: DeviceWorkContract = {
		...contractWithoutDigest,
		digest,
	};

	if (Buffer.byteLength(JSON.stringify(contract)) > MAX_WORK_CONTRACT_BYTES)
		throw new Error(`Contract exceeds maximum size of ${MAX_WORK_CONTRACT_BYTES} bytes`);
	return deepFreeze(contract);
}

export function validateWorkContract(
	contract: unknown,
): { valid: true; contract: DeviceWorkContract } | { valid: false; reason: string } {
	try {
		if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
			return { valid: false, reason: "Contract must be a non-null object" };
		}
		const c = safeClone(contract) as Record<string, unknown>;
		if (Buffer.byteLength(JSON.stringify(c)) > MAX_WORK_CONTRACT_BYTES)
			return { valid: false, reason: `Contract exceeds maximum size of ${MAX_WORK_CONTRACT_BYTES} bytes` };

		const rootUnknown = checkAllowedKeys(c, CONTRACT_ALLOWED_KEYS, "contract");
		if (rootUnknown) {
			return { valid: false, reason: rootUnknown };
		}

		if (typeof c.id !== "string" || !c.id.trim() || c.id.length > MAX_ID_CHARS) {
			return { valid: false, reason: `Contract id must be a string up to ${MAX_ID_CHARS} chars` };
		}
		if (!Number.isSafeInteger(c.revision) || (c.revision as number) < 1 || (c.revision as number) > 1_000_000) {
			return { valid: false, reason: "Contract revision must be a positive integer up to 1,000,000" };
		}
		if (
			c.createdAt !== undefined &&
			(typeof c.createdAt !== "number" || !Number.isFinite(c.createdAt) || c.createdAt < 0)
		)
			return { valid: false, reason: "Contract createdAt must be a valid timestamp" };
		if (c.executionMode !== "chat" && c.executionMode !== "code") {
			return { valid: false, reason: "Contract executionMode must be 'chat' or 'code'" };
		}
		if (typeof c.goal !== "string" || !c.goal.trim() || c.goal.length > MAX_GOAL_CHARS) {
			return { valid: false, reason: `Contract goal must be a non-empty string up to ${MAX_GOAL_CHARS} chars` };
		}

		if (c.constraints !== undefined) {
			if (!Array.isArray(c.constraints)) {
				return { valid: false, reason: "Contract constraints must be an array" };
			}
			if (c.constraints.length > MAX_ARRAY_ITEMS) {
				return { valid: false, reason: `Contract constraints exceeds ${MAX_ARRAY_ITEMS} items` };
			}
			for (let i = 0; i < c.constraints.length; i++) {
				const item = c.constraints[i];
				if (typeof item !== "string" || item.length > MAX_ITEM_CHARS) {
					return { valid: false, reason: `Contract constraints[${i}] must be string up to ${MAX_ITEM_CHARS} chars` };
				}
			}
		}

		if (c.acceptanceCriteria !== undefined) {
			if (!Array.isArray(c.acceptanceCriteria)) {
				return { valid: false, reason: "Contract acceptanceCriteria must be an array" };
			}
			if (c.acceptanceCriteria.length > MAX_ARRAY_ITEMS) {
				return { valid: false, reason: `Contract acceptanceCriteria exceeds ${MAX_ARRAY_ITEMS} items` };
			}
			for (let i = 0; i < c.acceptanceCriteria.length; i++) {
				const item = c.acceptanceCriteria[i];
				if (typeof item !== "string" || item.length > MAX_ITEM_CHARS) {
					return {
						valid: false,
						reason: `Contract acceptanceCriteria[${i}] must be string up to ${MAX_ITEM_CHARS} chars`,
					};
				}
			}
		}

		if (c.executionMode === "code") {
			if (!c.baseline || typeof c.baseline !== "object" || Array.isArray(c.baseline)) {
				return { valid: false, reason: "Code contract requires baseline object" };
			}
			const b = c.baseline as unknown as Record<string, unknown>;
			const baseUnknown = checkAllowedKeys(b, BASELINE_ALLOWED_KEYS, "contract.baseline");
			if (baseUnknown) {
				return { valid: false, reason: baseUnknown };
			}
			if (typeof b.repositoryId !== "string" || !b.repositoryId.trim() || b.repositoryId.length > MAX_REPO_ID_CHARS) {
				return { valid: false, reason: "Code contract baseline.repositoryId must be non-empty string" };
			}
			if (typeof b.commit !== "string" || !COMMIT_SHA_REGEX.test(b.commit)) {
				return { valid: false, reason: "Code contract baseline.commit must be 40-character hex commit SHA" };
			}
		} else if (c.baseline !== undefined) {
			if (!c.baseline || typeof c.baseline !== "object" || Array.isArray(c.baseline)) {
				return { valid: false, reason: "Contract baseline must be an object" };
			}
			const b = c.baseline as unknown as Record<string, unknown>;
			const baseUnknown = checkAllowedKeys(b, BASELINE_ALLOWED_KEYS, "contract.baseline");
			if (baseUnknown) {
				return { valid: false, reason: baseUnknown };
			}
			if (typeof b.repositoryId !== "string" || !b.repositoryId.trim() || b.repositoryId.length > MAX_REPO_ID_CHARS) {
				return { valid: false, reason: "Contract baseline.repositoryId must be non-empty string" };
			}
			if (typeof b.commit !== "string" || !COMMIT_SHA_REGEX.test(b.commit)) {
				return { valid: false, reason: "Contract baseline.commit must be 40-character hex commit SHA" };
			}
		}

		const baseline = c.baseline as DeviceArtifactBaseline | undefined;
		const synth = validateInputArtifacts(c.inputArtifacts, baseline, c.executionMode as DeviceExecutionMode);
		if (!synth.valid) {
			return { valid: false, reason: `inputArtifacts invalid: ${synth.reason}` };
		}

		if (typeof c.digest !== "string" || !HEX_64_REGEX.test(c.digest)) {
			return { valid: false, reason: "Contract digest must be a 64-character hex SHA-256 digest" };
		}

		const typedContract = c as unknown as DeviceWorkContract;
		const computedDigest = computeContractDigest(typedContract);
		if (computedDigest.toLowerCase() !== typedContract.digest.toLowerCase()) {
			return {
				valid: false,
				reason: `Contract digest mismatch: expected ${computedDigest}, got ${typedContract.digest}`,
			};
		}

		return { valid: true, contract: deepFreeze(typedContract) };
	} catch (err: any) {
		return { valid: false, reason: `Malformed contract: ${err?.message ?? "unknown error"}` };
	}
}

export function assertValidWorkContract(contract: unknown): asserts contract is DeviceWorkContract {
	const res = validateWorkContract(contract);
	if (!res.valid) {
		throw new Error(`Invalid work contract: ${res.reason}`);
	}
}

export function createContextManifest(args: {
	contract: DeviceWorkContract;
	executionPolicy?: ContextManifest["executionPolicy"];
	context: unknown;
	taskState?: unknown;
	inputs?: unknown;
	policyRef?: string;
	truncationBudget?: number;
	createdAt?: number;
}): ContextManifest {
	assertValidWorkContract(args.contract);

	if (
		args.policyRef !== undefined &&
		(typeof args.policyRef !== "string" || !args.policyRef.trim() || args.policyRef.length > MAX_POLICY_REF_CHARS)
	) {
		throw new Error(`policyRef must be a string up to ${MAX_POLICY_REF_CHARS} characters`);
	}
	if (
		args.truncationBudget !== undefined &&
		(!Number.isSafeInteger(args.truncationBudget) ||
			args.truncationBudget < 1 ||
			args.truncationBudget > MAX_TRUNCATION_BUDGET)
	) {
		throw new Error(`truncationBudget must be a positive integer up to ${MAX_TRUNCATION_BUDGET}`);
	}

	const clonedContext = args.context !== undefined ? safeClone(args.context) : null;
	const clonedTaskState = args.taskState !== undefined ? safeClone(args.taskState) : null;
	const clonedInputs = args.inputs !== undefined ? safeClone(args.inputs) : contractInputReferences(args.contract);

	const manifestWithoutDigest: Omit<ContextManifest, "digest"> = {
		version: 1,
		contractId: args.contract.id,
		contractRevision: args.contract.revision,
		contractDigest: args.contract.digest,
		executionPolicy: args.executionPolicy === undefined ? undefined : safeClone(args.executionPolicy),
		context: clonedContext,
		taskState: clonedTaskState,
		inputs: clonedInputs,
		policyRef: args.policyRef,
		truncationBudget: args.truncationBudget,
		createdAt: args.createdAt ?? Date.now(),
	};

	const digest = computeManifestDigest(manifestWithoutDigest);
	const manifest: ContextManifest = {
		...manifestWithoutDigest,
		digest,
	};

	const validated = validateContextManifest(manifest, args.contract);
	if (!validated.valid) throw new Error(validated.reason);
	return validated.manifest;
}

export function validateContextManifest(
	manifest: unknown,
	expectedContract?: DeviceWorkContract,
): { valid: true; manifest: ContextManifest } | { valid: false; reason: string } {
	try {
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
			return { valid: false, reason: "ContextManifest must be a non-null object" };
		}
		const m = safeClone(manifest) as Record<string, unknown>;
		if (Buffer.byteLength(JSON.stringify(m)) > MAX_CONTEXT_MANIFEST_BYTES)
			return { valid: false, reason: `ContextManifest exceeds maximum size of ${MAX_CONTEXT_MANIFEST_BYTES} bytes` };

		const rootUnknown = checkAllowedKeys(m, MANIFEST_ALLOWED_KEYS, "contextManifest");
		if (rootUnknown) {
			return { valid: false, reason: rootUnknown };
		}

		if (m.executionPolicy !== undefined) {
			const p = m.executionPolicy as Record<string, unknown>;
			if (
				!p ||
				typeof p !== "object" ||
				Array.isArray(p) ||
				checkAllowedKeys(p, new Set(["deviceId", "botId", "botRevision"]), "executionPolicy") ||
				!Number.isSafeInteger(p.botRevision) ||
				(p.botRevision as number) < 1 ||
				["deviceId", "botId"].some(
					(key) => typeof p[key] !== "string" || !(p[key] as string).trim() || (p[key] as string).length > MAX_ID_CHARS,
				)
			)
				return {
					valid: false,
					reason: "ContextManifest executionPolicy must reference deviceId, botId and a positive botRevision",
				};
		}
		if (typeof m.createdAt !== "number" || !Number.isFinite(m.createdAt) || m.createdAt < 0)
			return { valid: false, reason: "ContextManifest createdAt must be a valid timestamp" };
		if (m.context === undefined)
			return { valid: false, reason: "ContextManifest context is required (null is allowed)" };
		if (m.version !== 1) {
			return { valid: false, reason: `ContextManifest version must be 1, got ${m.version}` };
		}
		if (typeof m.contractId !== "string" || !m.contractId || m.contractId.length > MAX_ID_CHARS) {
			return { valid: false, reason: "ContextManifest contractId is required" };
		}
		if (!Number.isSafeInteger(m.contractRevision) || (m.contractRevision as number) < 1) {
			return { valid: false, reason: "ContextManifest contractRevision must be positive integer" };
		}
		if (typeof m.contractDigest !== "string" || !HEX_64_REGEX.test(m.contractDigest)) {
			return { valid: false, reason: "ContextManifest contractDigest must be 64-char hex SHA-256" };
		}
		if (typeof m.digest !== "string" || !HEX_64_REGEX.test(m.digest)) {
			return { valid: false, reason: "ContextManifest digest must be 64-char hex SHA-256" };
		}
		if (
			m.policyRef !== undefined &&
			(typeof m.policyRef !== "string" || !m.policyRef.trim() || m.policyRef.length > MAX_POLICY_REF_CHARS)
		) {
			return { valid: false, reason: `policyRef must be a string up to ${MAX_POLICY_REF_CHARS} chars` };
		}
		if (
			m.truncationBudget !== undefined &&
			(!Number.isSafeInteger(m.truncationBudget) ||
				(m.truncationBudget as number) < 1 ||
				(m.truncationBudget as number) > MAX_TRUNCATION_BUDGET)
		) {
			return { valid: false, reason: `truncationBudget must be integer up to ${MAX_TRUNCATION_BUDGET}` };
		}

		if (typeof m.truncationBudget === "number" && Buffer.byteLength(JSON.stringify(m.context)) > m.truncationBudget)
			return { valid: false, reason: "ContextManifest context exceeds truncationBudget" };
		const typedManifest = m as unknown as ContextManifest;
		const computedDigest = computeManifestDigest(typedManifest);
		if (computedDigest.toLowerCase() !== typedManifest.digest.toLowerCase()) {
			return {
				valid: false,
				reason: `ContextManifest digest mismatch: expected ${computedDigest}, got ${typedManifest.digest}`,
			};
		}

		if (expectedContract) {
			const contractCheck = validateWorkContract(expectedContract);
			if (!contractCheck.valid) return { valid: false, reason: `Invalid expected contract: ${contractCheck.reason}` };
			if (
				canonicalizeJson(typedManifest.inputs ?? null) !== canonicalizeJson(contractInputReferences(expectedContract))
			)
				return { valid: false, reason: "ContextManifest inputs do not match contract inputArtifacts" };
			if (typedManifest.contractId !== expectedContract.id) {
				return {
					valid: false,
					reason: `ContextManifest contractId '${typedManifest.contractId}' does not match expected contract id '${expectedContract.id}'`,
				};
			}
			if (typedManifest.contractRevision !== expectedContract.revision) {
				return {
					valid: false,
					reason: `ContextManifest contractRevision '${typedManifest.contractRevision}' does not match expected revision '${expectedContract.revision}'`,
				};
			}
			if (typedManifest.contractDigest.toLowerCase() !== expectedContract.digest.toLowerCase()) {
				return {
					valid: false,
					reason: `ContextManifest contractDigest '${typedManifest.contractDigest}' does not match expected digest '${expectedContract.digest}'`,
				};
			}
		}

		return { valid: true, manifest: deepFreeze(typedManifest) };
	} catch (err: any) {
		return { valid: false, reason: `Malformed ContextManifest: ${err?.message ?? "unknown error"}` };
	}
}

export function validateCodeArtifactOutcome(args: {
	task: {
		id: string;
		attemptId: string;
		deviceId: string;
		botId: string;
		executionMode?: DeviceExecutionMode;
		contract?: DeviceWorkContract;
		contextManifest?: ContextManifest;
	};
	artifact?: unknown;
	executionCompleted?: unknown;
	artifactProduced?: unknown;
}): { valid: true; artifact?: DeviceArtifact } | { valid: false; reason: string } {
	try {
		const isCode = args.task.executionMode === "code" || args.task.contract?.executionMode === "code";
		if (
			(args.executionCompleted !== undefined && typeof args.executionCompleted !== "boolean") ||
			(args.artifactProduced !== undefined && typeof args.artifactProduced !== "boolean")
		)
			return { valid: false, reason: "executionCompleted and artifactProduced proofs must be boolean" };

		if (args.artifactProduced === true || args.artifact !== undefined) {
			if (args.executionCompleted !== true) {
				return {
					valid: false,
					reason: "Execution proof 'executionCompleted' must be true when artifact is produced",
				};
			}
			if (args.artifactProduced !== true) {
				return {
					valid: false,
					reason: "Artifact proof 'artifactProduced' must be true when artifact is provided",
				};
			}
			if (!args.artifact) {
				return {
					valid: false,
					reason: "Artifact proof 'artifactProduced' is true but no artifact was provided",
				};
			}

			const artifactRes = validateDeviceArtifact(args.artifact);
			if (!artifactRes.valid) {
				return { valid: false, reason: `Artifact validation failed: ${artifactRes.reason}` };
			}
			const art = artifactRes.artifact;

			if (isCode) {
				const proofError = codeArtifactProofError(art);
				if (proofError) return { valid: false, reason: proofError };
				if (!args.task.contract || !args.task.contextManifest)
					return { valid: false, reason: "Code artifact requires sealed task contract and manifest" };
				if (!art.inputTree || !TREE_HEX_REGEX.test(art.inputTree)) {
					return { valid: false, reason: "Code artifact requires 40-character hex inputTree" };
				}
				if (!art.outputTree || !TREE_HEX_REGEX.test(art.outputTree)) {
					return { valid: false, reason: "Code artifact requires 40-character hex outputTree" };
				}
				if (!art.baseline) {
					return { valid: false, reason: "Code artifact requires complete baseline" };
				}
			}

			if (art.producer.taskId !== args.task.id) {
				return {
					valid: false,
					reason: `Artifact producer taskId '${art.producer.taskId}' mismatch with task '${args.task.id}'`,
				};
			}
			if (art.producer.attemptId !== args.task.attemptId) {
				return {
					valid: false,
					reason: `Artifact producer attemptId '${art.producer.attemptId}' mismatch with task attempt '${args.task.attemptId}'`,
				};
			}
			if (art.producer.deviceId !== args.task.deviceId) {
				return {
					valid: false,
					reason: `Artifact producer deviceId '${art.producer.deviceId}' mismatch with task device '${args.task.deviceId}'`,
				};
			}
			if (art.producer.botId !== args.task.botId) {
				return {
					valid: false,
					reason: `Artifact producer botId '${art.producer.botId}' mismatch with task bot '${args.task.botId}'`,
				};
			}

			if (args.task.contract) {
				if (
					art.producer.contractDigest &&
					art.producer.contractDigest.toLowerCase() !== args.task.contract.digest.toLowerCase()
				) {
					return {
						valid: false,
						reason: `Artifact producer contractDigest '${art.producer.contractDigest}' mismatch with contract '${args.task.contract.digest}'`,
					};
				}
				if (args.task.contract.baseline) {
					if (!art.baseline) {
						return { valid: false, reason: "Artifact baseline missing on code task with baseline contract" };
					}
					if (art.baseline.repositoryId !== args.task.contract.baseline.repositoryId) {
						return {
							valid: false,
							reason: `Artifact baseline repositoryId '${art.baseline.repositoryId}' mismatch with contract '${args.task.contract.baseline.repositoryId}'`,
						};
					}
					if (art.baseline.commit.toLowerCase() !== args.task.contract.baseline.commit.toLowerCase()) {
						return {
							valid: false,
							reason: `Artifact baseline commit '${art.baseline.commit}' mismatch with contract '${args.task.contract.baseline.commit}'`,
						};
					}
				}
			}

			if (args.task.contextManifest && art.producer.manifestDigest) {
				if (art.producer.manifestDigest.toLowerCase() !== args.task.contextManifest.digest.toLowerCase()) {
					return {
						valid: false,
						reason: `Artifact producer manifestDigest '${art.producer.manifestDigest}' mismatch with manifest '${args.task.contextManifest.digest}'`,
					};
				}
			}

			return { valid: true, artifact: art };
		}

		if (isCode && args.artifactProduced === false && args.artifact !== undefined) {
			return { valid: false, reason: "Artifact provided while artifactProduced is false" };
		}

		return { valid: true };
	} catch (err: any) {
		return { valid: false, reason: `Malformed code artifact outcome: ${err?.message ?? "unknown error"}` };
	}
}
