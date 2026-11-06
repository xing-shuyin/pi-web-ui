interface StreamingCueFinished {
	id: string;
	title?: string;
	isActive: boolean;
	isSubagent: boolean;
}

interface StreamingCuesDiff {
	startCue: boolean;
	finishedConvs: StreamingCueFinished[];
	nextMap: Map<string, boolean>;
}

export interface StreamingCueConversation {
	id: string;
	title?: string;
	isStreaming?: boolean;
	completionPending?: boolean;
	isSubagent?: boolean;
}

export function diffStreamingCues(
	prevMap: Map<string, boolean> | null,
	activeId: string | null,
	activeStreaming: boolean,
	conversations: readonly StreamingCueConversation[],
	prevActiveId?: string | null,
	activeCompletionPending = false,
): StreamingCuesDiff {
	const currentMap = new Map<string, boolean>();
	for (const c of conversations) {
		currentMap.set(c.id, !!c.isStreaming || !!c.completionPending);
	}
	if (activeId) {
		currentMap.set(activeId, activeStreaming || activeCompletionPending);
	}

	if (prevMap === null) {
		return {
			startCue: false,
			finishedConvs: [],
			nextMap: currentMap,
		};
	}

	let startCue = false;
	if (activeId && (prevActiveId === undefined || prevActiveId === activeId)) {
		const prevActive = prevMap.get(activeId);
		const nowActive = activeStreaming;
		if (prevActive === false && nowActive === true) {
			startCue = true;
		}
	}

	const finishedConvs: StreamingCueFinished[] = [];
	for (const [id, wasStreaming] of prevMap.entries()) {
		if (!wasStreaming) continue;
		if (currentMap.has(id) && !currentMap.get(id)) {
			const c = conversations.find((item) => item.id === id);
			finishedConvs.push({
				id,
				title: c?.title,
				isActive: id === activeId,
				isSubagent: !!c?.isSubagent,
			});
		}
	}

	return {
		startCue,
		finishedConvs,
		nextMap: currentMap,
	};
}
