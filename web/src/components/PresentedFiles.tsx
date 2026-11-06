import { memo, useEffect, useMemo, useState } from "react";
import { FiCopy, FiDownload, FiExternalLink, FiEye, FiFolder } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { appResourceCrossOrigin } from "../base-url";
import { DOWNLOAD_FILE_NOT_FOUND, downloadFile, downloadUrl } from "../download";
import { isFilePreviewOpen, openFilePreview } from "../file-preview-bridge";
import { isLoopbackAccess, resolveWorkspaceFileUrl } from "../workspace-file-url";
import {
	focusPresentItem,
	formatPresentSize,
	inlineMediaKind,
	presentCardItems,
	presentKindIcon,
	presentNote,
	presentTitle,
	previewablePresentKind,
	type PresentArgs,
	type PresentCardItem,
} from "../present-items";
import { takeAutoOpen, usePresentAutoOpen } from "../present-settings";
import { Markdown } from "./Markdown";
import { useCopyFeedback } from "../use-copy-feedback";

interface PresentedFilesProps {
	args: PresentArgs;
	details?: unknown;
	toolCallId: string;
	resultTimestamp?: number;
}

export const PresentedFiles = memo(function PresentedFiles({
	args,
	details,
	toolCallId,
	resultTimestamp,
}: PresentedFilesProps) {
	const t = useT();
	const autoOpen = usePresentAutoOpen();
	const items = useMemo(() => presentCardItems(args, details), [args, details]);
	const title = presentTitle(args, details);
	const note = presentNote(args, details);
	const focus = useMemo(() => focusPresentItem(items), [items]);

	useEffect(() => {
		if (!autoOpen || !focus || !toolCallId) return;
		if (isFilePreviewOpen()) return;
		if (!takeAutoOpen(toolCallId, resultTimestamp)) return;
		openFilePreview({ path: focus.target, name: focus.name });
	}, [autoOpen, focus, toolCallId, resultTimestamp]);

	if (items.length === 0) {
		return <div className="present-empty">{t("presentEmpty")}</div>;
	}

	return (
		<div className="present-card">
			{title && <div className="present-title">{title}</div>}
			{note && (
				<div className="present-note">
					<Markdown text={note} rawHtml />
				</div>
			)}
			<div className="present-items">
				{items.map((item) => (
					<PresentRow key={`${item.target}\u0000${item.path}`} item={item} />
				))}
			</div>
		</div>
	);
});

function itemTitle(item: PresentCardItem): string {
	if (typeof item.mtime !== "number") return item.path;
	return `${item.path}\n${new Date(item.mtime).toLocaleString()}`;
}

function PresentRow({ item }: { item: PresentCardItem }) {
	const t = useT();
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const [mediaFailed, setMediaFailed] = useState(false);
	const [downloadError, setDownloadError] = useState("");

	const media = mediaFailed ? null : inlineMediaKind(item.kind);
	const size = formatPresentSize(item.size);
	const missing = item.kind === "missing";
	const target = { path: item.target, name: item.name };
	const isRemote = !isLoopbackAccess();
	const webFileUrl = resolveWorkspaceFileUrl(item.target);

	const copyPath = () => {
		void copy(item.path);
	};

	const download = () => {
		setDownloadError("");
		void downloadFile(item.target, item.name).then((r) => {
			if (r.ok || r.cancelled) return;
			setDownloadError(r.error === DOWNLOAD_FILE_NOT_FOUND ? t("fileNotFoundShort") : r.error);
		});
	};

	return (
		<div className={`present-item${missing ? " missing" : ""}`}>
			<div className="present-item-head">
				<span className="present-item-icon" aria-hidden="true">
					{presentKindIcon(item.kind)}
				</span>
				<span className="present-item-name" title={itemTitle(item)}>
					{item.name}
				</span>
				{item.caption && <span className="present-item-caption">{item.caption}</span>}
				{size && !missing && <span className="present-item-meta">{size}</span>}
				<span className="present-item-spacer" />
				{!missing && (
					<>
						{previewablePresentKind(item.kind) && (
							<button
								type="button"
								className="present-btn"
								title={t("previewFile")}
								aria-label={t("previewFile")}
								onClick={() => openFilePreview(target)}
							>
								<FiEye />
							</button>
						)}
						{isRemote ? (
							<a
								className="present-btn labeled"
								href={webFileUrl}
								target="_blank"
								rel="noreferrer noopener"
								title={t("openInNewTab")}
							>
								<FiExternalLink />
								<span>{t("openInNewTab")}</span>
							</a>
						) : (
							<button
								type="button"
								className="present-btn labeled"
								title={t("fileOpenDefault")}
								onClick={() => appSend({ type: "file_open_default", path: item.target })}
							>
								<FiExternalLink />
								<span>{t("presentOpenLocal")}</span>
							</button>
						)}
						{!isRemote && (
							<button
								type="button"
								className="present-btn"
								title={t("fileReveal")}
								aria-label={t("fileReveal")}
								onClick={() => appSend({ type: "file_reveal", path: item.target })}
							>
								<FiFolder />
							</button>
						)}
						<button
							type="button"
							className="present-btn"
							title={t("downloadFile")}
							aria-label={t("downloadFile")}
							onClick={download}
						>
							<FiDownload />
						</button>
						<button
							type="button"
							className={`present-btn${copied ? " on" : ""}`}
							title={t("copyPath")}
							aria-label={t("copyPath")}
							onClick={copyPath}
						>
							<FiCopy />
						</button>
					</>
				)}
			</div>

			{missing && <div className="present-item-warn">{t("presentMissing")}</div>}
			{downloadError && <div className="present-item-warn">{t("downloadFailed", { error: downloadError })}</div>}

			{media === "image" && (
				<button
					type="button"
					className="present-media"
					title={t("previewFile")}
					onClick={() => openFilePreview(target)}
				>
					<img
						crossOrigin={appResourceCrossOrigin(downloadUrl(item.target, false))}
						src={downloadUrl(item.target, false)}
						alt={item.name}
						loading="lazy"
						onError={() => setMediaFailed(true)}
					/>
				</button>
			)}
			{media === "video" && (
				<video
					className="present-media-video"
					crossOrigin={appResourceCrossOrigin(downloadUrl(item.target, false))}
					src={downloadUrl(item.target, false)}
					controls
					preload="metadata"
					onError={() => setMediaFailed(true)}
				/>
			)}
			{media === "audio" && (
				<audio
					className="present-media-audio"
					crossOrigin={appResourceCrossOrigin(downloadUrl(item.target, false))}
					src={downloadUrl(item.target, false)}
					controls
					preload="metadata"
					onError={() => setMediaFailed(true)}
				/>
			)}

			{item.excerpt && (
				<pre className="present-excerpt">
					{item.excerpt}
					{item.excerptTruncated ? "…" : ""}
				</pre>
			)}
		</div>
	);
}
