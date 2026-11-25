export {
	canDeleteSessionPath,
	deleteSessionFile,
	dismissConversation,
	renameConversation,
	renameSession,
	type DismissConversationInput,
	type DismissConversationResult,
	type RenameConversationInput,
	type RenameConversationResult,
	type SessionAdminDeps,
	type SessionFileDeletion,
	type SessionFileDeletionReason,
} from "./admin.js";
export {
	createConversationStateHandlers,
	type ConversationStateHandlers,
	type ConversationStateOptions,
} from "./state.js";
export {
	rebindSession,
	displacePrevious,
	type DisplaceContext,
	type RebindContext,
	type RebindFrames,
	type RebindRequest,
	type RebindResult,
	type RebindSessions,
} from "./rebind.js";
export {
	createRetainOnDisplace,
	retainFactsOf,
	shouldRetainOnDisplace,
	type DisplaceRetainFacts,
	type RetainEnv,
} from "./retain.js";
export { createWorkspaceSwitcher, type WorkspaceRootsStore, type WorkspaceSwitcherOptions } from "./workspace.js";
export { createSessionEntityHandlers, type SessionEntityHandlers, type SessionEntityOptions } from "./entity.js";
export {
	ConversationPinIndex,
	createSessionPins,
	mergePinState,
	type ConversationPinState,
	type SessionPinsHandlers,
	type SessionPinsOptions,
} from "./pins.js";
export { createSessionForks, type SessionForkHandlers, type SessionForkOptions } from "./fork.js";
export { createSessionRollbacks, type SessionRollbackHandlers, type SessionRollbackOptions } from "./rollback.js";
export {
	createCompactedMessagesHandlers,
	type CompactedMessagesHandlers,
	type CompactedMessagesOptions,
} from "./compacted.js";
export {
	createPersistConversationHandlers,
	type PersistConversationHandlers,
	type PersistConversationOptions,
	type SessionPersistPort,
} from "./persist.js";
export {
	getCompactedMessages,
	sliceCompactedEntries,
	serializeCompactedEntries,
	walkAncestors,
	type SessionEntryLike,
	type SessionManagerLike,
} from "./compacted-history.js";
