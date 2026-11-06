import type { ProviderOAuthFlowState, ServerMessage } from "./types";

export interface ProviderOAuthResultState {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
}

interface ProviderOAuthClientState {
	flows: ProviderOAuthFlowState[];
	results: Record<string, ProviderOAuthResultState>;
}

export type ProviderOAuthServerMessage = Extract<
	ServerMessage,
	{
		type:
			| "provider_oauth_started"
			| "provider_oauth_flows"
			| "provider_oauth_prompt"
			| "provider_oauth_event"
			| "provider_oauth_result"
			| "provider_oauth_logout_result";
	}
>;

export function initialProviderOAuthState(): ProviderOAuthClientState {
	return { flows: [], results: {} };
}

function replaceFlow(flows: ProviderOAuthFlowState[], next: ProviderOAuthFlowState): ProviderOAuthFlowState[] {
	const index = flows.findIndex((flow) => flow.flowId === next.flowId);
	if (index < 0) return [...flows, next];
	return flows.map((flow, current) => (current === index ? next : flow));
}

export function reduceProviderOAuthState(
	state: ProviderOAuthClientState,
	message: ProviderOAuthServerMessage,
): ProviderOAuthClientState {
	switch (message.type) {
		case "provider_oauth_started": {
			const results = { ...state.results };
			delete results[message.provider];
			return {
				flows: [
					...state.flows.filter((flow) => flow.provider !== message.provider),
					{ flowId: message.flowId, provider: message.provider },
				],
				results,
			};
		}
		case "provider_oauth_flows":
			return { ...state, flows: message.flows.map((flow) => ({ ...flow })) };
		case "provider_oauth_prompt": {
			const current = state.flows.find((flow) => flow.flowId === message.flowId);
			return {
				...state,
				flows: replaceFlow(state.flows, {
					...current,
					flowId: message.flowId,
					provider: message.provider,
					promptId: message.promptId,
					prompt: message.prompt,
				}),
			};
		}
		case "provider_oauth_event": {
			const current = state.flows.find((flow) => flow.flowId === message.flowId);
			return {
				...state,
				flows: replaceFlow(state.flows, {
					...current,
					flowId: message.flowId,
					provider: message.provider,
					event: message.event,
					promptId: undefined,
					prompt: undefined,
				}),
			};
		}
		case "provider_oauth_result":
			return {
				flows: state.flows.filter((flow) => flow.flowId !== message.flowId),
				results: {
					...state.results,
					[message.provider]: {
						ok: message.ok,
						...(message.cancelled === undefined ? {} : { cancelled: message.cancelled }),
						...(message.error === undefined ? {} : { error: message.error }),
					},
				},
			};
		case "provider_oauth_logout_result":
			return {
				...state,
				results: {
					...state.results,
					[message.provider]: {
						ok: message.ok,
						...(message.error === undefined ? {} : { error: message.error }),
					},
				},
			};
	}
}
