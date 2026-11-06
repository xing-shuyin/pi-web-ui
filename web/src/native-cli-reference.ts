import type { DraftAttachment } from "./composer-draft";
import type { PromptAttachment } from "./types";

export type NativeCliReferenceAttachment = PromptAttachment & Pick<DraftAttachment, "isDir" | "key">;

export interface NativeCliReferencePlan {
	text: string;
	attachments: PromptAttachment[];
}

export function planNativeCliReferences(references: readonly NativeCliReferenceAttachment[]): NativeCliReferencePlan {
	const descriptions: string[] = [];
	const attachments: PromptAttachment[] = [];
	for (const reference of references) {
		switch (reference.mode) {
			case "quote": {
				if (typeof reference.quote?.text !== "string") throw new Error("Text quote is missing its source text");
				const { text: _text, ...source } = reference.quote;
				attachments.push({ ...reference });
				descriptions.push(`Quoted text source: ${JSON.stringify({ name: reference.name, ...source })}`);
				break;
			}
			case "page":
				attachments.push({ ...reference });
				descriptions.push(`Web page reference: ${JSON.stringify({ name: reference.name, target: reference.path })}`);
				break;
			case "conversation":
				attachments.push({ ...reference });
				descriptions.push(
					`Conversation reference: ${JSON.stringify({
						name: reference.name,
						conversationId: reference.conversationId,
						sessionPath: reference.sessionPath,
					})}`,
				);
				break;
			case "canvas":
				attachments.push({ ...reference });
				descriptions.push(`Canvas reference: ${JSON.stringify({ name: reference.name, graphId: reference.path })}`);
				break;
			default:
				attachments.push({ ...reference });
		}
	}
	return { text: descriptions.join("\n\n"), attachments };
}
