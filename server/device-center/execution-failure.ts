import { DeviceTaskError } from "./task-error.js";

export type ExecutionPhase = "handshake" | "init" | "new_chat" | "switch_session" | "model" | "tool" | "approval";

const reasons = {
	model_missing: "Configured Bot model is unavailable; check the Bot model and local model catalog.",
	model_auth: "Model authentication failed; check credentials on the target device.",
	model_rate_limit: "Model request was rate limited (429); no automatic retry.",
	model_unavailable: "Model provider is unavailable; inspect the local task conversation.",
	unsupported_command: "The local agent rejected an unsupported command or API operation.",
	capability_revoked: "Bot execution capability is invalid or revoked.",
	tool_denied: "A required tool is unavailable or denied by the Bot policy.",
	approval_required: "Task paused for local human input or approval.",
	conversation_limit: "Local conversation limit reached; free a conversation on the target device.",
	connection: "Local agent connection failed or disconnected; execution outcome may be uncertain.",
	timeout: "Task timed out; no automatic retry.",
	cancelled: "Local task execution was cancelled.",
	ownership: "Task session ownership validation failed.",
	workspace: "Task workspace initialization failed.",
	protocol: "Local agent protocol validation failed.",
	empty_result: "Execution ended without assistant text.",
	execution_failed: "Local agent execution failed; inspect the retained task conversation on the target device.",
} as const;
export type ExecutionFailureCategory = keyof typeof reasons;
export interface ExecutionFailure {
	phase: ExecutionPhase;
	category: ExecutionFailureCategory;
	detail: string;
}

export function executionFailure(reason: string, phase: ExecutionPhase): ExecutionFailure {
	let category: ExecutionFailureCategory = "execution_failed";
	if (
		/configured Bot model is unavailable|model[^\n]*(?:not found|does not exist|unavailable|unknown)|explicit local default model/i.test(
			reason,
		)
	)
		category = "model_missing";
	else if (
		/\b(?:401|403)\b|unauthori[sz]ed|authentication|invalid[_ -](?:api[_ -]?)?key|no api key|missing.*api key/i.test(
			reason,
		)
	)
		category = "model_auth";
	else if (/\b429\b|rate[_ -]?limit|too many requests/i.test(reason)) category = "model_rate_limit";
	else if (/\b50[0234]\b|service unavailable|overloaded/i.test(reason)) category = "model_unavailable";
	else if (/unsupported|unknown command|slash commands are disabled|control command denied/i.test(reason))
		category = "unsupported_command";
	else if (/capability|unregistered Bot execution/i.test(reason)) category = "capability_revoked";
	else if (/human|approval/i.test(reason)) {
		category = "approval_required";
		phase = "approval";
	} else if (/tool[^\n]*(?:denied|not allowed|unavailable|disabled)/i.test(reason)) {
		category = "tool_denied";
		phase = "tool";
	} else if (/conversation limit|会话.*上限/i.test(reason)) category = "conversation_limit";
	else if (/WebSocket/i.test(reason)) category = "connection";
	else if (/timeout/i.test(reason)) category = "timeout";
	else if (/cancelled|Executor closed|Assistant aborted/i.test(reason)) category = "cancelled";
	else if (/ownership|SDK session/i.test(reason)) category = "ownership";
	else if (/cwd|workspace/i.test(reason)) category = "workspace";
	else if (/protocol|handshake|snapshot client/i.test(reason)) category = "protocol";
	else if (/without assistant text/i.test(reason)) category = "empty_result";
	return { phase, category, detail: reasons[category] };
}

export class DeviceExecutionError extends DeviceTaskError {
	constructor(
		readonly failure: ExecutionFailure,
		localDiagnostic: string,
	) {
		super(
			`Device task failed [phase=${failure.phase}; category=${failure.category}]. ${failure.detail}`,
			localDiagnostic,
		);
		this.name = "DeviceExecutionError";
	}
}
