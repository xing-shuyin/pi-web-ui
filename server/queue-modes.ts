export function applyQueueModesToSession(
	session: {
		settingsManager: { applyOverrides: (settings: { steeringMode: QueueMode; followUpMode: QueueMode }) => void };
		agent: { steeringMode: QueueMode; followUpMode: QueueMode };
	},
	settings: { steeringMode?: QueueMode; followUpMode?: QueueMode },
): void {
	const steeringMode = settings.steeringMode ?? "all";
	const followUpMode = settings.followUpMode ?? "all";
	session.settingsManager.applyOverrides({ steeringMode, followUpMode });
	session.agent.steeringMode = steeringMode;
	session.agent.followUpMode = followUpMode;
}

type QueueMode = "all" | "one-at-a-time";
