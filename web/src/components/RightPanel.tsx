import { useCallback, useEffect, useRef, useState } from "react";
import {
	FiChevronRight,
	FiDownload,
	FiFile,
	FiFolder,
	FiLink,
	FiPlus,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { downloadFile } from "../download";

type AttachMode = "inline" | "reference";

interface RightPanelProps {
	chat: ChatState;
	send: (msg: { type: "list_files"; path?: string }) => boolean;
	/** Called when the user clicks an attach button on a file or folder. */
	onAttach: (
		path: string,
		name: string,
		mode: AttachMode,
		isDir?: boolean,
	) => void;
	/** Called when the user clicks a file to open the preview modal. */
	onPreview: (path: string, name: string) => void;
	/** Show a transient toast (download errors etc.). */
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
}

export function RightPanel({
	chat,
	send,
	onAttach,
	onPreview,
	onNotice,
}: RightPanelProps) {
	const t = useT();
	const [currentPath, setCurrentPath] = useState<string>("");
	const [loading, setLoading] = useState(false);
	const files = chat.files;

	/** How often to silently re-poll the current directory (ms). */
	const AUTO_REFRESH_MS = 10_000;

	// Monotonic request id — responses are only trusted if they match the latest
	// requested path (guards against out-of-order responses when navigating fast).
	const reqSeq = useRef(0);

	// Last cwd we listed — when the workspace switches, jump back to its root.
	const lastCwd = useRef<string | undefined>(undefined);

	const request = useCallback(
		(path: string, opts?: { silent?: boolean }) => {
			const seq = ++reqSeq.current;
			setCurrentPath(path);
			// Silent refreshes (polling / cwd switch) keep the current listing on
			// screen instead of flashing the loading placeholder.
			if (!opts?.silent) setLoading(true);
			const ok = send({
				type: "list_files",
				path: path === "" ? undefined : path,
			});
			if (!ok) {
				// Not connected — nothing will arrive; back off the spinner.
				if (reqSeq.current === seq) setLoading(false);
			}
		},
		[send],
	);

	// The server response arrives via chat.files; only treat it as the answer to
	// the current navigation if its path matches (stale/out-of-order responses
	// for other directories keep the spinner up).
	useEffect(() => {
		if (files && files.path === currentPath) setLoading(false);
	}, [files, currentPath]);

	// Auto-refresh: when the cwd changes (project switch / set_cwd) re-list its
	// root; otherwise poll the current directory silently so the tree stays fresh
	// without a manual refresh button.
	useEffect(() => {
		const cwd = chat.state?.cwd;
		if (cwd !== lastCwd.current) {
			lastCwd.current = cwd;
			request("", { silent: true });
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			request(currentPath, { silent: true });
		}, AUTO_REFRESH_MS);
		return () => clearInterval(timer);
	}, [chat.state?.cwd, currentPath, request]);
	// The server fs.watches the listed directory and pushes `file_changed` on any
	// change — refresh right away instead of waiting for the 10s poll. The path
	// guard drops events for a directory the user has already navigated away from.
	useEffect(() => {
		const ev = chat.fileChanged;
		if (ev && ev.path === currentPath) request(currentPath, { silent: true });
	}, [chat.fileChanged, currentPath, request]);

	// Enter a directory.
	const openDir = (path: string) => request(path);
	// Go back to the parent.
	const goUp = () => {
		if (files?.parent !== null && files?.parent !== undefined) {
			request(files.parent);
		}
	};

	const crumbs = currentPath.split("/").filter(Boolean);

	return (
		<aside className="panel panel-right">
			<div className="panel-crumbs">
				<button
					type="button"
					className={`crumb ${currentPath === "" ? "active" : ""}`}
					onClick={() => request("")}
				>
					{t("rootDir")}
				</button>
				{crumbs.map((c, i) => {
					const path = crumbs.slice(0, i + 1).join("/");
					return (
						<span key={path} className="crumb-seg">
							<FiChevronRight />
							<button
								type="button"
								className={`crumb ${path === currentPath ? "active" : ""}`}
								onClick={() => request(path)}
							>
								{c}
							</button>
						</span>
					);
				})}
			</div>
			<div className="panel-body">
				{loading && <div className="panel-empty">{t("loading")}</div>}
				{!loading && files && files.path === currentPath && (
					<>
						{files.path !== "" && (
							<button type="button" className="file-item dir" onClick={goUp}>
								<FiFolder className="file-icon" />
								<span className="file-name">..</span>
							</button>
						)}
						{files.entries.map((e) =>
							e.type === "dir" ? (
								<div key={e.path} className="file-item dir">
									<button
										type="button"
										className="file-dir-main"
										onClick={() => openDir(e.path)}
									>
										<FiFolder className="file-icon" />
										<span className="file-name">{e.name}</span>
									</button>
									<button
										type="button"
										className="file-attach ref"
										data-tip={t("linkFolderTip")}
										onClick={() => onAttach(e.path, e.name, "reference", true)}
									>
										<FiLink />
									</button>
								</div>
							) : (
								<div key={e.path} className="file-item file">
									<button
										type="button"
										className="file-name"
										title={`${e.path} — ${t("previewFile")}`}
										onClick={() => onPreview(e.path, e.name)}
									>
										<FiFile className="file-icon" />
										<span className="file-name-text">{e.name}</span>
									</button>
									{/* Download: any file, previewable or not (binary/archives
									too). Fetched as a blob so Safe Browsing can't block the
									HTTP download and failures show a readable error. */}
									<button
										type="button"
										className="file-attach download"
										data-tip={t("downloadFile")}
										onClick={() => {
											void downloadFile(e.path, e.name).then((r) => {
												if (r.ok) return;
												// cancelled: user dismissed the save dialog — not an error.
												if (r.cancelled) return;
												onNotice(
													"error",
													t("downloadFailed", { error: r.error }),
												);
											});
										}}
									>
										<FiDownload />
									</button>
									<button
										type="button"
										className="file-attach inline"
										data-tip={t("attachInlineTip")}
										onClick={() => onAttach(e.path, e.name, "inline")}
									>
										<FiPlus />
									</button>
									<button
										type="button"
										className="file-attach ref"
										data-tip={t("referenceTip")}
										onClick={() => onAttach(e.path, e.name, "reference")}
									>
										<FiLink />
									</button>
								</div>
							),
						)}
						{files.truncated && (
							<div className="panel-empty files-truncated">
								{t("filesTruncated")}
							</div>
						)}
					</>
				)}
				{!loading && !files && (
					<div className="panel-empty">{t("noFiles")}</div>
				)}
			</div>
			{chat.widgets.filter((w) => w.lines.length > 0).length > 0 && (
				<div className="panel-widgets">
					{chat.widgets
						.filter((w) => w.lines.length > 0)
						.map((w) => (
							<div key={w.key} className="widget">
								<div className="widget-title">{w.key}</div>
								<pre className="widget-lines">{w.lines.join("\n")}</pre>
							</div>
						))}
				</div>
			)}
		</aside>
	);
}
