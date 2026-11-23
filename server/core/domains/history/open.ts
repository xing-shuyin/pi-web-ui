import { readFile as readFileFromDisk } from "node:fs/promises";
import type { UiMessage } from "../../../protocol.js";
import { Conversation, type ConversationRegistry } from "../../kernel/conversation/index.js";
import { projectTranscriptText } from "./transcript.js";

export interface OpenHistoryInput {
	registry: ConversationRegistry<Conversation>;
	clientId: string;
	cwd: string;
	/** 磁盘历史条目：`sessionFile` 是「已开没开过」的唯一判据；`id` 给了就沿用成对话身份。 */
	entry: { sessionFile: string; title: string; id?: string };
	now: number;
	/** 读整份转录（utf8）。缺省读磁盘，测试里只替换掉这一层。 */
	readFile?: (path: string) => Promise<string>;
}

export interface OpenedHistoryConversation {
	conversation: Conversation;
	messages: UiMessage[];
	skippedLines: number;
}

/**
 * 整份转录不可用（读盘失败 / 投影抛错）时按一条计：这时拿不到任何行数，多编数字没意义。
 * 调用方靠「`messages` 为空 + 计数 ≥ 1」区分空会话与这次没读到。
 */
const UNAVAILABLE_SKIPPED_LINES = 1;

function readTranscriptFile(path: string): Promise<string> {
	return readFileFromDisk(path, "utf8");
}

/**
 * 同一会话文件只允许一个对话：已开过就激活旧的（不重建），没开过才新建。
 * 新建时身份优先沿用条目 id —— 左栏历史行的身份就是它，同 id 才能被认成同一行。
 */
function conversationOf(input: OpenHistoryInput): Conversation {
	const opened = input.registry.bySessionFile(input.entry.sessionFile);
	if (opened) return input.registry.activate(opened.id);
	const entryId = input.entry.id?.trim();
	const conversation = new Conversation({
		id: entryId || `c-${input.registry.nextSeq()}`,
		clientId: input.clientId,
		cwd: input.cwd,
		kind: "user",
		createdAt: input.now,
		title: input.entry.title,
		sessionFile: input.entry.sessionFile,
	});
	input.registry.add(conversation);
	return input.registry.activate(conversation.id);
}

/**
 * 打开一份磁盘历史会话：对话先落定（新建或复用旧的）并成为活动对话，再按当前磁盘内容重新投影消息。
 * 读盘与投影失败都不抛：返回空 `messages` + 跳过计数，已建立的对话留给调用方。
 */
export async function openHistoryConversation(input: OpenHistoryInput): Promise<OpenedHistoryConversation> {
	const conversation = conversationOf(input);
	let text: string;
	try {
		text = await (input.readFile ?? readTranscriptFile)(input.entry.sessionFile);
	} catch {
		return { conversation, messages: [], skippedLines: UNAVAILABLE_SKIPPED_LINES };
	}
	try {
		const projected = projectTranscriptText(text);
		return { conversation, messages: projected.projection.messages, skippedLines: projected.skippedLines };
	} catch {
		return { conversation, messages: [], skippedLines: UNAVAILABLE_SKIPPED_LINES };
	}
}
