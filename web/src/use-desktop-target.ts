import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { requestDeviceAccessUrl, type DesktopAccess, type DesktopTransport } from "./device-access";

export function useDesktopTarget(access: DesktopAccess) {
	const t = useT();
	const [target, setTarget] = useState<{ url: string; transport: DesktopTransport }>();
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setTarget(undefined);
		setError("");
		void requestDeviceAccessUrl(
			access.id,
			access.hubUrl,
			true,
			t,
			access.mode === "preview",
			controller.signal,
			access.local,
		)
			.then((next) => {
				if (!controller.signal.aborted) setTarget(next);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => controller.abort();
	}, [access.revision, access.mode, access.id, access.hubUrl, access.local, attempt, t]);
	return { target, error, retry: () => setAttempt((value) => value + 1) };
}
