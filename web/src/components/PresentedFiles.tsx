import { memo, useEffect, useMemo, useState } from "react";
import { FiCopy, FiDownload, FiExternalLink, FiEye, FiFolder } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { appResourceCrossOrigin } from "../base-url";
import { DOWNLOAD_FILE_NOT_FOUND, downloadFile, downloadUrl } from "../download";
import { isFilePreviewOpen, openFilePreviewList } from "../file-preview-bridge";
import { isLoopbackAccess, resolveWorkspaceFileUrl } from "../workspace-file-url";
import {
	formatPresentSize,
	inlineMediaKind,
	presentCardItems,
	presentKindIcon,
	presentNote,
	presentTitle,
	previewablePresentKind,
	primaryPreviewItem,
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
	const focus = useMemo(() => primaryPreviewItem(items), [items]);
	const previewList = useMemo(
		() => items.filter((i) => previewablePresentKind(i.kind)).map((i) => ({ path: i.target, name: i.name })),
		[items],
	);
	const focusIndex = useMemo(() => {
		if (!focus) return 0;
		const idx = previewList.findIndex((f) => f.path === focus.target);
		return idx >= 0 ? idx : 0;
	}, [previewList, focus]);

	useEffect(() => {
		if (!autoOpen || !focus || previewList.length === 0 || !toolCallId) return;
		if (isFilePreviewOpen()) return;
		if (!takeAutoOpen(toolCallId, resultTimestamp)) return;
		openFilePreviewList(previewList, focusIndex);
	}, [autoOpen, focus, previewList, focusIndex, toolCallId, resultTimestamp]);

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
				{items.map((item, index) => (
					<PresentRow
						key={`${item.target}\u0000${item.path}`}
						item={item}
						previewList={previewList}
						previewIndex={(() => {
							const idx = previewList.findIndex((f) => f.path === item.target);
							return idx >= 0 ? idx : index;
						})()}
					/>
				))}
			</div>
		</div>
	);
});

function itemTitle(item: PresentCardItem): string {
	if (typeof item.mtime !== "number") return item.path;
	return `${item.path}\n${new Date(item.mtime).toLocaleString()}`;
}

function PresentRow({
	item,
	previewList,
	previewIndex,
}: {
	item: PresentCardItem;
	previewList: Array<{ path: string; name: string }>;
	previewIndex: number;
}) {
	const t = useT();
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const [mediaFailed, setMediaFailed] = useState(false);
	const [downloadError, setDownloadError] = useState("");

	const media = mediaFailed ? null : inlineMediaKind(item.kind);
	const size = formatPresentSize(item.size);
	const missing = item.kind === "missing";
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
								onClick={() => openFilePreviewList(previewList, previewIndex)}
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
					onClick={() => openFilePreviewList(previewList, previewIndex)}
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
