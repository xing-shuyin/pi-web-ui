import { useEffect, type RefObject } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { pageDeviceId } from "../device-access";
import { desktopFilesBridge, desktopFilesRequest } from "../../../server/device-center/desktop-files-bridge";
import { desktopFileManager } from "../../../server/device-center/desktop-file-manager";
import { desktopBrowserFiles } from "../../../server/device-center/desktop-files-browser";
import { fileChunkCrc } from "../../../server/device-center/desktop-files-protocol";

export function DesktopFilesControl({
	frame,
	url,
	local,
}: {
	frame: RefObject<HTMLIFrameElement | null>;
	url?: string;
	local: boolean;
}) {
	useEffect(() => {
		const nested = Boolean(pageDeviceId()),
			native = !nested && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
		const bridge = desktopFilesBridge({
			frame: () => frame.current?.contentWindow,
			origin: local && url ? new URL(url).origin : "null",
			nested,
			manager: (remote) =>
				desktopFileManager({
					remote,
					local: native
						? desktopFilesRequest((path) => withToken(appUrl("/api/device-desktop/local/files/" + path)), true)
						: undefined,
					crc: fileChunkCrc,
					browser: () => desktopBrowserFiles(fileChunkCrc),
				}),
		});
		return () => bridge.close();
	}, [frame, url, local]);
	return null;
}
