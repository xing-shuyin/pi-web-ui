import type { DeviceDelivery, DeviceDeliveryArtifactRef, DeviceIntegration } from "../protocol.js";
import type { HubState, HubTask } from "./store.js";
import { artifactRefsMatch } from "./delivery-subject.js";
import { validateCodeArtifactOutcome, validateContextManifest, validateWorkContract } from "./work-contract.js";

function conflict(message: string): never {
	throw Object.assign(new Error(message), { status: 409 });
}

export function assertLatestContract(state: HubState, task: HubTask): void {
	const contract = task.contract;
	if (!contract) conflict("Artifact contract missing");
	for (const other of state.tasks) {
		if (other.accountId !== task.accountId || other.roomId !== task.roomId || other.contract?.id !== contract.id)
			continue;
		if (
			other.contract.revision > contract.revision ||
			(other.contract.revision === contract.revision && other.contract.digest !== contract.digest)
		)
			conflict("Artifact contract version is no longer authoritative");
	}
}
export function deriveArtifactSubject(
	state: HubState,
	task: HubTask,
	options?: { allowSuperseded?: boolean },
): DeviceDeliveryArtifactRef {
	if (
		task.status !== "completed" ||
		task.cancelRequested ||
		task.executionCompleted !== true ||
		task.artifactProduced !== true ||
		!task.contract ||
		!task.contextManifest ||
		!task.artifact ||
		task.contract.executionMode !== "code"
	)
		conflict("Completed code artifact required");
	const contract = validateWorkContract(task.contract);
	const manifest = validateContextManifest(task.contextManifest, task.contract);
	const artifact = validateCodeArtifactOutcome({
		task,
		artifact: task.artifact,
		executionCompleted: task.executionCompleted,
		artifactProduced: task.artifactProduced,
	});
	if (
		!contract.valid ||
		!manifest.valid ||
		!artifact.valid ||
		!artifact.artifact ||
		!task.artifact.baseline ||
		!task.artifact.inputTree ||
		!task.artifact.outputTree ||
		task.artifact.producer.contractDigest !== task.contract.digest ||
		task.artifact.producer.manifestDigest !== task.contextManifest.digest ||
		task.contextManifest.executionPolicy?.botRevision !== task.botRevision ||
		task.contextManifest.executionPolicy?.botId !== task.botId ||
		task.contextManifest.executionPolicy?.deviceId !== task.deviceId
	)
		conflict("Invalid sealed artifact evidence");
	if (!options?.allowSuperseded) assertLatestContract(state, task);
	return {
		artifactTaskId: task.id,
		attemptId: task.attemptId,
		artifactId: task.artifact.id,
		artifactDigest: task.artifact.digest,
		contractId: task.contract.id,
		contractRevision: task.contract.revision,
		contractDigest: task.contract.digest,
		manifestDigest: task.contextManifest.digest,
		baselineCommit: task.artifact.baseline.commit,
		repositoryId: task.artifact.baseline.repositoryId,
		inputTree: task.artifact.inputTree,
		outputTree: task.artifact.outputTree,
	};
}
export function assertDeliveryAuthority(state: HubState, delivery: DeviceDelivery): HubTask | undefined {
	if (!delivery.artifactRef) return undefined;
	const task = state.tasks.find(
		(t) =>
			t.id === delivery.artifactRef!.artifactTaskId &&
			t.accountId === delivery.accountId &&
			t.roomId === delivery.roomId &&
			t.conversationId === delivery.conversationId &&
			t.botId === delivery.botId,
	);
	if (!task || !artifactRefsMatch(delivery.artifactRef, deriveArtifactSubject(state, task)))
		conflict("Delivery artifact subject changed");
	return task;
}
export function isLegacyPublicationUnknown(integration: DeviceIntegration): boolean {
	return (
		!integration.publishIntent &&
		(integration.status === "applying" || !!integration.error?.startsWith("Apply failed; check target outcome:"))
	);
}
export function hasOpenPublication(integration: DeviceIntegration): boolean {
	return (
		!!integration.publishIntent &&
		((!!integration.publishStop && !integration.publishStop.stopConfirmed) ||
			(!integration.publishReceipt && !(integration.publishStop?.closed && integration.publishStop.stopConfirmed)))
	);
}
export function assertNoApplyingIntegration(
	state: HubState,
	accountId: string,
	roomId: string,
	conversationId?: string,
	contractId?: string,
): void {
	if (
		state.integrations.some(
			(i) =>
				i.accountId === accountId &&
				i.roomId === roomId &&
				(hasOpenPublication(i) || isLegacyPublicationUnknown(i)) &&
				((!conversationId && !contractId) ||
					(conversationId && i.conversationId === conversationId) ||
					(contractId && i.artifactRef?.contractId === contractId)),
		)
	)
		conflict("Integration apply freezes delivery, review and contract evidence");
}
