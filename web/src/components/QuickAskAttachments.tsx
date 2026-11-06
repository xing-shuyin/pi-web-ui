import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiFileText, FiFolder, FiMessageCircle, FiPaperclip, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import type { QuickAskAttachment, QuickAskReferenceSource } from "../quick-ask";
import { useFloatingPanel } from "../use-floating-panel";

export function QuickAskReferenceChips({
	attachments,
	onRemove,
}: {
	attachments: QuickAskAttachment[];
	onRemove?: (id: string) => void;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	if (!attachments.length) return null;
	return (
		<div className={`quick-ask-references${expanded ? " is-expanded" : ""}`} aria-label={t("quickAskReferences")}>
			<div className="quick-ask-reference-tags">
				{(expanded ? attachments : attachments.slice(0, 2)).map((attachment) => {
					const Icon =
						attachment.kind === "conversation"
							? FiMessageCircle
							: attachment.kind === "directory"
								? FiFolder
								: FiFileText;
					return (
						<span className="quick-ask-reference-tag" key={attachment.id} title={attachment.path || attachment.name}>
							<Icon size={10} aria-hidden="true" />
							<span>{attachment.name}</span>
							{onRemove && (
								<button
									type="button"
									aria-label={`${t("quickAskRemoveReference")}: ${attachment.name}`}
									onClick={() => onRemove(attachment.id)}
								>
									<FiX size={10} />
								</button>
							)}
						</span>
					);
				})}
			</div>
			{attachments.length > 2 && (
				<button
					type="button"
					className="quick-ask-reference-count"
					aria-expanded={expanded}
					aria-label={expanded ? t("quickAskCollapseReferences") : t("quickAskExpandReferences")}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "−" : `+${attachments.length - 2}`}
				</button>
			)}
		</div>
	);
}

export function QuickAskAttachButton({
	currentConversation,
	disabled,
	onReference,
	onFiles,
	onFolder,
}: {
	currentConversation?: QuickAskReferenceSource;
	disabled?: boolean;
	onReference: (source: QuickAskReferenceSource) => void;
	onFiles: (files: File[]) => void;
	onFolder: (files: File[]) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const files = useRef<HTMLInputElement>(null);
	const folder = useRef<HTMLInputElement>(null);
	const focused = useRef(false);
	const menu = useFloatingPanel({ open, anchor: trigger, side: "top", align: "left", onClose: () => setOpen(false) });
	useEffect(() => {
		folder.current?.setAttribute("webkitdirectory", "");
	}, []);
	useLayoutEffect(() => {
		if (!open) focused.current = false;
		if (open && menu.pos && !focused.current) {
			focused.current = true;
			menu.panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
		}
	}, [open, menu.pos, menu.panelRef]);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="quick-ask-attach"
				title={t("quickAskAttach")}
				aria-label={t("quickAskAttach")}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls="quick-ask-attachment-menu"
				disabled={disabled}
				onClick={() => setOpen(!open)}
			>
				<FiPaperclip size={14} />
			</button>
			<input
				ref={files}
				type="file"
				multiple
				hidden
				aria-label={t("quickAskAttachFiles")}
				onChange={(event) => {
					const selected = Array.from(event.target.files || []);
					event.target.value = "";
					if (selected.length) onFiles(selected);
				}}
			/>
			<input
				ref={folder}
				type="file"
				multiple
				hidden
				aria-label={t("quickAskAttachFolder")}
				onChange={(event) => {
					const selected = Array.from(event.target.files || []);
					event.target.value = "";
					if (selected.length) onFolder(selected);
				}}
			/>
			{open &&
				createPortal(
					<div
						ref={menu.panelRef}
						style={menu.style}
						id="quick-ask-attachment-menu"
						className="quick-ask-menu quick-ask-attachment-menu"
						role="dialog"
						aria-label={t("quickAskAttach")}
					>
						<button
							type="button"
							disabled={!currentConversation}
							onClick={() => {
								const source = currentConversation;
								setOpen(false);
								if (source) onReference(source);
							}}
						>
							<FiMessageCircle size={13} />
							{t("quickAskAttachCurrent")}
						</button>
						<button
							type="button"
							onClick={() => {
								setOpen(false);
								files.current?.click();
							}}
						>
							<FiFileText size={13} />
							{t("quickAskAttachFiles")}
						</button>
						<button
							type="button"
							onClick={() => {
								setOpen(false);
								folder.current?.click();
							}}
						>
							<FiFolder size={13} />
							{t("quickAskAttachFolder")}
						</button>
					</div>,
					document.body,
				)}
		</>
	);
}
