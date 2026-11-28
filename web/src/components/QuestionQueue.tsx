import { appSend } from "../app-globals";
import { useT } from "../i18n";
import { presentablePending } from "../pending-queue";
import {
	isCurrentQuestion,
	questionProjectLabel,
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
	currentCwd?: string | null;
	mode: QuestionQueueMode;
}

export function QuestionQueue({ questions, activeConversationId, currentCwd, mode }: QuestionQueueProps) {
	const t = useT();
	const projectOf = (q: QueueQuestion) => questionProjectLabel(q, currentCwd);
	const navigate = (q: QueueQuestion) => {
		const message = questionNavigation(q);
		if (message) appSend(message);
	};
	const canNav = (q: QueueQuestion) =>
		!!(q.rootConversationId || q.conversationId) &&
		(!!q.owner ||
			(q.conversationId ? q.conversationId !== activeConversationId : !isCurrentQuestion(q, activeConversationId)));
	return (
		<PendingQueue
			items={presentablePending(
				questions.filter((q) => q.audience === "user"),
				activeConversationId,
				mode,
			)}
			itemKey={questionQueueKey}
			title={t("questionQueueTitle")}
			summary={(q) => (
				<>
					{projectOf(q) && <span className="question-conv-title">{projectOf(q)}</span>}
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
			canNavigate={canNav}
		>
			{(selected, defer) => {
				const showSource = canNav(selected) || Boolean(projectOf(selected));
				const dialogQuestion = showSource ? selected : { ...selected, conversationTitle: undefined };
				return (
					<QuestionDialog
						key={questionQueueKey(selected)}
						question={dialogQuestion}
						owner={selected.owner}
						project={projectOf(selected)}
						onDefer={defer}
						onNavigate={canNav(selected) ? () => navigate(selected) : undefined}
					/>
				);
			}}
		</PendingQueue>
	);
}
