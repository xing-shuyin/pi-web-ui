import { createRoot } from "react-dom/client";
import { MessageList } from "../../web/src/components/MessageList";
import { LanguageProvider } from "../../web/src/i18n";
import { TemplateProvider } from "../../web/src/components/PromptTemplates";
import { _chatReducerForTest } from "../../web/src/use-chat";
import "../../web/src/styles.css";

const root = createRoot(document.getElementById("root")!);
const maps = { liveOutputs: new Map(), toolStatuses: new Map() };
const history = Array.from({ length: 12 }, (_, i) => ({
	id: `u-${i}`,
	role: "user",
	content: [{ type: "text", text: `Earlier question ${i}\n` + "Earlier visible text. ".repeat(20) }],
}));
let state: any = {
	cwd: "/stream-test",
	sessionId: "test",
	sessionFile: "/test.jsonl",
	messages: history,
	isStreaming: true,
	streamingMessage: null,
	queuedMessages: [],
	queue: { steering: [], followUp: [] },
};
function render() {
	root.render(
		<LanguageProvider>
			<TemplateProvider currentModelId={null}>
				<div style={{ height: 500, display: "flex", flexDirection: "column" }}>
					<MessageList state={state} {...maps} uiMessageActions={[]} keepRecent={100} />
				</div>
			</TemplateProvider>
		</LanguageProvider>,
	);
}
(window as any).streamTest = {
	frame(msg: any) {
		if (msg.type === "snapshot") {
			state = msg.state;
		} else if (msg.type === "snapshot_delta") {
			state = _chatReducerForTest({ state } as any, { type: "snapshot_delta", msg }).state;
		} else if (msg.type === "message_delta") {
			state = _chatReducerForTest({ state } as any, { type: "message_delta", msg }).state;
		}
		render();
	},
	state() {
		return state;
	},
	update(text: string) {
		state = {
			...state,
			isStreaming: true,
			streamingMessage: { id: "stream-123", role: "assistant", content: [{ type: "text", text }], timestamp: 123 },
		};
		render();
	},
	tool() {
		state = {
			...state,
			messages: history,
			isStreaming: true,
			streamingMessage: {
				id: "stream-123",
				role: "assistant",
				content: [{ type: "thinking", thinking: "Stable reasoning" }],
				timestamp: 123,
			},
		};
		render();
	},
	toolText() {
		state = {
			...state,
			streamingMessage: {
				...state.streamingMessage,
				content: [...state.streamingMessage.content, { type: "text", text: "Body after reasoning." }],
			},
		};
		render();
	},
	finish(reason = "stop") {
		state = {
			...state,
			isStreaming: false,
			messages: [...history, { ...state.streamingMessage, id: "a-123-1", stopReason: reason }],
			streamingMessage: null,
		};
		render();
	},
	reset() {
		state = { ...state, messages: history, isStreaming: true, streamingMessage: null };
		render();
	},
};
render();
