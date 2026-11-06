import { createPortal } from "react-dom";
import { FiInfo, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { closeToolInfo, useToolInfoState, type ToolInfoView } from "../tool-info-state";
import { schemaRows, type SchemaRow } from "../tool-schema";
import { CopyButton } from "./copy-button";

export function ToolInfoDialog() {
	const t = useT();
	const info = useToolInfoState();

	useEscapeKey(() => {
		closeToolInfo();
	}, Boolean(info));

	if (!info) return null;

	return createPortal(
		<div className="modal-backdrop" onClick={closeToolInfo}>
			<div
				className="tool-info-modal"
				role="dialog"
				aria-modal="true"
				aria-label={t("toolInfoTitle")}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="tool-info-head">
					<span className="tool-info-title">
						<FiInfo />
						{t("toolInfoTitle")}
					</span>
					<code className="tool-info-name">{info.name}</code>
					{info.label && info.label !== info.name && <span className="tool-info-label">{info.label}</span>}
					<button type="button" className="btn" title={t("close")} onClick={closeToolInfo}>
						<FiX />
					</button>
				</div>
				<div className="tool-info-body">
					<StatusBody info={info} />
				</div>
			</div>
		</div>,
		document.body,
	);
}

function StatusBody({ info }: { info: ToolInfoView }) {
	const t = useT();
	if (info.status === "loading") {
		return (
			<div className="tool-info-state" role="status">
				<span className="cursor" /> {t("toolInfoLoading")}
			</div>
		);
	}
	if (info.status === "unsupported") {
		return <div className="tool-info-state">{t("toolInfoUnsupported")}</div>;
	}
	if (info.status === "missing") {
		return <div className="tool-info-state">{t("toolInfoMissing")}</div>;
	}

	const rows = info.parameters === undefined ? [] : schemaRows(info.parameters);
	const rawSchema = info.parameters === undefined ? "" : safeJson(info.parameters);

	return (
		<>
			<div className="tool-info-badges">
				{info.active !== undefined && (
					<span className={`tool-info-badge ${info.active ? "on" : "off"}`}>
						{info.active ? t("toolInfoActive") : t("toolInfoInactive")}
					</span>
				)}
				{info.source && (
					<span className="tool-info-badge">
						{t("toolInfoSource")}: {info.source}
						{info.scope ? ` · ${info.scope}` : ""}
					</span>
				)}
			</div>

			<section className="tool-info-sec">
				<div className="tool-info-sec-label">{t("toolInfoDescription")}</div>
				<div className="tool-info-text">{info.description || t("toolInfoNoDescription")}</div>
			</section>

			{info.promptSnippet && (
				<section className="tool-info-sec">
					<div className="tool-info-sec-label">{t("toolInfoPromptSnippet")}</div>
					<div className="tool-info-text dim">{info.promptSnippet}</div>
				</section>
			)}

			{info.promptGuidelines && info.promptGuidelines.length > 0 && (
				<section className="tool-info-sec">
					<div className="tool-info-sec-label">{t("toolInfoGuidelines")}</div>
					<ul className="tool-info-list">
						{info.promptGuidelines.map((g, i) => (
							<li key={i}>{g}</li>
						))}
					</ul>
				</section>
			)}

			<section className="tool-info-sec">
				<div className="tool-info-sec-label">{t("toolInfoParams")}</div>
				{rows.length > 0 ? (
					<SchemaTable rows={rows} />
				) : (
					<div className="tool-info-text dim">{t("toolInfoParamsNone")}</div>
				)}
				{info.parametersDropped && <div className="tool-info-text warn">{t("toolInfoSchemaDropped")}</div>}
				{rawSchema && (
					<details className="tool-info-raw">
						<summary>
							{t("toolInfoRawSchema")}
							<CopyButton text={rawSchema} />
						</summary>
						<pre>{rawSchema}</pre>
					</details>
				)}
			</section>

			<div className="tool-info-foot">{t("toolInfoFootnote")}</div>
		</>
	);
}

function SchemaTable({ rows }: { rows: SchemaRow[] }) {
	const t = useT();
	return (
		<div className="tool-schema-table" role="table">
			{rows.map((row) => (
				<div className="tool-schema-row" role="row" key={row.name} style={{ paddingLeft: 8 + row.depth * 14 }}>
					<div className="tool-schema-name">
						<code>{row.name}</code>
						{row.required && <span className="tool-schema-req">{t("toolInfoRequired")}</span>}
					</div>
					<div className="tool-schema-type">
						{row.type}
						{row.hint && <span className="tool-schema-hint">{row.hint}</span>}
					</div>
					{row.description && <div className="tool-schema-desc">{row.description}</div>}
				</div>
			))}
		</div>
	);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "";
	}
}
