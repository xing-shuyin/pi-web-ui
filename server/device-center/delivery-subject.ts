import type { DeviceDelivery, DeviceDeliveryArtifactRef, DeviceReview } from "../protocol.js";

export function artifactRefsMatch(
	a: DeviceDeliveryArtifactRef | undefined,
	b: DeviceDeliveryArtifactRef | undefined,
): boolean {
	return (
		!!a &&
		!!b &&
		a.artifactTaskId === b.artifactTaskId &&
		a.attemptId === b.attemptId &&
		a.artifactId === b.artifactId &&
		a.artifactDigest === b.artifactDigest &&
		a.contractId === b.contractId &&
		a.contractRevision === b.contractRevision &&
		a.contractDigest === b.contractDigest &&
		a.manifestDigest === b.manifestDigest &&
		a.baselineCommit === b.baselineCommit &&
		a.repositoryId === b.repositoryId &&
		a.inputTree === b.inputTree &&
		a.outputTree === b.outputTree
	);
}
export function deliveryReviewMatches(delivery: DeviceDelivery | undefined, review: DeviceReview | undefined): boolean {
	if (
		!delivery ||
		!review ||
		delivery.id !== review.deliveryId ||
		delivery.accountId !== review.accountId ||
		delivery.roomId !== review.roomId ||
		delivery.conversationId !== review.conversationId
	)
		return false;
	if (delivery.artifactRef)
		return (
			review.artifactDigest === delivery.artifactRef.artifactDigest &&
			artifactRefsMatch(delivery.artifactRef, review.artifactRef)
		);
	return !review.artifactRef && !review.artifactDigest && !!delivery.commit && delivery.commit === review.commit;
}
