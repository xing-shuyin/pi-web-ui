import { appSend } from "../app-globals";
import { useT } from "../i18n";
import {
	isCurrentQuestion,
	questionQueueKey,
	questionNavigation,
	type QueueQuestion,
	type QuestionQueueMode,
} from "../question-queue";
import { QuestionDialog } from "./QuestionDialog";
import { PendingQueue } from "./PendingQueue";

export interface QuestionQueueProps {
	questions: QueueQuestion[];
	activeConversationId?: string | null;
	mode: QuestionQueueMode;
}

export function QuestionQueue({ questions, activeConversationId, mode }: QuestionQueueProps) {
	const t = useT();
	const navigate = (q: QueueQuestion) => {
		const message = questionNavigation(q);
		if (message) appSend(message);
	};
	return (
		<PendingQueue
			items={questions.filter((q) => q.audience === "user")}
			itemKey={questionQueueKey}
			title={t("questionQueueTitle")}
			summary={(q) => (
				<>
					{q.conversationTitle && <strong>{q.conversationTitle} · </strong>}
					{q.questions[0]?.header || q.questions[0]?.question || t("modelQuestion")}
				</>
			)}
			createdAt={(q) => q.createdAt}
			canAutoOpen={(q) =>
				mode !== "manual" &&
				(q.global || mode === "all" || q.conversationId === activeConversationId || !q.conversationId)
			}
			onNavigate={navigate}
			canNavigate={(q) =>
				!!(q.rootConversationId || q.conversationId) &&
				(!!q.owner ||
					(q.conversationId ? q.conversationId !== activeConversationId : !isCurrentQuestion(q, activeConversationId)))
			}
		>
			{(selected, defer) => (
				<QuestionDialog
					key={questionQueueKey(selected)}
					question={selected}
					owner={selected.owner}
					onDefer={defer}
					onNavigate={selected.rootConversationId || selected.conversationId ? () => navigate(selected) : undefined}
				/>
			)}
		</PendingQueue>
	);
}
