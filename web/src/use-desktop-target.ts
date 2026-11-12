import { useEffect, useState } from "react";
import { requestDeviceAccessUrl, type DesktopAccess } from "./device-access";

export function useDesktopTarget(access: DesktopAccess) {
	const [target, setTarget] = useState<{ url: string; transport: "lan" | "hub" }>();
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setTarget(undefined);
		setError("");
		void requestDeviceAccessUrl(access.id, access.hubUrl, true, access.zh, access.mode === "preview", controller.signal)
			.then((next) => {
				if (!controller.signal.aborted) setTarget(next);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => controller.abort();
	}, [access.revision, access.mode, access.id, access.hubUrl, access.zh, attempt]);
	return { target, error, retry: () => setAttempt((value) => value + 1) };
}
