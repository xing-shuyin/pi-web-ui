export function syncModelDraft<T extends { id: string }>(draft: T[], previous: T[], incoming: T[]): T[] {
	if (JSON.stringify(draft) === JSON.stringify(previous)) return incoming;
	const before = new Map(previous.map((model) => [model.id, model]));
	const next = new Map(incoming.map((model) => [model.id, model]));
	const localIds = new Set(draft.map((model) => model.id));
	const result = draft.flatMap((model) => {
		const old = before.get(model.id);
		if (!old || JSON.stringify(old) !== JSON.stringify(model)) return [model];
		const updated = next.get(model.id);
		return updated ? [updated] : [];
	});
	for (const model of incoming) {
		if (!before.has(model.id) && !localIds.has(model.id)) result.push(model);
	}
	return result;
}
