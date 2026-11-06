export interface SubagentHandoffRecord {
	fromRunId: string;
	toRunId: string;
	timestamp: number;
}

export function formatSubagentHandoffMessage(fromType: string, fromRunId: string, payload: string): string {
	return `[Peer Hand-off from ${fromType} subagent (${fromRunId.slice(0, 8)})]:\n\n${payload}`;
}

export function recordSubagentHandoff(
	history: SubagentHandoffRecord[],
	record: SubagentHandoffRecord,
	maxHistory = 50,
): SubagentHandoffRecord[] {
	const next = [...history, record];
	return next.length > maxHistory ? next.slice(-maxHistory) : next;
}
