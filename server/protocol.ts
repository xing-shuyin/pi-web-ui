import type { NativeCliInheritModel } from "./engine-catalog.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface DeviceTaskActivity {
	phase: "model" | "tool" | "waiting";
	text?: string;
	toolName?: string;
}
export interface DeviceTaskProgress extends DeviceTaskActivity {
	taskId: string;
	botId: string;
	attemptId: string;
	sequence: number;
}

export interface DeviceTaskPlanReadyFrame {
	type: "task_plan_ready";
	taskId: string;
	botId: string;
	attemptId: string;
	plan: {
		state: "ready";
		steps: PlanStep[];
		summary?: string;
	};
}

export interface DeviceTaskPlanAckFrame {
	type: "task_plan_ack";
	taskId: string;
	botId: string;
	attemptId: string;
	accepted: boolean;
}

export type DeviceTaskEventKind =
	| "user_message"
	| "bot_request"
	| "bot_reply"
	| "worker_result"
	| "execution_started"
	| "execution_completed"
	| "execution_failed"
	| "execution_interrupted"
	| "attention_requested"
	| "attention_resolved"
	| "delivery_recorded"
	| "review_recorded"
	| "conversation_closed"
	| "task_updated";
export interface DeviceTaskEvent {
	id: string;
	sequence: number;
	type: DeviceTaskEventKind;
	taskId?: string;
	sourceId: string;
	createdAt: number;
	text?: string;
}
export interface DeviceTaskReportedProgress {
	taskId: string;
	botId: string;
	updatedAt: number;
	provenance: "bot_reported";
	constraints: string[];
	progress: string;
	blockers: string[];
	nextSteps: string[];
}
export interface DeviceTaskState {
	revision: number;
	objective: string;
	currentTaskId: string;
	phase: "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "closed";
	latestRequest?: { taskId: string; sourceId: string; text: string };
	blocker?: { attentionId: string; taskId: string; question: string };
	lastOutcome?: { taskId: string; status: "completed" | "failed" | "interrupted"; text?: string };
	decisions: {
		attentionId: string;
		messageId: string;
		taskId: string;
		question?: string;
		answer?: string;
		questionTruncated?: boolean;
		answerTruncated?: boolean;
	}[];
	artifacts: { deliveryId: string; taskId: string }[];
	reported?: DeviceTaskReportedProgress;
}
export interface DeviceTaskUpdateRequest {
	sourceBotId: string;
	parentTaskId: string;
	expectedRevision: number;
	constraints?: string[];
	progress?: string;
	blockers?: string[];
	nextSteps?: string[];
}
export interface DeviceTaskStateResponse {
	taskState: DeviceTaskState;
	events: DeviceTaskEvent[];
}

export interface DeviceTaskClaim {
	taskId: string;
	attemptId: string;
	botId: string;
	leaseToken?: string;
	leaseGeneration?: number;
}
export interface DeviceTaskClaimResult {
	taskId: string;
	attemptId: string;
	accepted: boolean;
	reason?: string;
}
export interface DeviceTaskLeaseRenew {
	taskId: string;
	attemptId: string;
	botId: string;
	leaseToken?: string;
	leaseGeneration?: number;
	activitySequence?: number;
	hasActivity: boolean;
}
export interface DeviceTaskLeaseResult {
	taskId: string;
	attemptId: string;
	accepted: boolean;
	reason?: string;
}

export type DeviceExecutionMode = "chat" | "code";

export interface DeviceArtifactProducer {
	deviceId: string;
	botId: string;
	taskId: string;
	attemptId: string;
	contractDigest?: string;
	manifestDigest?: string;
}

export interface DeviceArtifactBaseline {
	repositoryId: string;
	commit: string;
}

export interface DeviceArtifact {
	id: string;
	digest: string;
	producer: DeviceArtifactProducer;
	baseline?: DeviceArtifactBaseline;
	inputTree?: string;
	outputTree?: string;
	patchBase64?: string;
	patchSha256?: string;
	createdAt: number;
}

export interface DeviceWorkContractInput {
	id?: string;
	revision?: number;
	executionMode?: DeviceExecutionMode;
	goal?: string;
	constraints?: string[];
	acceptanceCriteria?: string[];
	baseline?: DeviceArtifactBaseline;
	inputArtifacts?: DeviceArtifact[];
}

export interface DeviceWorkContract {
	id: string;
	revision: number;
	digest: string;
	executionMode: DeviceExecutionMode;
	goal: string;
	constraints?: string[];
	acceptanceCriteria?: string[];
	baseline?: DeviceArtifactBaseline;
	inputArtifacts?: DeviceArtifact[];
	createdAt?: number;
}

export interface ContextManifest {
	version: 1;
	digest: string;
	contractId: string;
	contractRevision: number;
	contractDigest: string;
	executionPolicy?: { deviceId: string; botId: string; botRevision: number };
	context: unknown;
	taskState?: unknown;
	inputs?: unknown;
	policyRef?: string;
	truncationBudget?: number;
	createdAt: number;
}

export interface DeviceTaskEventFrame {
	type: "task_event";
	taskId: string;
	botId: string;
	attemptId: string;
	status: "running" | "completed" | "failed" | "interrupted";
	leaseToken?: string;
	leaseGeneration?: number;
	report?: string;
	error?: string;
	reportMetadata?: DeviceTaskReportMetadata;
	fingerprint?: string;
	artifact?: DeviceArtifact;
	executionCompleted?: boolean;
	artifactProduced?: boolean;
}
export type DeviceTaskResultRejectReasonCode = "terminal_conflict" | "attempt_expired" | "legacy_lease_missing";
export interface DeviceTaskResultAck {
	taskId: string;
	attemptId: string;
	status: "completed" | "failed" | "interrupted";
	fingerprint?: string;
	accepted: boolean;
	reason?: string;
	permanent?: boolean;
	reasonCode?: DeviceTaskResultRejectReasonCode;
	contractDigest?: string;
	manifestDigest?: string;
	artifactDigest?: string;
}
export interface DeviceTaskResultAckFrame extends DeviceTaskResultAck {
	type: "task_result_ack";
}

export type DeviceDeliveryCheckInput = {
	command: string;
	status: "passed" | "failed" | "not_run";
	result?: string;
	exitCode?: number;
};
export type DeviceDeliveryCheck = DeviceDeliveryCheckInput & { source: "bot_reported" };
export interface DeviceDeliveryArtifactRef {
	artifactTaskId: string;
	attemptId: string;
	artifactId: string;
	artifactDigest: string;
	contractId: string;
	contractRevision: number;
	contractDigest: string;
	manifestDigest: string;
	baselineCommit: string;
	repositoryId: string;
	inputTree: string;
	outputTree: string;
}
export interface DeviceReviewCriterionResult {
	criterionIndex: number;
	verdict: "met" | "not_met";
	evidence: string;
}
export interface DeviceDeliveryRequest {
	sourceBotId: string;
	parentTaskId: string;
	idempotencyKey: string;
	artifactTaskId?: string;
	repository?: string;
	baseCommit?: string;
	commit?: string;
	branch?: string;
	summary: string;
	checks: DeviceDeliveryCheckInput[];
	limitations?: string[];
}
export interface DeviceDelivery extends Omit<
	DeviceDeliveryRequest,
	"sourceBotId" | "parentTaskId" | "idempotencyKey" | "checks" | "limitations" | "repository" | "baseCommit"
> {
	repository: string;
	baseCommit: string;
	artifactRef?: DeviceDeliveryArtifactRef;
	acceptanceCriteria?: string[];
	id: string;
	conversationId: string;
	accountId: string;
	roomId: string;
	botId: string;
	taskId: string;
	checks: DeviceDeliveryCheck[];
	limitations: string[];
	createdAt: number;
}
export interface DeviceReviewRequest {
	sourceBotId?: string;
	parentTaskId?: string;
	idempotencyKey: string;
	deliveryId: string;
	commit?: string;
	artifactDigest?: string;
	integrationId?: string;
	verificationDigest?: string;
	criteriaResults?: DeviceReviewCriterionResult[];
	verdict: "accepted" | "changes_requested";
	summary: string;
}
export interface DeviceReview extends Pick<
	DeviceReviewRequest,
	| "deliveryId"
	| "commit"
	| "verdict"
	| "summary"
	| "artifactDigest"
	| "integrationId"
	| "verificationDigest"
	| "criteriaResults"
> {
	artifactRef?: DeviceDeliveryArtifactRef;
	id: string;
	conversationId: string;
	accountId: string;
	roomId: string;
	reviewer: { type: "human" | "bot"; id: string };
	createdAt: number;
}
export interface DeviceHumanAttention {
	id: string;
	taskId: string;
	kind: "answer" | "decision";
	question: string;
	createdAt: number;
}
export interface DeviceConversation {
	taskState?: DeviceTaskState;
	attention?: DeviceHumanAttention;
	closed?: boolean;
	sourceBotId?: string;
	sourceConversationId?: string;
	parentTaskId?: string;
	id: string;
	accountId: string;
	roomId: string;
	botId: string;
	deviceId: string;
	botRevision: number;
	name: string;
	rootTaskId: string;
	dispatchDepth: number;
	latestTaskId: string;
	createdAt: number;
	updatedAt: number;
	status: "queued" | "waiting" | "running" | "completed" | "failed" | "interrupted" | "closed";
	latestDelivery?: DeviceDelivery;
	latestReview?: DeviceReview;
	deliveryCount: number;
	reviewCount: number;
	deliverySummaryTruncated?: boolean;
	latestIntegration?: DeviceIntegration;
	integrationCount?: number;
}
export interface DeviceConversationListResponse {
	conversations: DeviceConversation[];
}
export interface DeviceConversationDetailResponse {
	conversation: DeviceConversation;
	deliveries: DeviceDelivery[];
	reviews: DeviceReview[];
	integrations?: DeviceIntegration[];
}
export interface DeviceDeliveryResponse {
	delivery: DeviceDelivery;
}
export interface DeviceReviewResponse {
	review: DeviceReview;
}

// Global Resource Leases & Room Lock Info

export interface RoomActiveLock {
	lockKey: string;
	roomId: string;
	taskId: string;
	botId: string;
	deviceId?: string;
	acquiredAt: number;
	expiresAt: number;
}

export interface RoomLockWaiter {
	taskId: string;
	roomId: string;
	botId: string;
	lockKeys: string[];
	queuedAt: number;
}

export interface RoomLockInfo {
	roomId: string;
	activeLocks: RoomActiveLock[];
	waitingQueue: RoomLockWaiter[];
}

export interface RoomTaskCreateInput {
	text?: string;
	targetBotId?: string;
	targetBotIds?: string[];
	resourceLocks?: string[];
	kind?: "message" | "request" | "reply";
	requestId?: string;
	parentTaskId?: string;
	idempotencyKey?: string;
	planOnly?: boolean;
	replyToMessageId?: string;
	executionMode?: DeviceExecutionMode;
	contract?: DeviceWorkContractInput | DeviceWorkContract;
	goal?: string;
	constraints?: string[];
	acceptanceCriteria?: string[];
	baseline?: DeviceArtifactBaseline;
	inputArtifacts?: DeviceArtifact[];
	policyRef?: string;
	truncationBudget?: number;
}

export interface BlackboardSection {
	id: string;
	title: string;
	content: string;
	updatedAt: number;
	updatedBy: { type: "human" | "bot"; id: string; name: string };
}

export interface GroupBlackboard {
	version: number;
	updatedAt: number;
	updatedBy: { type: "human" | "bot"; id: string; name: string };
	title?: string;
	content: string;
	sections?: Record<string, BlackboardSection>;
}

export interface DeviceTaskToolLifecycleFrame {
	type: "task_tool_lifecycle";
	taskId: string;
	botId: string;
	attemptId: string;
	sequence?: number;
	toolName: string;
	phase: "start" | "progress" | "end" | "failed";
	callId?: string;
	summary?: string;
	parametersPreview?: Record<string, unknown>;
	outputSnippet?: string;
	durationMs?: number;
}

export interface DeviceTaskJournalEntry {
	id: string;
	sequence: number;
	timestamp: number;
	taskId: string;
	botId: string;
	attemptId: string;
	type: "progress" | "tool_start" | "tool_progress" | "tool_end" | "tool_failed" | "status" | "error";
	phase?: "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
	toolName?: string;
	toolCallId?: string;
	summary?: string;
	output?: string;
	parametersPreview?: Record<string, unknown>;
	reason?: string;
	metadata?: Record<string, string | number | boolean>;
}

export interface DeviceTaskJournalPage {
	taskId: string;
	items: DeviceTaskJournalEntry[];
	nextCursor?: string;
	hasMore: boolean;
	totalEvents: number;
	truncated: boolean;
	droppedCount: number;
	cursorExpired?: boolean;
	corrupted?: boolean;
	journalUnavailable?: boolean;
}

export interface DeviceTaskReportLocation {
	role: "hub" | "device";
	reportRef: string;
}

export interface DeviceTaskReportMetadata {
	sha256?: string;
	totalBytes: number;
	missing: boolean;
	rejected: boolean;
	uploadPending: boolean;
	publicError?: "report_quota_exceeded" | "report_missing" | "report_upload_pending";
}

export interface DeviceTaskReportMeta {
	taskId: string;
	attemptId: string;
	roomId: string;
	accountId: string;
	createdAt: number;
	updatedAt: number;
	totalBytes: number;
	totalChunks: number;
	receivedChunks: number;
	storageLocation: DeviceTaskReportLocation;
	quotaLimit: number;
	quotaExceeded: boolean;
	rejected: boolean;
	complete: boolean;
	sha256?: string;
	uploadPending?: boolean;
	missing?: boolean;
	publicError?: DeviceTaskReportMetadata["publicError"];
}

export interface DeviceTask {
	id: string;
	roomId: string;
	accountId: string;
	deviceId: string;
	botId: string;
	botName?: string;
	deviceName?: string;
	text: string;
	status: "queued" | "waiting" | "running" | "completed" | "failed" | "interrupted";
	executionMode?: DeviceExecutionMode;
	contract?: DeviceWorkContract;
	contextManifest?: ContextManifest;
	artifact?: DeviceArtifact;
	executionCompleted?: boolean;
	artifactProduced?: boolean;
	resourceLocks?: string[];
	blockReason?: DeviceTaskBlockReason;
	blockReasonDetail?: string;
	createdAt: number;
	updatedAt: number;
	attemptId: string;
	parentTaskId?: string;
	conversationId?: string;
	queuedReason?: string;
	interruptedReason?: string;
	report?: string;
	attenuatedTools?: string[];
	dependsOnTaskId?: string;
}

export interface HubTask {
	id: string;
	attemptId: string;
	roomId: string;
	accountId: string;
	deviceId: string;
	botId: string;
	botRevision: number;
	text: string;
	status: "queued" | "waiting" | "running" | "completed" | "failed" | "interrupted";
	createdAt: number;
	updatedAt: number;
	executionMode?: DeviceExecutionMode;
	contract?: DeviceWorkContract;
	contextManifest?: ContextManifest;
	artifact?: DeviceArtifact;
	executionCompleted?: boolean;
	artifactProduced?: boolean;
	sourceBotId?: string;
	sourceConversationId?: string;
	conversationId?: string;
	parentTaskId?: string;
	rootTaskId?: string;
	dispatchDepth?: number;
	dispatchCount?: number;
	kind?: "message" | "request" | "reply" | "result";
	requestId?: string;
	resultOfTaskId?: string;
	resume?: boolean;
	planOnly?: boolean;
	resourceLocks?: string[];
	blockReason?: DeviceTaskBlockReason;
	blockReasonDetail?: string;
	report?: string;
	error?: string;
	reportMetadata?: DeviceTaskReportMetadata;
	cancelRequested?: boolean;
	stopConfirmed?: boolean;
	outcomeFingerprint?: string;
	outcomeCanonicalFingerprint?: string;
	terminalAcceptedLeaseGeneration?: number;
	leaseToken?: string;
	leaseGeneration?: number;
	lastHeartbeatAt?: number;
	recoveryUntil?: number;
	attenuatedTools?: string[];
	dependsOnTaskId?: string;
	[key: string]: unknown;
}

export interface DeviceTaskDetails {
	task: DeviceTask;
	reportMeta?: DeviceTaskReportMeta;
	latestProgress?: DeviceTaskProgress;
	interactionCount: number;
	interactions: {
		id: string;
		kind: string;
		question?: string;
		resolved: boolean;
		decision?: string;
	}[];
	deliveries: {
		id: string;
		commit?: string;
		artifactRef?: DeviceDeliveryArtifactRef;
		branch?: string;
		summary: string;
		passed: boolean;
		reportedCheckCount?: number;
	}[];
	journalUnavailable?: boolean;
}

export type DeviceIntegrationStatus =
	| "preparing"
	| "prepared"
	| "conflict"
	| "verifying"
	| "verified"
	| "applying"
	| "applied"
	| "cancelling"
	| "failed"
	| "cancelled";

export interface DeviceIntegrationValidationCommand {
	command: string;
	status: "pending" | "running" | "passed" | "failed";
	exitCode?: number;
	output?: string;
}

export interface DeviceIntegrationVerificationPlan {
	commands: string[];
	digest: string;
	authorizedByAccountId: string;
	authorizedAt: number;
}
export interface DeviceIntegrationVerificationResult {
	command: string;
	status: "passed" | "failed";
	exitCode: number;
	outputDigest: string;
	outputPreview: string;
}
export interface DeviceIntegrationVerificationFacts {
	planDigest: string;
	artifactDigest?: string;
	materializedCommit: string;
	treeBefore: string;
	treeAfter: string;
	results: DeviceIntegrationVerificationResult[];
}
export interface DeviceIntegrationVerification extends DeviceIntegrationVerificationFacts {
	digest: string;
	verifiedAt: number;
}
export type DeviceGitObjectFormat = "sha1" | "sha256";
export interface DevicePublishIntentFacts {
	version: 1;
	id: string;
	accountId: string;
	roomId: string;
	conversationId: string;
	integrationId: string;
	targetDeviceId: string;
	targetBotId: string;
	targetBotRevision: number;
	actor: { accountId: string; botId?: string; botRevision?: number; botDeviceId?: string; taskId?: string };
	repositoryId: string;
	objectFormat: DeviceGitObjectFormat;
	targetRef: string;
	expectedOld: string;
	preparedTree: string;
	materializedCommit: string;
	createdAt: number;
	delivery: { id: string; commit?: string; artifactRef?: DeviceDeliveryArtifactRef };
	review: DeviceReview;
	verificationPlan: DeviceIntegrationVerificationPlan;
	verification: DeviceIntegrationVerification;
}
export interface DevicePublishIntent extends DevicePublishIntentFacts {
	digest: string;
	candidateSha: string;
}
export interface DevicePublishReceipt {
	intentId: string;
	intentDigest: string;
	candidateSha: string;
	outcome: "applied";
	proof: "cas_exit" | "target_exact" | "target_descendant";
	observedAt: number;
	targetSha?: string;
}
export interface DevicePublishObservation {
	intentId: string;
	intentDigest: string;
	candidateSha: string;
	observedAt: number;
	target: "candidate" | "descendant" | "expected_old" | "other" | "missing" | "unknown";
	targetSha?: string;
	phase: "absent" | "prepared" | "cas_started" | "cas_rejected" | "applied" | "closed" | "unknown";
	retryable: boolean;
	error?: string;
}
export interface DevicePublishStop {
	intentId: string;
	intentDigest: string;
	candidateSha: string;
	closed: boolean;
	stopConfirmed: boolean;
	pastEffect: "applied" | "not_applied" | "unknown";
	fencedAt: number;
	stoppedAt?: number;
}
export interface DevicePublicationResult {
	status: "applied" | "pending" | "cancelled";
	publishReceipt?: DevicePublishReceipt;
	publishObservation?: DevicePublishObservation;
	publishStop?: DevicePublishStop;
	cleanupPending?: boolean;
}
export interface DeviceIntegrationResumeRequest {
	intentId: string;
	intentDigest: string;
	candidateSha: string;
}
export interface DeviceIntegration {
	id: string;
	accountId: string;
	roomId: string;
	conversationId: string;
	deliveryId: string;
	commit?: string;
	reviewId?: string;
	artifactRef?: DeviceDeliveryArtifactRef;
	materializedCommit?: string;
	preparedTree?: string;
	objectFormat?: DeviceGitObjectFormat;
	repositoryId?: string;
	publishIntent?: DevicePublishIntent;
	publishReceipt?: DevicePublishReceipt;
	publishObservation?: DevicePublishObservation;
	publishStop?: DevicePublishStop;
	verificationPlan?: DeviceIntegrationVerificationPlan;
	verification?: DeviceIntegrationVerification;
	targetBotId: string;
	targetBotRevision: number;
	targetDeviceId?: string;
	targetBranch: string;
	expectedTargetSha: string;
	newCommitSha?: string;
	status: DeviceIntegrationStatus;
	conflicts?: string[];
	diff?: string;
	validationCommands: DeviceIntegrationValidationCommand[];
	error?: string;
	cleanupPending?: boolean;
	verificationMayBeRunning?: boolean;
	currentOpId?: string;
	createdAt: number;
	updatedAt: number;
}

export interface DeviceIntegrationPrepareRequest {
	deliveryId: string;
	targetBotId: string;
	targetBranch?: string;
	idempotencyKey?: string;
}

export interface DeviceIntegrationVerifyRequest {
	commands: string[];
}

export interface DeviceIntegrationApplyRequest {
	expectedTargetSha: string;
}

export interface DeviceIntegrationResponse {
	integration: DeviceIntegration;
}

export interface DeviceIntegrationListResponse {
	integrations: DeviceIntegration[];
	canResumePublication?: boolean;
}

export type QueueMode = "all" | "one-at-a-time";

export type ContextCategory =
	"systemPrompt" | "memoryFiles" | "tools" | "skills" | "toolResults" | "messages" | "other";
export interface ContextCategoryUsage {
	category: ContextCategory;
	tokens: number;
}

export interface UiTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface UiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface UiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
}

export interface UiImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

export interface UiBashBlock {
	type: "bash";
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
}

export type UiContentBlock =
	UiTextBlock | UiThinkingBlock | UiToolCallBlock | UiImageBlock | UiBashBlock | { type: string; [k: string]: unknown };

export interface UiMessage {
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	durationMs?: number;
	model?: string;
	provider?: string;
	usageCost?: number;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	details?: unknown;
	tokensBefore?: number;
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
	vision: boolean;
}

export type ServiceSupervisor = "launchd" | "systemd" | "windows-watchdog";

export interface UiServiceInfo {
	name: string;
	supervisor: ServiceSupervisor;
}

export interface UiHostMetrics {
	cpuPercent: number | null;
	memoryPercent: number;
}

export interface AgentEngineCapabilities {
	remoteSsh: boolean;
	sandboxes: boolean;
	workspaceRoots: boolean;

	conversationRef: boolean;
	pageRef: boolean;
	presentFiles: boolean;

	planMode: boolean;
	delegateMode: boolean;
	subagents: boolean;

	toolPromptOverride: boolean;
	lazyTools: boolean;
	softCap: boolean;

	treeFork: boolean;
	messageEdit: boolean;
	steer?: boolean;
	ephemeralChat?: boolean;
}

export type EngineId = import("./engine-catalog.js").BuiltinEngineId;

export interface EngineStatus {
	id: string;
	installed: boolean;
	packageName?: string;
	version?: string;
	latestVersion?: string | null;
	hasUpdate?: boolean;
	updating?: boolean;
	uninstalling?: boolean;
}

export interface UiState {
	nativeCli?: NativeCliConversation;
	sharedConversation?: { owner: string; conversationId: string; readOnly?: boolean } | null;
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	engineCapabilities?: AgentEngineCapabilities;
	workspaceRoots?: string[];
	homeDir?: string;
	desktopDir?: string;
	conversationId: string;
	isEphemeral?: boolean;
	sandbox?: SandboxInfo | null;
	worktree?: WorktreeInfo | null;
	rev: number;
	messages: UiMessage[];
	historyStart?: number;
	historyTotal?: number;
	historyGeneration?: string;
	streamingMessage: UiMessage | null;
	isStreaming: boolean;
	completionPending?: boolean;
	turnTiming?: { startedAt: number; finishedAt?: number } | null;
	model: UiModelInfo | null;
	thinkingLevel: string;
	agentPreset?: { id: string; name: string; locked: boolean } | null;
	permission?: string | null;
	availableThinkingLevels: string[];
	queue: {
		steering: string[];
		followUp: string[];
		entries?: {
			steering: QueuedPromptItem[];
			followUp: QueuedPromptItem[];
		};
	};
	errorMessage?: string;
	retry?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
	} | null;
	compaction?: {
		reason: string;
		startedAt: number;
	} | null;
	pendingQuestion?: UiPendingQuestion | null;
	actionSuggestions?: UiActionSuggestion[] | null;
	pendingApproval?: UiToolApproval | null;
	pendingApprovals?: UiToolApproval[];
	subagentHandoffs?: Array<{ fromRunId: string; toRunId: string; timestamp: number }>;
	plan?: PlanState | null;
	planMode?: boolean;
	delegateMode?: boolean;
	delegateConvId?: string | null;
	draft?: { text: string; ts: number } | null;
	tools: string[];
	version: number;
	piConfigured: boolean;
	piAgentInstalled: boolean;
	stats: {
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextUsage: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
			estimated?: boolean;
			softCap?: number | null;
			categories?: ContextCategoryUsage[];
		};
	};
}

export interface CommandDef {
	name: string;
	command: string;
	cwd?: string;
}

export type NativeCliPreset = import("./engine-catalog.js").NativeCliEngineId | "custom";

export interface NativeCliDiscoveryResult {
	target: "local" | "ssh";
	cwd: string;
	clis: Array<{ preset: NativeCliPreset; available: boolean; executable?: string; error?: string }>;
	persistence?: { available: boolean; error?: string };
}

export interface NativeCliStatus {
	phase:
		"starting" | "running" | "working" | "waiting_input" | "waiting_approval" | "disconnected" | "exited" | "error";
	updatedAt: number;
	lastActivityAt?: number;
	activity?: "working" | "idle" | "waiting_input" | "waiting_approval";
	sessionId?: string;
	resumable?: boolean;
	persistent?: boolean;
	nativeEvents?: boolean;
	exitCode?: number | null;
	error?: string;
}

export interface NativeCliConversation {
	config: NativeCliConfig;
	terminalId: string;
	status?: NativeCliStatus;
}

export interface NativeCliConfig {
	preset: NativeCliPreset;
	executable?: string;
	args?: string[];
	keepAlive?: boolean;
	model?: { provider: string; id: string };
}

export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	running: boolean;
	exitCode: number | null;
	command?: CommandDef;
	nativeCli?: NativeCliConfig;
	agentBash?: boolean;
	ownerKind?: "client" | "conversation";
}

export interface SlashCommandInfo {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	source: "builtin" | "extension" | "prompt" | "skill" | "plugin";
}

export interface TextQuote {
	text: string;
	messageId: string;
	role: string;
	sessionId?: string;
}

export interface PromptAttachment {
	path: string;
	mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote" | "canvas";
	quote?: TextQuote;
	conversationId?: string;
	sessionPath?: string;
	lines?: { start: number; end: number };
	imageData?: string;
	fileData?: string;
	uploadPath?: string;
	mimeType?: string;
	name?: string;
	size?: number;
}

export interface QueuedPromptItem {
	id: string;
	text: string;
	attachments?: PromptAttachment[];
	createdAt?: number;
}

export type CanvasEngineId = "pi" | "dsh" | "codex" | "claude" | "durable";
export type CanvasNodeRole =
	| "architect"
	| "coder"
	| "reviewer"
	| "tester"
	| "devops"
	| "custom"
	| "trigger"
	| "planner"
	| "researcher"
	| "writer"
	| "analyst"
	| "condition"
	| "ai_judge"
	| "loop"
	| "human"
	| "knowledge"
	| "tool"
	| "code"
	| "api"
	| "merge"
	| "memory"
	| "evaluator"
	| "end"
	| "subflow"
	| "cron"
	| "webhook"
	| "transform"
	| "pstack"
	| "skill";
export type CanvasNodeStatus =
	"idle" | "queued" | "running" | "waiting_approval" | "done" | "error" | "paused" | "skipped" | "cancelled";

export interface CanvasArtifact {
	runId: string;
	attempt: number;
	summary: string;
	text?: string;
	files?: string[];
	patchPath?: string;
	baseCommit?: string;
	workspace?: {
		repoRoot: string;
		baseCommit: string;
		patchPath: string;
		outputTree: string;
		layers: { id: string; patchPath: string; sha256: string }[];
	};
	cwd?: string;
	createdAt: number;
}

export interface CanvasRun {
	id: string;
	graphRev: number;
	startedAt: number;
	finishedAt?: number;
	scope: "all" | "node";
	nodeId?: string;
	error?: string;
}
export type CanvasEdgeType =
	"handoff" | "review" | "parallel" | "condition_true" | "condition_false" | "loop_back" | "approve" | "reject";

export type CanvasNodeLogKind =
	"prompt" | "text" | "tool" | "error" | "steer" | "handoff" | "review" | "system" | "done";

/** Localize server-owned Canvas messages at the viewing client; keep text as a legacy fallback. */
export interface CanvasMessage {
	key: string;
	vars?: Record<string, string | number>;
}

export interface CanvasNodeLogEntry {
	id: string;
	ts: number;
	kind: CanvasNodeLogKind;
	text: string;
	message?: CanvasMessage;
	toolName?: string;
}

export interface CanvasNode {
	id: string;
	title: string;
	role: CanvasNodeRole;
	x: number;
	y: number;
	width?: number;
	height?: number;
	engine: CanvasEngineId;
	model: string;
	thinkingLevel?: string;
	cwd: string;
	useWorktree: boolean;
	systemPromptOverride?: string;
	instruction?: string;
	config?: Record<string, string | number | boolean | undefined>;
	status: CanvasNodeStatus;
	activeConvId?: string;
	currentAction?: string;
	currentActionMessage?: CanvasMessage;
	lastOutputSummary?: string;
	aiVerdict?: boolean;
	error?: string;
	errorMessage?: CanvasMessage;
	runId?: string;
	attempt?: number;
	artifact?: CanvasArtifact;
	actualEngine?: CanvasEngineId;
	actualModel?: string;
}

export type CanvasPortKey = string;

export interface CanvasEdge {
	id: string;
	sourceNodeId: string;
	targetNodeId: string;
	type: CanvasEdgeType;
	sourcePort?: CanvasPortKey;
	targetPort?: CanvasPortKey;
	label?: string;
	maxLoopRetries?: number;
	currentLoopCount?: number;
	lastHandoffSummary?: string;
	runId?: string;
	active?: boolean;
}

export interface CanvasGraph {
	id: string;
	name: string;
	viewport: { x: number; y: number; zoom: number };
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	status: "idle" | "running" | "paused" | "completed" | "error" | "blocked" | "waiting_approval";
	run?: CanvasRun;
	executionMode?: "real" | "simulate";
	createdAt: number;
	updatedAt: number;
	rev?: number;
}

export interface CanvasCustomCard {
	id: string;
	title: string;
	role: CanvasNodeRole;
	instruction?: string;
	systemPrompt?: string;
	model?: string;
	engine?: CanvasEngineId;
	config?: Record<string, string | number | boolean>;
	updatedAt: number;
}

export interface CanvasGraphSummary {
	id: string;
	name: string;
	nodeCount: number;
	edgeCount: number;
	updatedAt: number;
}

export type ClientMessage =
	| { type: "hello"; clientId: string; protocolVersion?: number; locale?: string }
	| { type: "canvas_list" }
	| { type: "canvas_load"; id: string; requestId?: string }
	| { type: "canvas_save"; graph: CanvasGraph; baseRev?: number; requestId?: string }
	| { type: "canvas_delete"; id: string }
	| { type: "canvas_run_all"; graphId: string; initialPrompt?: string; cwd?: string }
	| { type: "canvas_run_node"; graphId: string; nodeId: string; prompt?: string }
	| { type: "canvas_stop_node"; graphId: string; nodeId: string }
	| { type: "canvas_stop_all"; graphId: string }
	| { type: "canvas_steer_node"; graphId: string; nodeId: string; message: string }
	| { type: "canvas_review_node"; graphId: string; nodeId: string; decision: "approve" | "reject"; comment?: string }
	| { type: "canvas_reset_status"; graphId: string }
	| { type: "canvas_cards" }
	| { type: "canvas_card_delete"; id: string }
	| { type: "canvas_get_log"; graphId: string; nodeId: string }
	| { type: "canvas_clear_log"; graphId: string; nodeId: string }
	| { type: "set_locale"; locale: string }
	| { type: "get_commands" }
	| {
			type: "prompt";
			text: string;
			targetConversationId?: string;
			queue?: boolean;
			steer?: boolean;
			attachments?: PromptAttachment[];
	  }
	| {
			type: "queue_remove";
			kind: "steer" | "followUp";
			text: string;
			index?: number;
			id?: string;
	  }
	| {
			type: "draft_update";
			sessionId: string;
			text: string;
			ts: number;
	  }
	| {
			type: "terminal_create";
			terminalId: string;
			ownerKind?: "client" | "conversation";
			nativeCli?: NativeCliConfig;
			title?: string;
			locale?: string;
			cwd: string;
			cols: number;
			rows: number;
			conversationId?: string;
			agentBash?: boolean;
	  }
	| {
			type: "terminal_cli_paste";
			requestId: string;
			terminalId: string;
			conversationId?: string;
			ownerKind?: "client" | "conversation";
			data: string;
			attachments?: PromptAttachment[];
	  }
	| {
			type: "terminal_cli_control";
			requestId: string;
			terminalId: string;
			conversationId: string;
			ownerKind: "conversation";
			action: "detach" | "reconnect" | "stop";
	  }
	| {
			type: "terminal_attach";
			terminalId: string;
			cols: number;
			rows: number;
			conversationId?: string;
			ownerKind?: "client" | "conversation";
	  }
	| {
			type: "terminal_input";
			terminalId: string;
			data: string;
			conversationId?: string;
			ownerKind?: "client" | "conversation";
	  }
	| {
			type: "terminal_resize";
			terminalId: string;
			cols: number;
			rows: number;
			conversationId?: string;
			ownerKind?: "client" | "conversation";
	  }
	| { type: "terminal_kill"; terminalId: string; conversationId?: string; ownerKind?: "client" | "conversation" }
	| {
			type: "rename_terminal";
			terminalId: string;
			title: string;
			conversationId?: string;
			ownerKind?: "client" | "conversation";
	  }
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
			conversationId?: string;
	  }
	| { type: "extensions_reload" }
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	| { type: "abort_bash"; conversationId?: string }
	| { type: "retry_last" }
	| { type: "kill_background_server"; port?: number; taskId?: string }
	| { type: "kill_background_servers" }
	| { type: "list_bg_servers" }
	| { type: "project_scripts"; cwd?: string }
	| { type: "start_bg_script"; script: string; cwd?: string }
	| { type: "restart_bg_job"; taskId: string }
	| { type: "set_bg_keep"; port: number; keep: boolean }
	| { type: "clean_bg_leftovers"; minutes?: number }
	| { type: "search_files"; reqId: number; query: string; scope?: string }
	| { type: "search_sessions"; reqId: number; query: string }
	| {
			type: "load_earlier_messages";
			count?: number;
			all?: boolean;
			conversationId?: string;
			beforeId?: string;
			before?: number;
			historyGeneration?: string;
	  }
	| { type: "scm_status"; reqId: number }
	| { type: "scm_history"; reqId: number }
	| { type: "scm_filediff"; reqId: number; path: string }
	| { type: "scm_commit"; reqId: number; hash: string }
	| { type: "scm_commitmsg"; reqId: number }
	| { type: "new_chat"; preset?: string; ephemeral?: boolean; requestId?: string; independent?: boolean }
	| { type: "new_cli_chat"; config: NativeCliConfig; cwd?: string; requestId?: string }
	| { type: "open_shared_conversation"; owner: string; id: string; readOnly?: boolean }
	| { type: "delete_message"; messageId: string; conversationId?: string }
	| {
			type: "edit_message";
			messageId: string;
			text: string;
			attachments?: PromptAttachment[];
	  }
	| {
			type: "fork_session";
			messageId: string;
			position?: "before" | "at";
			conversationId?: string;
	  }
	| {
			type: "rollback_session";
			messageId: string;
			conversationId?: string;
			restoreWorkspace?: boolean;
	  }
	| { type: "get_state" }
	| { type: "get_tool_info"; name: string }
	| { type: "get_tool_prompt"; name: string }
	| { type: "list_sessions"; path?: string; limit?: number }
	| { type: "switch_session"; path: string; sessionId?: string; independent?: boolean }
	| { type: "switch_conversation"; id: string }
	| { type: "take_over_conversation"; owner: string; id: string }
	| { type: "peek_elsewhere_question"; owner: string; id: string }
	| { type: "navigate_question"; id: string }
	| { type: "list_projects" }
	| { type: "list_files"; path?: string }
	| { type: "read_file"; path: string }
	| { type: "write_file"; path: string; text: string }
	| { type: "upload_file"; dirPath: string; name: string; data: string; uploadId?: string }
	| { type: "file_create"; dir: string; name: string; kind: "file" | "dir" }
	| { type: "file_rename"; path: string; newName: string }
	| { type: "file_delete"; path: string }
	| { type: "file_copy"; src: string; destDir: string; move?: boolean }
	| { type: "file_reveal"; path: string }
	| { type: "file_open_default"; path: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_default_model"; modelId: string }
	| { type: "clear_default_model" }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	| { type: "make_dir"; path: string; setAsCwd?: boolean }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	| { type: "tui_overlay_input"; id: number; data: string }
	| { type: "tui_overlay_resize"; id: number; cols: number; rows: number }
	| { type: "tui_overlay_cancel"; id: number }
	| { type: "check_update" }
	| { type: "check_updates_all"; force?: true }
	| { type: "check_plugin_updates" }
	| { type: "restart_service" }
	| { type: "switch_engine"; engine: EngineId }
	| { type: "check_engines"; force?: boolean }
	| { type: "update_engine"; engineId: string }
	| { type: "uninstall_engine"; engineId: string }
	| { type: "install_pi_agent" }
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	| { type: "provider_oauth_start"; provider: string }
	| { type: "provider_oauth_reply"; flowId: string; promptId: string; value: string }
	| { type: "provider_oauth_cancel"; flowId: string }
	| { type: "list_provider_oauth_flows" }
	| { type: "provider_oauth_logout"; provider: string }
	| { type: "clear_provider_api_key"; provider: string }
	| { type: "list_provider_keys" }
	| { type: "add_provider_key"; provider: string; apiKey: string; name?: string }
	| { type: "activate_provider_key"; provider: string; keyName: string }
	| { type: "remove_provider_key"; provider: string; keyName: string }
	| { type: "list_models_config" }
	| { type: "reload_models_config" }
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	| { type: "delete_model_config"; providerId: string }
	| { type: "list_providers" }
	| {
			type: "fetch_models";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			api?: string;
			providerId?: string;
	  }
	| {
			type: "test_model_connection";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			api?: string;
			providerId?: string;
	  }
	| { type: "refresh_provider_models"; providerId: string; reqId: number }
	| { type: "refresh_builtin_models"; reqId: number }
	| { type: "append_builtin_model"; providerId: string; model: UiModelConfigEntry; reqId: number }
	| { type: "clone_provider"; provider: string; reqId: number }
	| {
			type: "enrich_models";
			reqId: number;
			ids: string[];
			hints?: Record<string, string>;
	  }
	| {
			type: "abort_enrich_models";
			reqId?: number;
	  }
	| {
			type: "set_goal";
			goal: string;
			reviewModel?: string;
			maxRounds: number;
			locked: boolean;
			execModel?: string;
	  }
	| { type: "clear_goal" }
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			execModel?: string;
	  }
	| { type: "get_settings" }
	| {
			type: "set_settings";
			promptMode?: "append" | "replace";
			customSystemPrompt?: string;
			promptTemplate?: string;
			promptOverrides?: Record<string, string>;
			promptDisabled?: string[];
			toolPromptOverrides?: Record<string, UiToolPromptOverride>;
			disabledSkills?: string[];
			disabledExtensions?: string[];
			disabledAgentTools?: string[];
			toolOnDemandTools?: string[];
			disabledPluginTools?: string[];
			disabledPlugins?: string[];
			nativeCliInheritModel?: NativeCliInheritModel;
			terminalToolsEnabled?: boolean;
			terminalBash?: boolean;
			terminalBashIdleMs?: number;
			terminalBashMaxForegroundMs?: number;
			toolWatchdogTimeoutMs?: number;
			readDirEnabled?: boolean;
			bgAutoCleanupMin?: number;
			toolLazyLoading?: boolean;
			codemodeMode?: "on" | "only";
			codemodeInlineBudget?: number;
			questionnaireEnabled?: boolean;
			questionPresentation?: "queue" | "all" | "manual";
			toolApprovalPresentation?: "queue" | "all" | "manual";
			questionTimeoutSeconds?: number;
			toolApprovalEnabled?: boolean;
			parallelReminderEnabled?: boolean;
			goalModeEnabled?: boolean;
			thinkingWrap?: boolean;
			toolsWrap?: boolean;
			toolImagesEnabled?: boolean;
			keepRecentMessages?: number;
			reversePagination?: boolean;
			showForkedParentSessions?: boolean;
			retainFinishedConversations?: boolean;
			openRecentSessionOnProjectSwitch?: boolean;
			skillsFullText?: string[];
			skillsCatalogMaxDesc?: number;
			skillsCatalogShowLocation?: boolean;
			skillsCatalogBudget?: number;
			skillsMaxFileBytes?: number;
			skillsFullTextMaxBytes?: number;
			subagentDefaultModel?: string | null;
			subagentMaxDepth?: number;
			subagentAutoWakeMaxTurns?: number;
			chatUploadMaxMb?: number;
			workspaceUploadMaxMb?: number;
			folderUploadMaxMb?: number;
			visionBridgeEnabled?: boolean;
			visionBridgeModel?: string | null;
			visionBridgePromptMode?: "append" | "replace";
			visionBridgePrompt?: string;
			scmCommitMsgPromptMode?: "append" | "replace";
			scmCommitMsgPrompt?: string;
			quickAskEnabled?: boolean;
			quickAskModel?: string | null;
			quickAskThinking?: ThinkingLevel;
			quickAskSystemPrompt?: string;
			quickAskExplainPrompt?: string;
			quickAskTranslateEnabled?: boolean;
			quickAskTranslateTarget?: QuickAskTranslateTarget;
			quickAskTranslateStyle?: QuickAskTranslateStyle;
			quickAskTranslatePrompt?: string;
			quickAskReferenceMenus?: boolean;
			quickAskConversationScope?: "recent" | "full";
			quickAskFolderScope?: "listing" | "content";
			planModePromptMode?: "append" | "replace";
			planModePrompt?: string;
			reviewPrompt?: string;
			reviewDisabledSkills?: string[];
			steeringMode?: QueueMode;
			followUpMode?: QueueMode;
			retryMaxAttempts?: number;
			softCapTokens?: number;
			softCapByModel?: Record<string, number>;
			autoCompactionInstructions?: string;
			disabledMarkers?: string[];
			uiLayout?: UiLayoutPrefs;
			quickPhrases?: string[];
			quickPhrasesEnabled?: boolean;
			minimalNewChat?: boolean;
			preserveDraftAcrossConversations?: boolean;
			quickPhrasesSeeded?: boolean;
	  }
	| { type: "plugin_message"; pluginId: string; payload: unknown }
	| { type: "plugins_reload" }
	| { type: "plugin_dom_consent"; pluginId: string; granted: boolean }
	| { type: "plugin_dom_consent_response"; id: string; ok: boolean }
	| { type: "save_preset"; name: string }
	| { type: "save_subagent_template"; template: UiSubagentTemplate }
	| { type: "delete_subagent_template"; name: string }
	| { type: "save_approval_rule"; rule: UiApprovalRule }
	| { type: "save_approval_rules"; rules: UiApprovalRule[] }
	| { type: "delete_approval_rule"; id: string }
	| { type: "reset_builtin_approval_rule"; id: string }
	| {
			type: "save_mcp_server";
			server: UiMcpServer;
			prevName?: string;
			prevScope?: McpScope;
	  }
	| { type: "delete_mcp_server"; name: string; scope: McpScope }
	| { type: "toggle_mcp_server"; name: string; scope: McpScope; enabled: boolean }
	| { type: "reload_mcp" }
	| { type: "mcp_oauth_start"; reqId: string; name: string; scope: McpScope }
	| { type: "mcp_oauth_finish"; reqId: string; id: string; redirectUrl: string }
	| { type: "mcp_oauth_status"; reqId: string; id: string }
	| { type: "mcp_oauth_cancel"; reqId: string }
	| {
			type: "install_skill";
			name: string;
			scope: "global" | "project";
			content: string;
	  }
	| {
			type: "uninstall_skill";
			name: string;
			scope: "global" | "project";
	  }
	| {
			type: "fetch_mcp_market";
			source?: string;
			query?: string;
			page?: number;
			refresh?: boolean;
	  }
	| {
			type: "fetch_skill_market";
			repo?: string;
			refresh?: boolean;
	  }
	| {
			type: "fetch_skill_content";
			repo: string;
			skillId: string;
	  }
	| { type: "plugin_settings"; pluginId: string; values: Record<string, unknown> }
	| {
			type: "plugin_catalog_add";
			entry: { source: string; id?: string; name?: string; description?: string; icon?: string };
	  }
	| { type: "plugin_catalog_remove"; id: string }
	| {
			type: "plugin_job";
			jobId: string;
			action: "install" | "update" | "uninstall";
			id: string;
			source?: string;
			build?: boolean;
			noBuild?: boolean;
	  }
	| { type: "plugin_job_cancel"; jobId: string }
	| { type: "plugin_install_inspect"; requestId: string; source: string; explicitId?: string; force?: boolean }
	| { type: "plugin_api_catalog"; requestId: string }
	| { type: "plugin_path_response"; id: string; ok: boolean; remember?: boolean }
	| { type: "plugin_path_revoke"; pluginId?: string; path?: string }
	| { type: "plugin_permission_response"; id: string; ok: boolean; remember?: boolean }
	| { type: "plugin_permission_revoke"; pluginId?: string; family?: "net" | "llm"; host?: string; model?: string }
	| { type: "set_workspace_roots"; roots?: string[] }
	| {
			type: "plugin_catalog_sync";
			requestId: string;
			source: string;
			install?: boolean;
			replace?: boolean;
	  }
	| { type: "dsh_patches_list" }
	| { type: "dsh_preset_list" }
	| { type: "dsh_preset_select"; preset: string }
	| { type: "dsh_preset_default"; preset: string }
	| { type: "dsh_permission_set"; preset: string }
	| { type: "dsh_permission_default"; preset: string }
	| { type: "dsh_patches_rescan" }
	| { type: "dsh_patch_install"; spec: string; id?: string }
	| { type: "dsh_patch_toggle"; name: string; enabled: boolean }
	| { type: "dsh_patch_delete"; name: string }
	| { type: "dsh_market_fetch"; force?: boolean }
	| {
			type: "question_answer";
			global?: boolean;
			id: string;
			answers: QuestionAnswer[];
			cancelled?: boolean;
			cancelReason?: string;
			owner?: string;
	  }
	| {
			type: "tool_approval_response";
			owner?: string;
			global?: boolean;
			id: string;
			decision: "approve" | "deny" | "edit";
			editedParams?: Record<string, unknown> | unknown;
			reason?: string;
			scope?: "once" | "category" | "all";
	  }
	| {
			type: "set_approval_policy";
			conversationId?: string;
			allowAll?: boolean;
			categories?: string[];
	  }
	| {
			type: "plan_update";
			conversationId?: string;
			steps: PlanStep[];
			activeStepId?: string | null;
	  }
	| {
			type: "plan_step_update";
			conversationId?: string;
			stepId: string;
			patch: Partial<PlanStep>;
	  }
	| {
			type: "plan_step_delete";
			conversationId?: string;
			stepId: string;
	  }
	| {
			type: "plan_step_add";
			conversationId?: string;
			step: PlanStep;
			afterStepId?: string;
	  }
	| {
			type: "plan_clean_handoff";
			steps: PlanStep[];
			prompt: string;
	  }
	| { type: "set_plan_mode"; enabled: boolean; conversationId?: string }
	| { type: "set_delegate_mode"; enabled: boolean; conversationId?: string }
	| {
			type: "page_response";
			id: string;
			ok: boolean;
			result?: unknown;
			error?: string;
	  }
	| {
			type: "phone_response";
			id: string;
			ok: boolean;
			result?: unknown;
			error?: string;
	  }
	| { type: "apply_preset"; name: string }
	| { type: "delete_preset"; name: string }
	| {
			type: "preset_export";
			plugins?: UiPresetPluginDependency[];
			source?: "preset" | "current";
			name?: string;
			description?: string;
			author?: string;
			tags?: string[];
			requestId?: string;
	  }
	| {
			type: "preset_import";
			json: string;
			dryRun?: boolean;
			name?: string;
			apply?: boolean;
			fields?: string[];
			requestId?: string;
	  }
	| {
			type: "preset_import_url";
			url: string;
			dryRun?: boolean;
			name?: string;
			apply?: boolean;
			fields?: string[];
			requestId?: string;
	  }
	| { type: "preset_catalog"; refresh?: boolean; requestId?: string }
	| {
			type: "preset_share";
			plugins?: UiPresetPluginDependency[];
			source?: "preset" | "current";
			name?: string;
			description?: string;
			author?: string;
			tags?: string[];
			requestId?: string;
	  }
	| { type: "remove_project"; path: string }
	| { type: "create_sandbox"; name?: string; sourcePath?: string; ephemeral?: boolean }
	| { type: "reset_sandbox"; path?: string }
	| { type: "persist_sandbox"; path?: string }
	| { type: "promote_sandbox"; path?: string; targetPath: string; switchToTarget?: boolean }
	| { type: "diff_sandbox"; path?: string; requestId?: string }
	| { type: "apply_sandbox_to_source"; path?: string; expectedRevision: string }
	| { type: "destroy_sandbox"; path: string }
	| { type: "refresh_worktrees" }
	| { type: "switch_worktree"; path: string }
	| { type: "remove_worktree"; path: string; force?: boolean }
	| { type: "delete_session"; path: string }
	| { type: "rename_session"; path: string; name: string }
	| { type: "rename_conversation"; id: string; name: string }
	| { type: "dismiss_conversation"; id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string }
	| { type: "persist_conversation"; id: string }
	| { type: "pin_conversation"; id: string; pinned: boolean }
	| { type: "pin_session"; path: string; pinned: boolean }
	| { type: "dismiss_finished_subagents"; parentId?: string }
	| { type: "schedule_list" }
	| { type: "schedule_save"; task: SchedulerTaskInput }
	| { type: "schedule_delete"; id: string }
	| { type: "schedule_run"; id: string }
	| { type: "schedule_toggle"; id: string; enabled: boolean }
	| {
			type: "get_compacted_messages";
			compactionMessageId: string;
			conversationId?: string;
	  }
	| {
			type: "remote_ssh_probe";
			reqId?: string;
			params: RemoteSshProbeParams;
	  }
	| {
			type: "remote_ssh_trust_host";
			reqId?: string;
			host: string;
			port: number;
			fingerprint: string;
			replace?: boolean;
	  }
	| {
			type: "remote_ssh_trust_host_result";
			reqId?: string;
			ok: boolean;
			error?: string;
	  }
	| {
			type: "remote_ssh_list_dir";
			reqId?: string;
			connectionId: string;
			path?: string;
	  }
	| {
			type: "remote_ssh_install_tools";
			reqId?: string;
			connectionId: string;
			tools: string[];
	  }
	| {
			type: "remote_ssh_list_profiles";
			reqId?: string;
	  }
	| {
			type: "remote_ssh_delete_profile";
			name: string;
	  };

export type RemoteSshAuth =
	| { type: "password"; password?: string }
	| { type: "key"; privateKeyPath?: string; privateKey?: string; passphrase?: string }
	| { type: "agent" };

export interface RemoteSshProbeParams {
	host: string;
	port?: number;
	username: string;
	auth: RemoteSshAuth;
	profileName?: string;
	saveProfile?: boolean;
}

export interface RemoteSshHostTrustOffer {
	host: string;
	port: number;
	algorithm: string;
	fingerprint: string;
	knownHostsFile: string;
	status: "unknown" | "changed" | "revoked";
}

export interface RemoteSshSystemInfo {
	os: string;
	arch: string;
	hostname: string;
	homeDir: string;
	user: string;
	cores?: number;
	totalMemMb?: number;
}

export interface RemoteSshToolsInfo {
	git: { installed: boolean; version?: string };
	node: { installed: boolean; version?: string };
	bash: { installed: boolean; path?: string };
	python?: { installed: boolean; version?: string };
}

export interface RemoteSshDirItem {
	name: string;
	path: string;
	type: "dir" | "file";
	size?: number;
	mtime?: number;
}

export interface RemoteSshProfileSummary {
	name: string;
	host: string;
	port: number;
	username: string;
	authType: "password" | "key" | "agent";
	privateKeyPath?: string;
	lastConnected?: number;
	remotePath?: string;
	description?: string;
}

export interface SessionSummary {
	nativeCli?: NativeCliConfig;
	path: string;
	sessionId?: string;
	cwd?: string;
	name?: string;
	displayName?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	source?: "web" | "tui";
	pinned?: boolean;
	parentSessionPath?: string;
}

export interface MessageAnchor {
	role: string;
	timestamp: number;
}

export interface SessionSearchResult extends SessionSummary {
	anchors: MessageAnchor[];
}

export interface SandboxInfo {
	id: string;
	name: string;
	path: string;
	sourcePath?: string;
	ephemeral: boolean;
	createdAt: number;
}

export interface SandboxDiffView {
	requestId?: string;
	expectedRevision?: string;
	sandboxId: string;
	path: string;
	sourcePath?: string;
	added: string[];
	modified: string[];
	deleted: string[];
	unchangedCount: number;
	error?: string;
}

export interface LinkedWorktreeEntry {
	path: string;
	branch?: string;
	isCurrent?: boolean;
	isMain?: boolean;
	isDirty?: boolean;
	uncommittedCount?: number;
	aheadCount?: number;
}

export interface WorktreeInfo {
	isLinkedWorktree: boolean;
	currentPath: string;
	branch?: string;
	mainPath: string;
	mainBranch?: string;
	linkedWorktrees: LinkedWorktreeEntry[];
}

export interface ProjectSummary {
	path: string;
	lastUsed: number;
	sandbox?: SandboxInfo;
}

export interface UiQuestionOption {
	label: string;
	description?: string;
	preview?: string;
	recommended?: boolean;
}

export interface UiQuestion {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: UiQuestionOption[];
	multiSelect?: boolean;
	dependsOn?: {
		questionId: string;
		value?: string | string[];
	};
	optionsMap?: Record<string, UiQuestionOption[]>;
}

export interface DeviceTaskInteractionBinding {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	deviceId: string;
}
export interface DeviceTaskInteraction extends DeviceTaskInteractionBinding {
	id: string;
	kind: "question" | "approval";
	createdAt: number;
	deadline?: number;
	questions?: UiQuestion[];
	toolName?: string;
	paramsPreview?: string;
	reason?: string;
}
export interface DeviceTaskInteractionAnswer {
	taskId: string;
	attemptId: string;
	interactionId: string;
	answers?: QuestionAnswer[];
	cancelled?: boolean;
	decision?: "approve" | "deny";
}

export interface QuestionAnswer {
	id: string;
	selected: string[];
	custom?: string;
}

export interface UiPendingQuestion {
	owner?: string;
	global?: boolean;
	createdAt?: number;
	id: string;
	questions: UiQuestion[];
	deadline?: number;
	conversationId?: string;
	conversationTitle?: string;
}

export interface UiQueuedQuestion extends UiPendingQuestion {
	owner: string;
	rootConversationId?: string;
	createdAt: number;
	audience?: "user" | "parent";
}

export interface UiActionSuggestion {
	id: string;
	label: string;
	prompt: string;
}

export interface UiApprovalCategory {
	id: string;
	label: string;
	labelEn: string;
}

export interface UiApprovalRule {
	id: string;
	enabled: boolean;
	tools: string[];
	field: "command" | "path" | "params";
	match: "regex" | "glob" | "contains" | "prefix" | "outside_workspace";
	value: string;
	action: "ask" | "deny" | "allow";
	label: string;
	labelEn?: string;
	reason?: string;
	reasonEn?: string;
	categoryId?: string;
	builtin?: boolean;
}

export interface UiApprovalPolicyState {
	conversationId?: string;
	allowAll: boolean;
	categories: UiApprovalCategory[];
}

export interface UiApprovalHit {
	ruleId: string;
	label: string;
	labelEn?: string;
	field: "command" | "path" | "params";
	index: number;
	length: number;
	text: string;
}

export interface UiToolApproval {
	owner?: string;
	global?: boolean;
	id: string;
	createdAt?: number;
	toolCallId: string;
	toolName: string;
	params: Record<string, unknown> | unknown;
	reason?: string;
	reasonEn?: string;
	category?: UiApprovalCategory;
	hits?: UiApprovalHit[];
	parentTool?: string;
	conversationId?: string;
	conversationTitle?: string;
}

export type PlanStepStatus = "pending" | "in_progress" | "done" | "failed";

export interface PlanStep {
	id: string;
	title: string;
	status: PlanStepStatus;
	description?: string;
}

export interface PlanState {
	steps: PlanStep[];
	activeStepId?: string | null;
	updatedAt?: number;
}

export interface BgServer {
	port?: number;
	pid?: number;
	taskId?: string;
	plugin?: string;
	since: number;
	name?: string;
	command?: string;
	status?: string;
	keep?: boolean;
	/** 行来源：port（监听端口的进程）/ plugin（插件常驻任务）/ job（bash background 的后台任务） */
	kind?: "port" | "plugin" | "job";
	/** job 行：发起归属（对话 id），多对话并行时用来区分是谁起的 */
	origin?: string;
	/** job 行：日志文件路径（面板上可直接复制去 read） */
	logPath?: string;
}

export interface SchedulerRunInfo {
	target?: "conversation" | "canvas";
	graphId?: string;
	runId?: string;
	at: number;
	ok: boolean;
	durationMs: number;
	conversationId?: string;
	error?: string;
	manual?: boolean;
}

export interface SchedulerTaskInput {
	target?: "conversation" | "canvas";
	graphId?: string;
	id?: string;
	name?: string;
	description?: string;
	cwd?: string;
	kind?: "cron" | "interval";
	spec?: string | number;
	prompt?: string;
	enabled?: boolean;
	model?: string;
	thinkingLevel?: string;
	catchUp?: "skip" | "once";
	conversationId?: string;
	sessionFile?: string;
	oneShot?: boolean;
}

export interface SchedulerTaskView {
	target?: "conversation" | "canvas";
	graphId?: string;
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: "cron" | "interval";
	spec: string;
	prompt: string;
	enabled: boolean;
	model: string;
	thinkingLevel: string;
	catchUp: "skip" | "once";
	conversationId: string;
	sessionFile: string;
	oneShot: boolean;
	createdAt: number;
	updatedAt: number;
	nextFire: number | null;
	lastRun: SchedulerRunInfo | null;
	history: SchedulerRunInfo[];
	running: boolean;
}

export interface FileSearchResult {
	path: string;
	name: string;
	type: "file" | "dir";
}
export interface FileEntry {
	name: string;
	path: string;
	type: "file" | "dir";
	kind?: "image" | "video" | "audio" | "text" | "none";
}

export interface PptxSlideImagePayload {
	media: string;
	name?: string;
	descr?: string;
}

export interface PptxSlidePayload {
	index: number;
	title: string;
	subtitle?: string;
	paragraphs: string[];
	tables?: string[][][];
	images?: PptxSlideImagePayload[];
	notes?: string;
	bg?: string;
}

export interface ScmFileEntry {
	path: string;
	x: string;
	y: string;
}

export interface ScmBranchEntry {
	name: string;
	current: boolean;
	remote?: string | boolean;
}

export interface ScmCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
	graph: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	vision: boolean;
	enabled?: boolean;
}

export interface GoalRoleRef {
	convId: string;
	spawned: boolean;
	streaming?: boolean;
	activity?: string;
	activityEn?: string;
}

export interface GoalHistoryEntry {
	goal: string;
	verdict: "pass" | "fail" | "blocked";
	rounds: number;
	feedback: string;
	finishedAt: number;
}

export interface GoalStatus {
	conversationId: string | null;
	goal: string | null;
	reviewModel: string | null;
	maxRounds: number;
	locked: boolean;
	reviewing: boolean;
	round: number;
	status: string;
	statusEn?: string;
	verdict: "pending" | "pass" | "fail" | "blocked";
	feedback?: string;
	wizard: WizardStatus;
	phase?: "idle" | "executing" | "reviewing" | "blocked";
	usage?: { inputTokens: number; outputTokens: number };
	history?: GoalHistoryEntry[];
	execModel?: string | null;
	roles?: { executor?: GoalRoleRef };
}

export interface WizardStatus {
	active: boolean;
	draft: string;
	model: string | null;
	step: number;
	maxSteps: number;
	status: string;
	statusEn?: string;
}

export interface UiEnrichResult {
	id: string;
	status: "matched" | "suggested" | "unmatched";
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	reasoning?: boolean;
	thinkingLevelMap?: UiThinkingLevelMap;
	reasoningType?: "budget" | "effort" | "fixed";
	name?: string;
	source?: string;
	matchType?: "exact" | "normalized" | "family" | "hint" | "hint-url";
	suggestions?: string[];
	note?: string;
}
export type UiThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | number | null>
>;
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: UiThinkingLevelMap;
	compat?: Record<string, unknown>;
	samplingParams?: Record<string, unknown>;
	customExtraBody?: string;
	api?: string;
	baseUrl?: string;
}

export interface UiProviderConfig {
	providerId: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	hasApiKey?: boolean;
	authHeader?: boolean;
	models: UiModelConfigEntry[];
}

export interface UiPluginUpdateInfo {
	id: string;
	name?: string;
	version?: string;
	latestVersion?: string | null;
	source: string;
	localSha: string | null;
	remoteSha: string | null;
	updatable: boolean;
	builtin?: boolean;
	error?: string;
}

export interface UiPluginSettingField {
	key: string;
	type: "text" | "password" | "number" | "boolean" | "select" | "secret";
	label: string;
	default?: string | number | boolean;
	min?: number;
	max?: number;
	options?: (string | UiSelectOption)[];
	optionsFrom?: "models" | "thinkingLevels";
	hint?: string;
}

export interface PluginRequires {
	hostApi?: number;
	families?: string[];
	plugins?: string[];
}

export interface CatalogSlotOccupant {
	pluginId: string;
	items: number;
}
export interface CatalogSlotEntry {
	slot: string;
	aliases: string[];
	kinds: string[];
	occupants: CatalogSlotOccupant[];
	replaceRisk: string;
	example: string;
}
export interface CatalogAgentTool {
	name: string;
	group: string;
	defaultOn: boolean;
	dshVisible: boolean;
}
export interface CatalogHostMethod {
	name: string;
	needs: string;
	summary: string;
	example: string;
}
export interface PluginApiCatalog {
	version: 1;
	slots: CatalogSlotEntry[];
	agentTools: CatalogAgentTool[];
	hostMethods: CatalogHostMethod[];
}

export interface UiPluginFileHandler {
	id: string;
	extensions: string[];
	priority: number;
	label?: string;
	labelEn?: string;
}

export interface PluginPanelItem {
	id: string;
	title: string;
	hint?: string;
	status: "running" | "done" | "error";
	icon?: string;
	action?: string;
}

export interface PluginPanelGroup {
	pluginId: string;
	pluginName: string;
	items: PluginPanelItem[];
}

export interface UiPluginInfo {
	id: string;
	name: string;
	version?: string;
	description?: string;
	homepage?: string;
	hasClient: boolean;
	icon?: string;
	iconSvg?: string;
	error?: string;
	active?: boolean;
	alwaysOn?: boolean;
	permissions?: string[];
	netAllowlist?: string[];
	engines?: Record<string, string>;
	peerPlugins?: string[];
	requires?: PluginRequires;
	settingsSchema?: UiPluginSettingField[];
	settingsValues?: Record<string, unknown>;
	settingsSources?: Record<string, "default" | "override" | "stored">;
	isolated?: boolean;
	source?: string;
	wantsDom?: boolean;
	domGranted?: boolean;
	renderers?: string[];
	messageWidgets?: string[];
	attachmentCards?: string[];
	composerProviders?: string[];
	fileHandlers?: UiPluginFileHandler[];
	view?: boolean;
	preload?: boolean;
	ui?: UiPluginUi;
	diagnostics?: string[];
	agentTools?: UiPluginAgentTool[];
}

export interface UiPluginAgentTool {
	name: string;
	label?: string;
	description?: string;
}

export type UiSlotId =
	| "topbar.primary"
	| "topbar.overflow"
	| "bottombar"
	| "composer.leading"
	| "composer.actions"
	| "message.actions"
	| "rightpanel.tabs"
	| "contextmenu.topbar"
	| "contextmenu.message"
	| "contextmenu.session"
	| "contextmenu.project"
	| "contextmenu.file"
	| "contextmenu.toolcall"
	| "tool.card.footer"
	| "settings.pages"
	| "leftpanel.projects.actions"
	| "leftpanel.project"
	| "leftpanel.running.actions"
	| "leftpanel.running"
	| "leftpanel.history"
	| "leftpanel.history.actions"
	| "leftpanel.sections"
	| "leftpanel.sessions"
	| "chat.header"
	| "chat.empty"
	| "file.preview.toolbar"
	| "terminal.toolbar"
	| "scm.toolbar"
	| "goalbar.actions"
	| "notice.actions"
	| "tasks.panel"
	| "modal.dialog"
	| "sidebar.left"
	| "sidebar.right"
	| "device.group.header"
	| "device.group.actions"
	| "device.group.workspace";

export type UiSlotCardinality = "list" | "single";

export interface UiSlotSpec {
	slot: UiSlotId;
	cardinality: UiSlotCardinality;
}

export type UiItemKind =
	"view" | "action" | "badge" | "menu" | "page" | "organizer" | "divider" | "toggle" | "input" | "progress" | "select";

export type UiAlign = "start" | "center" | "end";

export interface UiSelectOption {
	value: string;
	label?: string;
	labelEn?: string;
}

export interface UiContribution {
	id: string;
	slot: UiSlotId;
	label: string;
	labelEn?: string;
	icon?: string;
	iconSvg?: string;
	hint?: string;
	hintEn?: string;
	kind?: UiItemKind;
	children?: UiContribution[];
	order?: number;
	align?: UiAlign;
	group?: string;
	hidden?: boolean;
	action?: string;
	view?: string;
	when?: string[];
	badge?: string;
	checked?: boolean;
	value?: string;
	progress?: number;
	options?: UiSelectOption[];
}

export interface UiArrangeOp {
	id: string;
	slot?: UiSlotId;
	hide?: boolean;
	group?: string;
	order?: number;
	align?: UiAlign;
	label?: string;
	hint?: string;
	icon?: string;
	iconSvg?: string;
}

export interface UiLayoutPrefs {
	hidden?: string[];
	shown?: string[];
	order?: string[];
	groups?: Record<string, string>;
	align?: Record<string, UiAlign>;
	labels?: Record<string, string>;
	topbarText?: boolean;
	sideDockFloat?: boolean;
	slots?: Record<string, UiSlotId>;
}

export interface UiPluginUi {
	items: UiContribution[];
	arrange: UiArrangeOp[];
}

export type PluginPermissionFamily =
	| "fs"
	| "fs:read"
	| "fs:write"
	| "ui"
	| "tools"
	| "http"
	| "chat"
	| "llm"
	| "net"
	| "dom"
	| "dom:anchor"
	| "notify"
	| "storage"
	| "secrets";

export interface PluginBusEvent {
	topic: string;
	from?: string;
	payload?: unknown;
}

export interface PluginModelInfo {
	id: string;
	provider: string;
	vision: boolean;
}

export interface PluginStats {
	conversationId?: string;
	tokens: { input: number; output: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface UiPluginCatalogEntry {
	id: string;
	name: string;
	nameEn?: string;
	description?: string;
	descriptionEn?: string;
	icon?: string;
	iconSvg?: string;
	source: string;
	builtin: boolean;
	overridesBuiltin?: boolean;
	homepage?: string;
	origin?: "builtin" | "community" | "custom";
}

export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
	supportsApiKey: boolean;
	supportsOAuth: boolean;
	oauthName?: string;
	usingOAuth: boolean;
}

export type ProviderOAuthPromptPayload =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: { id: string; label: string; description?: string }[];
	  };

export type ProviderOAuthEventPayload =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface ProviderOAuthFlowState {
	flowId: string;
	provider: string;
	promptId?: string;
	prompt?: ProviderOAuthPromptPayload;
	event?: ProviderOAuthEventPayload;
}

export interface ProviderKeyInfo {
	name: string;
	active: boolean;
}
/** ONE RUNNING conversation (each runs its own session in parallel). The
 *  list is GLOBAL across projects — a background run from another workspace
 *  stays visible until it is opened and left without continuing — and holds
 *  every conversation displaced to the background while still streaming
 *  (background-finish keeps them listed, opening-and-leaving-without-
 *  continuing removes them), PLUS the ACTIVE conversation once it has content
 *  (issue #140: the chat you are looking at must not be missing from the list;
 *  a blank new chat stays out). cwd lets the client group by project. */
export interface ConversationSummary {
	nativeCli?: NativeCliConversation;
	independent?: boolean;
	id: string;
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	completionPending?: boolean;
	isSubagent: boolean;
	agentPreset?: string;
	presetLocked?: boolean;
	error?: string;
	canceled?: boolean;
	/**
	 * 子代理完成证据的裁决：服务端已经用子代理自己的转录核对过它自报的文件/命令。
	 * `unverified`/`partial`/`blocked` 要在左栏显式标出来，别让「没验证」看起来像「已验证」。
	 */
	subagentVerdict?: "pass" | "partial" | "unverified" | "blocked";
	parentId?: string;
	model?: string;
	thinkingLevel?: string;
	sessionId?: string;
	sessionFile?: string;
	hasQuestion?: boolean;
	questionId?: string;
	questionTitle?: string;
	isEphemeral?: boolean;
	pinned?: boolean;
	hasUserTerminals?: boolean;
	forkFrom?: {
		conversationId: string;
		messageId?: string;
		title?: string;
	};
	/**
	 * 该会话是从别的会话分叉出来的（角标用）。
	 * `forkFrom` 只活在内存里，重启/重开后只能靠会话文件头的 `parentSession` 推出来，
	 * 所以客户端判角标要同时看 `forkFrom || forked`。
	 */
	forked?: true;
	modified?: number;
	/**
	 * 左栏行归属（引擎裁定，客户端不再猜）：
	 * - `open`：这个对话在左栏自己占一行（运行中 / 未落盘 / 子代理 / 临时 / 固定 / 原生 CLI）。
	 * - `history`：已由历史会话行代表，客户端不要再为它出行。
	 * 缺省 = 旧引擎，客户端退回按 sessionFile 推断的启发式。
	 */
	rowKind?: "open" | "history";
}

export interface ElsewhereRunning {
	independent?: boolean;
	forked?: boolean;
	title: string;
	cwd: string;
	isStreaming: boolean;
	sessionFile?: string;
	owner?: string;
	convId?: string;
	hasQuestion?: boolean;
	questionTitle?: string;
	pseudo?: boolean;
	ownerOffline?: boolean;
}

export interface UiAgentPreset {
	id: string;
	trust: "system" | "user";
	isDefault: boolean;
	name?: string;
	description?: string;
	nameEn?: string;
	descriptionEn?: string;
	order?: number;
	broken?: string;
}

export interface DshPermissionOption {
	value: string;
	name: string;
	description?: string;
	nameEn?: string;
	descriptionEn?: string;
}

export interface UiSkillInfo {
	name: string;
	description: string;
	enabled: boolean;
}

export interface UiExtensionInfo {
	id: string;
	name: string;
	path: string;
	enabled: boolean;
}

export interface UiSettingsPreset {
	name: string;
	plugins?: UiPresetPluginDependency[];
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	promptDisabled: string[];
	disabledSkills: string[];
	disabledExtensions: string[];
	reviewPrompt: string;
	reviewDisabledSkills: string[];
}

export interface UiPresetCatalogEntry {
	id: string;
	name: string;
	description: string;
	author: string;
	tags: string[];
	url: string;
	issueUrl: string;
	updatedAt: string;
	summary?: {
		promptMode: string;
		skills: number;
		agentTools: number;
		hasTemplate: boolean;
		hasReviewPrompt: boolean;
	};
}

export interface UiPresetPluginDependency {
	id: string;
	name?: string;
	source?: string;
	version?: string;
}

export interface UiPresetImportPreview {
	plugins?: UiPresetPluginDependency[];
	name: string;
	description: string;
	author: string;
	tags: string[];
	format: string;
	version: number;
	fields: string[];
	ignored: string[];
	rejected: string[];
	replaces: boolean;
	summary: NonNullable<UiPresetCatalogEntry["summary"]>;
	settings?: Record<string, unknown>;
	customSystemPrompt: string;
	promptTemplate: string;
	reviewPrompt: string;
	disabledSkills: string[];
	disabledExtensions: string[];
	promptDisabled: string[];
}

export interface UiSubagentTemplate {
	name: string;
	description: string;
	descriptionEn?: string;
	promptMode: "append" | "replace";
	systemPrompt: string;
	systemPromptEn?: string;
	enabledSkills: string[];
	enabledExtensions: string[];
	model: string;
	thinkingLevel: string;
	enabled: boolean;
}

export interface UiVisionBridgeModel {
	provider: string;
	id: string;
	label: string;
}

export type McpScope = "global" | "project";

export interface UiMcpToolInfo {
	name: string;
	description?: string;
}

export interface UiMcpServer {
	name: string;
	scope: McpScope;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	type?: "stdio" | "http" | "streamable-http";
	timeout?: number;
	protocolVersion?: string;
	enabled?: boolean;
	description?: string;
	status?: "running" | "stopped" | "error";
	overriddenBy?: McpScope;
	usingPreviousConfig?: boolean;
	error?: string;
	tools?: UiMcpToolInfo[];
}

export interface RemoteMcpServer {
	id: string;
	name: string;
	displayName?: string;
	description: string;
	homepage?: string;
	package?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	transport: "stdio" | "http";
	source: string;
	downloads?: number;
	verified?: boolean;
	iconUrl?: string;
}

export interface RemoteSkillSummary {
	id: string;
	name: string;
	description: string;
	repo: string;
	url?: string;
}

export interface UiMarkerInfo {
	name: string;
	enabled: boolean;
	guidance: string[];
	label?: string;
	pluginId?: string;
}

export interface UiToolPromptOverride {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface QuickAskAttachment {
	id: string;
	kind: "file" | "directory" | "conversation";
	name: string;
	content: string;
	path?: string;
	image?: { data: string; mimeType: string };
}

export interface QuickAskMessage {
	role: "user" | "assistant";
	content: string;
	attachments?: QuickAskAttachment[];
}

export type QuickAskTranslateTarget =
	"auto" | "zh-CN" | "zh-TW" | "en" | "ja" | "ko" | "de" | "fr" | "es" | "ru" | "pt" | "it" | "tr";
export type QuickAskTranslateStyle = "natural" | "literal" | "technical";
export type QuickAskContextSource =
	| { kind: "file" | "directory"; path: string; cwd?: string }
	| { kind: "conversation"; conversationId?: string; sessionFile?: string; owner?: string }
	| { kind: "upload"; name: string; data: string; mimeType?: string };
export interface QuickAskContextRequest {
	source: QuickAskContextSource;
	scope?: "recent" | "full" | "listing" | "content";
	clientId?: string;
}

export type QuickAskStreamEvent =
	| { type: "start"; model: string }
	| { type: "delta"; text: string }
	| { type: "done"; text: string; model: string }
	| { type: "error"; error: string };

export interface UiSettingsState {
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	promptDisabled: string[];
	toolPromptOverrides: Record<string, UiToolPromptOverride>;
	disabledSkills: string[];
	disabledExtensions: string[];
	disabledAgentTools: string[];
	/** 按需列表：列内工具直接关闭（与 `disabledAgentTools` 取并集）。 */
	toolOnDemandTools: string[];
	disabledPluginTools: string[];
	/** @deprecated 遗留别名（由 disabledAgentTools 推导）：全开才算开。Off → terminal_*
	 *  tools are removed from the active set and the guidance prompt is not injected. */
	nativeCliInheritModel: NativeCliInheritModel;
	terminalToolsEnabled: boolean;
	terminalBash: boolean;
	terminalBashIdleMs: number;
	terminalBashMaxForegroundMs: number;
	toolWatchdogTimeoutMs: number;
	readDirEnabled: boolean;
	bgAutoCleanupMin: number;
	toolLazyLoading: boolean;
	codemodeMode: "on" | "only";
	codemodeInlineBudget: number;
	questionnaireEnabled: boolean;
	questionPresentation?: "queue" | "all" | "manual";
	toolApprovalPresentation?: "queue" | "all" | "manual";
	questionTimeoutSeconds?: number;
	toolApprovalEnabled: boolean;
	approvalPolicy: UiApprovalPolicyState;
	approvalRules: UiApprovalRule[];
	parallelReminderEnabled: boolean;
	goalModeEnabled: boolean;
	thinkingWrap: boolean;
	devNoCache?: boolean;
	autoReload?: boolean;
	toolsWrap: boolean;
	toolImagesEnabled: boolean;
	keepRecentMessages: number;
	reversePagination?: boolean;
	showForkedParentSessions: boolean;
	retainFinishedConversations: boolean;
	openRecentSessionOnProjectSwitch: boolean;
	skillsFullText: string[];
	skillsCatalogMaxDesc: number;
	skillsCatalogShowLocation: boolean;
	skillsCatalogBudget: number;
	skillsMaxFileBytes: number;
	skillsFullTextMaxBytes: number;
	chatUploadMaxMb?: number;
	workspaceUploadMaxMb?: number;
	folderUploadMaxMb?: number;
	visionBridgeEnabled: boolean;
	visionBridgeModel: string | null;
	visionBridgePromptMode: "append" | "replace";
	visionBridgePrompt: string;
	scmCommitMsgPromptMode: "append" | "replace";
	scmCommitMsgPrompt: string;
	quickAskEnabled: boolean;
	quickAskModel: string | null;
	quickAskThinking: ThinkingLevel;
	quickAskSystemPrompt: string;
	quickAskExplainPrompt: string;
	quickAskTranslateEnabled: boolean;
	quickAskTranslateTarget: QuickAskTranslateTarget;
	quickAskTranslateStyle: QuickAskTranslateStyle;
	quickAskTranslatePrompt: string;
	quickAskReferenceMenus: boolean;
	quickAskConversationScope: "recent" | "full";
	quickAskFolderScope: "listing" | "content";
	planModePromptMode: "append" | "replace";
	planModePrompt: string;
	reviewPrompt: string;
	reviewDisabledSkills: string[];
	disabledPlugins: string[];
	uiLayout: UiLayoutPrefs;
	effectiveSystemPrompt: string;
	promptSourceDefaults: Record<string, string>;
	promptSections?: { name: string; text: string; chars: number }[];
	toolsSchema: string;
	visionBridgeDefaultPrompt: string;
	scmCommitMsgDefaultPrompt: string;
	planModeDefaultPrompt: string;
	visionModels: UiVisionBridgeModel[];
	skills: UiSkillInfo[];
	reviewSkills: UiSkillInfo[];
	extensions: UiExtensionInfo[];
	presets: UiSettingsPreset[];
	disabledMarkers: string[];
	markers: UiMarkerInfo[];
	subagentTemplates: UiSubagentTemplate[];
	subagentDefaultModel: string | null;
	subagentMaxDepth?: number;
	subagentAutoWakeMaxTurns?: number;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	retryMaxAttempts: number;
	softCapTokens: number;
	softCapByModel: Record<string, number>;
	autoCompactionInstructions: string;
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	minimalNewChat: boolean;
	preserveDraftAcrossConversations: boolean;
	quickPhrasesSeeded: boolean;
	subagentModels: UiVisionBridgeModel[];
	subagentDefaultTemplates: string[];
	mcpServers?: UiMcpServer[];
	mcpGlobalConfigPath?: string;
	mcpProjectConfigPath?: string;
}

export interface DshPatchFileInfo {
	name: string;
	path: string;
	size: number;
	mtimeMs: number;
	disabled?: boolean;
}

export interface DshMarketPlugin {
	name: string;
	owner?: string;
	url?: string;
	category?: string;
	description?: { en?: string; zh?: string };
	npm?: string;
	version?: string;
	stars?: number;
	downloads?: number;
	capabilities?: string[];
	install?: string;
}

export type UpdateItemKind = "webui" | "pi-core" | "package" | "git-extension" | "plugin" | "engine";

export type ServerMessage =
	| { type: "new_chat_result"; requestId: string; conversationId?: string; ok: boolean }
	| {
			type: "canvas_list_result";
			graphs: CanvasGraphSummary[];
	  }
	| {
			type: "canvas_graph_state";
			graph: CanvasGraph;
			requestId?: string;
	  }
	| {
			type: "canvas_cards_state";
			cards: CanvasCustomCard[];
	  }
	| {
			type: "canvas_error";
			code: "rev_conflict" | "not_found" | "invalid_graph" | "execution_error" | "save_failed";
			message: string;
			messageI18n?: CanvasMessage;
			graphId?: string;
			graph?: CanvasGraph;
			requestId?: string;
	  }
	| {
			type: "canvas_node_event";
			graphId: string;
			nodeId: string;
			event: "started" | "progress" | "action" | "done" | "error" | "paused";
			currentAction?: string;
			currentActionMessage?: CanvasMessage;
			summary?: string;
			error?: string;
			errorMessage?: CanvasMessage;
	  }
	| {
			type: "canvas_node_log";
			graphId: string;
			nodeId: string;
			entry: CanvasNodeLogEntry;
	  }
	| {
			type: "canvas_node_log_state";
			graphId: string;
			nodeId: string;
			entries: CanvasNodeLogEntry[];
			messages: UiMessage[];
	  }
	| {
			type: "canvas_node_messages";
			graphId: string;
			nodeId: string;
			messages?: UiMessage[];
			appended?: UiMessage[];
			streaming?: boolean;
			error?: string;
	  }
	| {
			type: "subagent_handoff";
			fromRunId: string;
			toRunId: string;
			payload: string;
			timestamp: number;
	  }
	| {
			type: "mcp_servers";
			servers: UiMcpServer[];
			globalConfigPath?: string;
			projectConfigPath?: string;
	  }
	| {
			type: "mcp_oauth_result";
			reqId: string;
			status: "pending" | "complete" | "error" | "cancelled";
			id?: string;
			authorizationUrl?: string;
			redirectUrl?: string;
			error?: string;
	  }
	| {
			type: "mcp_market_result";
			ok: boolean;
			servers: RemoteMcpServer[];
			total?: number;
			source: string;
			error?: string;
	  }
	| {
			type: "skill_market_result";
			ok: boolean;
			skills: RemoteSkillSummary[];
			repo: string;
			error?: string;
	  }
	| {
			type: "skill_content_result";
			ok: boolean;
			skillId: string;
			content: string;
			error?: string;
	  }
	| {
			type: "ready";
			clientId: string;
			serverVersion: string;
			engine?: string;
			engineCapabilities?: AgentEngineCapabilities;
			protocolVersion?: number;
			appVersion?: string;
			buildId?: string;
			runId?: string;
			managed?: boolean;
			tabs?: string[];
			service?: UiServiceInfo;
			engines?: EngineStatus[];
	  }
	| {
			type: "engines_status";
			engines: EngineStatus[];
	  }
	| { type: "snapshot"; state: UiState }
	| {
			type: "snapshot_delta";
			conversationId: string;
			rev: number;
			baseRev: number;
			appended: UiMessage[];
			state: Omit<UiState, "messages" | "rev"> & { rev: number };
	  }
	| {
			// Global running-conversation list (see ConversationSummary): all
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
			elsewhere?: ElsewhereRunning[];
	  }
	| {
			type: "tool_delta";
			conversationId: string;
			seq: number;
			toolCallId: string;
			toolName: string;
			delta: string;
			mode?: "append" | "replace";
	  }
	| {
			type: "message_delta";
			conversationId: string;
			seq: number;
			messageId: string;
			usage: { input: number; output: number; total: number } | null;
			assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
	  }
	| {
			type: "tool_status";
			toolCallId: string;
			toolName: string;
			isError: boolean;
			exitCode?: number;
			durationMs?: number;
	  }
	| {
			type: "terminal_output";
			conversationId?: string;
			ownerKind?: "client" | "conversation";
			terminalId: string;
			data: string;
			reset?: boolean;
	  }
	| {
			type: "terminal_exit";
			conversationId?: string;
			terminalId: string;
			exitCode: number | null;
			ownerKind?: "client" | "conversation";
	  }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	| { type: "terminal_cli_paste_result"; requestId: string; terminalId: string; ok: boolean; error?: string }
	| {
			type: "native_cli_prompt_submitted";
			eventId: string;
			conversationId: string;
			sessionId: string;
			occurredAt: number;
	  }
	| {
			type: "terminal_cli_control_result";
			requestId: string;
			terminalId: string;
			conversationId: string;
			ok: boolean;
			error?: string;
	  }
	| {
			type: "native_cli_event";
			eventId: string;
			kind: "done" | "error" | "question" | "approval";
			conversationId: string;
			sessionId: string;
			occurredAt: number;
	  }
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }
	| { type: "scm_changed" }
	| { type: "heartbeat"; hostMetrics?: UiHostMetrics; latencyMs?: number }
	| { type: "sessions"; sessions: SessionSummary[]; cwd?: string; hasMore?: boolean }
	/** Filename matches for the global search panel (reqId echo). Always sent
	 *  in reply to a search_files request — ok:false means the walk failed. */
	| {
			type: "search_files_result";
			reqId: number;
			ok: boolean;
			results: FileSearchResult[];
			truncated?: boolean;
	  }
	/** Conversation-content matches for the global search panel (reqId echo).
	 *  ok:false means the transcript scan failed — treat as no results. */
	| {
			type: "session_search_results";
			reqId: number;
			query: string;
			ok: boolean;
			results: SessionSearchResult[];
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| {
			type: "files";
			path: string;
			parent: string | null;
			entries: FileEntry[];
			truncated: boolean;
			absolute?: boolean;
	  }
	| { type: "file_changed"; path: string }
	| { type: "file_upload_result"; uploadId: string; ok: boolean; error?: string }
	| {
			type: "file_content";
			path: string;
			name: string;
			kind: "image" | "video" | "audio" | "text" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			lines: number;
			size: number;
			slides?: PptxSlidePayload[];
	  }
	| {
			type: "tool_info";
			name: string;
			found: boolean;
			unsupported?: boolean;
			label?: string;
			description?: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
			parameters?: unknown;
			parametersDropped?: boolean;
			active?: boolean;
			source?: string;
			scope?: string;
	  }
	| {
			type: "tool_prompt";
			name: string;
			found: boolean;
			unsupported?: boolean;
			defaultDescription?: string;
			defaultPromptSnippet?: string;
			defaultPromptGuidelines?: string[];
			override?: UiToolPromptOverride;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "provider_oauth_started"; flowId: string; provider: string }
	| { type: "provider_oauth_flows"; flows: ProviderOAuthFlowState[] }
	| {
			type: "provider_oauth_prompt";
			flowId: string;
			provider: string;
			promptId: string;
			prompt: ProviderOAuthPromptPayload;
	  }
	| {
			type: "provider_oauth_event";
			flowId: string;
			provider: string;
			event: ProviderOAuthEventPayload;
	  }
	| {
			type: "provider_oauth_result";
			flowId: string;
			provider: string;
			ok: boolean;
			cancelled?: boolean;
			error?: string;
	  }
	| { type: "provider_oauth_logout_result"; provider: string; ok: boolean; error?: string }
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	| { type: "default_model"; modelId: string | null }
	| {
			type: "fetch_models_result";
			reqId: number;
			ok: boolean;
			models?: UiModelConfigEntry[];
			error?: string;
	  }
	| {
			type: "test_model_connection_result";
			reqId: number;
			ok: boolean;
			latencyMs?: number;
			error?: string;
	  }
	| {
			type: "enrich_models_progress";
			reqId: number;
			phase: "catalog" | "page" | "matching" | "aborted";
			current?: number;
			total?: number;
			message?: string;
	  }
	| {
			type: "enrich_models_result";
			reqId: number;
			ok: boolean;
			results?: UiEnrichResult[];
			error?: string;
	  }
	| {
			type: "refresh_provider_result";
			reqId: number;
			ok: boolean;
			added?: number;
			total?: number;
			error?: string;
	  }
	| {
			type: "refresh_builtin_result";
			reqId: number;
			ok: boolean;
			error?: string;
	  }
	| {
			type: "append_builtin_result";
			reqId: number;
			ok: boolean;
			error?: string;
	  }
	| {
			type: "clone_provider_result";
			reqId: number;
			ok: boolean;
			config?: UiProviderConfig;
			configs?: UiProviderConfig[];
			error?: string;
	  }
	| { type: "install_result"; ok: boolean; detail: string }
	| {
			type: "scm_data";
			reqId: number;
			kind: "status" | "history" | "filediff" | "commit" | "commitmsg";
			ok: boolean;
			error?: string;
			notRepo?: boolean;
			branch?: string;
			detached?: boolean;
			upstream?: string | null;
			ahead?: number;
			behind?: number;
			upstreamGone?: boolean;
			files?: ScmFileEntry[];
			branches?: ScmBranchEntry[];
			stats?: Record<string, [number, number]>;
			history?: ScmCommitEntry[];
			stagedText?: string;
			worktreeText?: string;
			untracked?: boolean;
			text?: string;
	  }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			id: number;
			kind: "select" | "confirm" | "input";
			title: string;
			args: unknown[];
			code?: {
				content: string;
				language?: string;
				hasRisk?: boolean;
			};
	  }
	| { type: "dialog_closed"; id: number }
	| {
			type: "tui_overlay_open";
			id: number;
			title?: string;
			cols: number;
			rows: number;
			initialAnsi?: string;
	  }
	| { type: "tui_overlay_render"; id: number; ansi: string }
	| { type: "tui_overlay_close"; id: number }
	| {
			type: "update_status";
			current: string;
			latest: string | null;
			latestPublishedAt: string | null;
			upToDate: boolean;
			error?: string;
	  }
	| {
			type: "update_status_all";
			items: {
				name: string;
				kind: UpdateItemKind;
				current: string;
				latest: string | null;
				latestPublishedAt?: string | null;
				upToDate: boolean;
				error?: string;
				source?: string;
				pluginId?: string;
				builtin?: boolean;
			}[];
			piSdk?: { running: string; bundledInUse: boolean; newerInstalled: string | null };
	  }
	| { type: "goal_status"; status: GoalStatus }
	| { type: "settings_state"; settings: UiSettingsState }
	| {
			type: "preset_export_result";
			requestId?: string;
			ok: boolean;
			name?: string;
			fileName?: string;
			json?: string;
			error?: string;
	  }
	| {
			type: "preset_import_result";
			requestId?: string;
			ok: boolean;
			dryRun: boolean;
			preview?: UiPresetImportPreview;
			applied?: boolean;
			applyDeferred?: boolean;
			applyError?: string;
			error?: string;
	  }
	| {
			type: "preset_catalog_result";
			requestId?: string;
			ok: boolean;
			entries: UiPresetCatalogEntry[];
			source: string;
			cached: boolean;
			fetchedAt: number;
			error?: string;
	  }
	| {
			type: "preset_share_result";
			requestId?: string;
			ok: boolean;
			method?: "gh" | "api" | "browser";
			url?: string;
			name?: string;
			json?: string;
			error?: string;
	  }
	| { type: "plugins"; plugins: UiPluginInfo[]; epoch: number }
	| { type: "plugin_updates"; updates: UiPluginUpdateInfo[] }
	| { type: "plugin_catalog"; entries: UiPluginCatalogEntry[]; epoch: number }
	| { type: "plugin_data"; pluginId: string; payload: unknown }
	| { type: "plugin_panel_items"; groups: PluginPanelGroup[] }
	| {
			type: "plugin_job";
			jobId: string;
			action: "install" | "update" | "uninstall";
			pluginId: string;
			phase: "start" | "log" | "done";
			line?: string;
			ok?: boolean;
			error?: string;
			output?: string;
	  }
	| {
			type: "plugin_install_inspect_result";
			requestId: string;
			source: string;
			kind: "npm" | "github" | "url" | "path" | "invalid";
			suggestedId: string;
			installed: boolean;
			problem?:
				"invalid-spec" | "already-installed" | "not-found" | "not-a-package" | "not-a-bundle" | "network" | "unknown";
			detail?: string;
			manifest?: { id?: string; name?: string; version?: string; description?: string; permissions?: string[] };
	  }
	| {
			type: "plugin_api_catalog_result";
			requestId: string;
			catalog: PluginApiCatalog;
	  }
	| { type: "plugin_path_request"; id: string; pluginId: string; path: string; reason?: string }
	| { type: "plugin_dom_consent_request"; id: string; pluginId: string; from: string }
	| { type: "plugin_grants"; grants: { pluginId: string; paths: string[] }[] }
	| {
			type: "plugin_permission_request";
			id: string;
			pluginId: string;
			family: "net" | "llm";
			hosts?: string[];
			models?: string[];
			reason?: string;
	  }
	| {
			type: "plugin_permissions";
			grants: {
				pluginId: string;
				family: "net" | "llm";
				hosts?: string[];
				models?: string[];
				reason?: string;
				grantedAt: number;
				session?: boolean;
			}[];
	  }
	| { type: "plugin_permission_resolved"; id: string }
	| {
			type: "plugin_catalog_sync_result";
			requestId: string;
			ok: boolean;
			error?: string;
			entries?: UiPluginCatalogEntry[];
			installed?: { id: string; ok: boolean; error?: string }[];
	  }
	| {
			type: "dsh_market_data";
			count: number;
			updated?: string;
			categories: Record<string, { en: string; zh: string }>;
			plugins: DshMarketPlugin[];
	  }
	| { type: "dsh_patches"; patchDir: string; files: DshPatchFileInfo[] }
	| {
			type: "dsh_presets";
			presets: UiAgentPreset[];
			defaultPreset: string;
	  }
	| { type: "dsh_permission"; options: DshPermissionOption[]; defaultPreset: string }
	| {
			type: "question_pending";
			owner?: string;
			global?: boolean;
			createdAt?: number;
			id: string;
			deadline?: number;
			questions: UiQuestion[];
			conversationId?: string;
			conversationTitle?: string;
	  }
	| {
			type: "tool_approval_pending";
			owner?: string;
			global?: boolean;
			createdAt?: number;
			id: string;
			toolCallId: string;
			toolName: string;
			params: Record<string, unknown> | unknown;
			reason?: string;
			reasonEn?: string;
			category?: UiApprovalCategory;
			hits?: UiApprovalHit[];
			parentTool?: string;
			conversationId?: string;
			conversationTitle?: string;
	  }
	| { type: "tool_approval_resolved"; id: string; owner?: string; global?: boolean }
	| { type: "global_interactions"; questions: UiPendingQuestion[]; approvals: UiToolApproval[] }
	| {
			type: "plan_updated";
			conversationId?: string;
			plan: PlanState | null;
	  }
	| { type: "question_retracted"; id: string; owner?: string; global?: boolean }
	| { type: "question_queue"; questions: UiQueuedQuestion[] }
	| {
			type: "elsewhere_question";
			owner: string;
			convId: string;
			id: string;
			questions: UiQuestion[];
			conversationTitle?: string;
	  }
	| {
			type: "page_request";
			id: string;
			op: string;
			args?: Record<string, unknown>;
			target?: string;
			timeoutMs: number;
	  }
	| {
			type: "phone_request";
			id: string;
			op: string;
			args?: Record<string, unknown>;
			timeoutMs: number;
	  }
	| { type: "bg_servers"; servers: BgServer[] }
	| { type: "project_scripts"; cwd: string; scripts: Record<string, string>; error?: string }
	| { type: "scheduler_tasks"; tasks: SchedulerTaskView[] }
	| {
			type: "compacted_messages_result";
			compactionMessageId: string;
			conversationId: string;
			messages: UiMessage[];
			error?: string;
	  }
	| {
			type: "earlier_messages";
			conversationId: string;
			messages: UiMessage[];
			historyStart: number;
			historyTotal: number;
			historyGeneration?: string;
			beforeId?: string;
			before?: number;
			resyncRequired?: boolean;
	  }
	| {
			type: "remote_ssh_probe_result";
			reqId?: string;
			ok: boolean;
			connectionId?: string;
			error?: string;
			hostTrust?: RemoteSshHostTrustOffer;
			system?: RemoteSshSystemInfo;
			tools?: RemoteSshToolsInfo;
			packageManager?: string;
			suggestedInstall?: string[];
	  }
	| {
			type: "remote_ssh_trust_host_result";
			reqId?: string;
			ok: boolean;
			error?: string;
	  }
	| {
			type: "remote_ssh_list_dir_result";
			reqId?: string;
			ok: boolean;
			connectionId: string;
			path: string;
			parentPath?: string | null;
			items: RemoteSshDirItem[];
			error?: string;
	  }
	| {
			type: "remote_ssh_install_result";
			reqId?: string;
			ok: boolean;
			connectionId: string;
			tool: string;
			output?: string;
			error?: string;
	  }
	| {
			type: "remote_ssh_profiles_result";
			reqId?: string;
			profiles: RemoteSshProfileSummary[];
	  }
	| {
			type: "transition_progress";
			kind: "cwd" | "session" | "new_chat" | "conversation";
			target: string;
			phase: "fs" | "transcript" | "runtime" | "done" | "error";
			progress: number;
			text: string;
			textEn: string;
			totalMessages?: number;
			previewMessages?: UiMessage[];
			conversationId?: string;
			sessionFile?: string;
	  }
	| { type: "sandbox_diff"; diff: SandboxDiffView };

export interface DeviceExecutionSettings {
	maxActiveTasks: number;
	maxWaitingTasks: number;
	starvationThresholdMs: number;
	maxSkipsBeforeStarvation: number;
	maxDispatchDepth: number;
	maxDispatchBudget: number;
	allowBotMentions: boolean;
	groupContextBytes: number;
	groupRetentionLimit: number;
	fileSyncMaxBytes: number;
	fileSyncMaxFiles: number;
	fileSyncStagedBytes: number;
	resourceLockDefaultTtlMs: number;
	blackboardMaxBytes: number;
	taskReportExcerptBytes?: number;
	maxResourceLocksPerTask?: number;
	botMentionBudgetPerTurn?: number;
}

export type DeviceTaskBlockReason =
	| "none"
	| "max_concurrency_reached"
	| "bot_busy"
	| "workspace_conflict"
	| "workspace_blocked"
	| "room_fairness_yield"
	| "resource_locked"
	| "dependency"
	| "dependency_waiting";

export type DeviceBlockedTaskReason = "unconfirmed_stop" | "workspace_blocked";

export interface DeviceWaitingTaskSnapshot {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	queuedAt: number;
	queuePosition: number;
	blockReason: DeviceTaskBlockReason;
	blockReasonDetail: string;
	cancelable: boolean;
}

export interface DeviceRunningTaskSnapshot {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	startedAt: number;
}

export interface DeviceBlockedTaskSnapshot {
	taskId: string;
	attemptId: string;
	roomId: string;
	botId: string;
	reason: DeviceBlockedTaskReason;
}

export interface DeviceTaskSchedulerSnapshot {
	settings: DeviceExecutionSettings;
	activeCount: number;
	waitingCount: number;
	blockedCount: number;
	running: DeviceRunningTaskSnapshot[];
	waiting: DeviceWaitingTaskSnapshot[];
	blocked: DeviceBlockedTaskSnapshot[];
}

export interface DeviceFileTransferProgress {
	transferId: string;
	roomId: string;
	sourceBotId: string;
	targetBotId: string;
	status: "staging" | "staged" | "applied" | "cancelled" | "failed";
	totalBytes: number;
	transferredBytes: number;
	totalFiles: number;
	completedFiles: number;
	totalChunks: number;
	receivedChunks: number[];
	percent: number;
	error?: string;
}

export interface DeviceFileTransferPreviewItem {
	path: string;
	size: number;
	sha256: string;
	baseline: string | null;
	status: "create" | "identical" | "conflict";
}
