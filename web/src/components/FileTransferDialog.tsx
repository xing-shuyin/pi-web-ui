import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { useAppField } from "../app-globals";
import {
	archiveAction,
	uploadFolder,
	pickFolder,
	type ArchiveAction,
	type FolderEntry,
	type FolderUploadProgress,
} from "../file-transfer";

export interface FileTransferRequest {
	action: ArchiveAction | "upload";
	path: string;
	dir: string;
}

export function FileTransferDialog({
	request,
	onClose,
	onComplete,
}: {
	request: FileTransferRequest;
	onClose: () => void;
	onComplete: () => void;
}) {
	const t = useT();
	const folderUploadMaxMb = useAppField("folderUploadMaxMb");
	const [destination, setDestination] = useState(request.dir);
	const [policy, setPolicy] = useState("skip");
	const [files, setFiles] = useState<FolderEntry[]>([]);
	const [uploadProgress, setUploadProgress] = useState<FolderUploadProgress | null>(null);
	const folderInput = useRef<HTMLInputElement | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const title = t(
		request.action === "upload"
			? "fileUploadFolder"
			: request.action === "extract"
				? "fileExtract"
				: request.action === "download"
					? "fileCompressDownload"
					: "fileCompress",
	);
	async function chooseFolder() {
		try {
			const entries = await pickFolder();
			if (entries) {
				setFiles(entries);
				setUploadProgress(null);
			} else folderInput.current?.click();
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) setError(String(err));
		}
	}
	async function run() {
		setUploadProgress(null);
		setBusy(true);
		setError("");
		try {
			if (request.action === "upload") await uploadFolder(request.dir, files, setUploadProgress, folderUploadMaxMb);
			else await archiveAction(request.action, request.path, { destination, policy });
			onComplete();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			onComplete();
		} finally {
			setBusy(false);
		}
	}
	return createPortal(
		<dialog
			ref={dialog}
			className="file-transfer-dialog"
			aria-labelledby="file-transfer-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void run();
				}}
			>
				<div className="file-transfer-head">
					<h3 id="file-transfer-title">{title}</h3>
					<button
						type="button"
						className="file-transfer-close"
						title={t("close")}
						aria-label={t("close")}
						disabled={busy}
						onClick={onClose}
					>
						<FiX />
					</button>
				</div>
				<p className="file-transfer-path">{(request.action === "upload" ? request.dir : request.path) || "."}</p>
				<p>{t("fileArchiveLimits")}</p>
				{request.action === "extract" && (
					<>
						<label>
							{t("fileExtractDestination")}
							<input value={destination} disabled={busy} onChange={(e) => setDestination(e.target.value)} />
						</label>
						<label>
							{t("fileConflictPolicy")}
							<select value={policy} disabled={busy} onChange={(e) => setPolicy(e.target.value)}>
								<option value="skip">{t("fileConflictSkip")}</option>
								<option value="overwrite">{t("fileConflictOverwrite")}</option>
								<option value="error">{t("fileConflictError")}</option>
							</select>
						</label>
					</>
				)}
				{request.action === "upload" && (
					<>
						<p>{t("fileFolderUploadHint")}</p>
						<button type="button" className="btn" disabled={busy} onClick={() => void chooseFolder()}>
							{t("fileChooseFolder")}
						</button>
						<input
							type="file"
							aria-label={title}
							multiple
							hidden
							disabled={busy}
							ref={(input) => {
								folderInput.current = input;
								input?.setAttribute("webkitdirectory", "");
							}}
							onChange={(e) => {
								setFiles(
									Array.from(e.target.files ?? [], (file) => ({ path: file.webkitRelativePath || file.name, file })),
								);
								setUploadProgress(null);
							}}
						/>
						<p aria-live="polite">
							{uploadProgress?.done ?? 0} / {files.length}
						</p>
						{uploadProgress && (
							<>
								{uploadProgress.totalBytes > 0 && (
									<>
										<progress aria-label={title} value={uploadProgress.uploadedBytes} max={uploadProgress.totalBytes} />
										<p>
											{uploadProgress.uploadedBytes.toLocaleString()} / {uploadProgress.totalBytes.toLocaleString()} B
										</p>
									</>
								)}
								{busy && uploadProgress.phase !== "confirmed" && (
									<p className="file-transfer-path" role="status">
										{uploadProgress.phase === "waiting"
											? t("folderUploadWaiting", { name: uploadProgress.path })
											: t("folderUploadSending", {
													name: uploadProgress.path,
													percent: Math.floor((uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100),
												})}
									</p>
								)}
							</>
						)}
					</>
				)}
				{error && <p role="alert">{t("fileTransferFailed", { error })}</p>}
				<div className="file-transfer-actions">
					<button type="button" className="btn" disabled={busy} onClick={onClose}>
						{t("cancel")}
					</button>
					<button
						type="submit"
						className="btn primary"
						disabled={busy || (request.action === "upload" && files.length === 0)}
					>
						{busy ? t("fileTransferBusy") : title}
					</button>
				</div>
			</form>
		</dialog>,
		document.body,
	);
}
