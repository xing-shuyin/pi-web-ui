import { useState, useRef, useEffect } from "react";
import type { ProjectSummary } from "../types";
import { useT } from "../i18n";
import { FiFolder, FiFolderPlus, FiChevronDown, FiClock } from "react-icons/fi";
import { ProjectPicker } from "./ProjectPicker";
import { TipButton } from "./HintTip";

export interface UniversalPathPickerProps {
	cwd: string;
	onSelectCwd: (cwd: string) => void;
	onOpenProjectPicker?: () => void;
	projects?: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	mode?: "folder" | "project";
	baseCwd?: string;
	onCreateProject?: (path: string) => void;
	className?: string;
	placeholder?: string;
	inputId?: string;
	disabled?: boolean;
	commitOnBlur?: boolean;
	localOnly?: boolean;
	onPickerOpenChange?: (open: boolean) => void;
}

export function UniversalPathPicker({
	cwd,
	onSelectCwd,
	onOpenProjectPicker,
	projects = [],
	workspaceRoots = [],
	pathCompletions = [],
	mode = "project",
	baseCwd,
	onCreateProject,
	className = "",
	placeholder = "如 . 或 web 或绝对路径",
	inputId,
	disabled = false,
	commitOnBlur = false,
	localOnly = false,
	onPickerOpenChange,
}: UniversalPathPickerProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [typedCwd, setTypedCwd] = useState(cwd);
	useEffect(() => setTypedCwd(cwd), [cwd]);
	const [pickerOpen, setPickerOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const t = useT();

	useEffect(() => {
		const handleOutside = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		if (menuOpen) {
			window.addEventListener("mousedown", handleOutside);
			return () => window.removeEventListener("mousedown", handleOutside);
		}
	}, [menuOpen]);

	const commonDirs = [
		{ label: ". (当前项目根目录)", value: "." },
		{ label: "web (前端目录)", value: "web" },
		{ label: "server (后端服务)", value: "server" },
		{ label: "tests (测试套件)", value: "tests" },
		{ label: "src (源码目录)", value: "src" },
		{ label: "docs (文档目录)", value: "docs" },
	];

	const closePicker = () => {
		setPickerOpen(false);
		onPickerOpenChange?.(false);
	};
	const openPicker = () => {
		if (disabled) return;
		if (onOpenProjectPicker) {
			onOpenProjectPicker();
		} else {
			setMenuOpen(false);
			setPickerOpen(true);
			onPickerOpenChange?.(true);
		}
	};

	const pickerCwd = cwd && cwd !== "." ? cwd : baseCwd || cwd || ".";

	return (
		<div className={`universal-path-picker-root ${className}`} ref={wrapRef}>
			<div className="universal-path-input-group">
				<FiFolder className="universal-path-icon" />
				<input
					type="text"
					className="universal-path-input"
					value={commitOnBlur ? typedCwd : cwd}
					id={inputId}
					disabled={disabled}
					onChange={(e) => (commitOnBlur ? setTypedCwd(e.target.value) : onSelectCwd(e.target.value))}
					onBlur={() => {
						if (commitOnBlur && typedCwd !== cwd) onSelectCwd(typedCwd);
					}}
					onKeyDown={(event) => {
						if (commitOnBlur && event.key === "Enter") {
							event.preventDefault();
							if (typedCwd !== cwd) onSelectCwd(typedCwd);
						}
					}}
					placeholder={placeholder}
					title={`工作目录: ${cwd || "."}`}
				/>
				<button
					type="button"
					className="universal-path-dropdown-toggle"
					disabled={disabled}
					onClick={() => setMenuOpen(!menuOpen)}
					title="选择推荐子目录或最近项目"
				>
					<FiChevronDown />
				</button>
			</div>

			<TipButton
				className="universal-path-browse-btn"
				tip={t("projectPickerTitle")}
				disabled={disabled}
				onClick={openPicker}
			>
				<FiFolderPlus />
			</TipButton>

			{menuOpen && (
				<div
					className="universal-path-menu"
					onPointerDown={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onWheel={(e) => e.stopPropagation()}
				>
					{workspaceRoots.length > 0 && (
						<>
							<div className="universal-path-menu-header">工作区根目录</div>
							{workspaceRoots.map((root) => (
								<button
									key={root}
									type="button"
									className="universal-path-menu-item"
									onClick={() => {
										onSelectCwd(root);
										setMenuOpen(false);
									}}
								>
									<span className="path-label">{root}</span>
								</button>
							))}
						</>
					)}

					<div className="universal-path-menu-header">推荐子目录</div>
					{commonDirs.map((d) => (
						<button
							key={d.value}
							type="button"
							className="universal-path-menu-item"
							onClick={() => {
								onSelectCwd(d.value);
								setMenuOpen(false);
							}}
						>
							<span className="path-label">{d.label}</span>
						</button>
					))}

					{projects.length > 0 && (
						<>
							<div className="universal-path-menu-header">
								<FiClock /> 最近项目
							</div>
							{projects.slice(0, 6).map((p) => {
								const folderName = p.path.split(/[/\\]/).filter(Boolean).pop() || p.path;
								return (
									<button
										key={p.path}
										type="button"
										className="universal-path-menu-item"
										onClick={() => {
											onSelectCwd(p.path);
											setMenuOpen(false);
										}}
										title={p.path}
									>
										<span className="path-title">{folderName}</span>
										<span className="path-sub">{p.path}</span>
									</button>
								);
							})}
						</>
					)}
				</div>
			)}

			{!onOpenProjectPicker && pickerOpen && (
				<ProjectPicker
					portalContainer={wrapRef.current?.closest("dialog") ?? undefined}
					localOnly={localOnly}
					open
					currentCwd={pickerCwd}
					pathCompletions={pathCompletions}
					workspaceRoots={workspaceRoots}
					onClose={closePicker}
					onSelectDirectory={(p) => {
						onSelectCwd(p);
						closePicker();
					}}
					onCreateProject={
						onCreateProject
							? (p) => {
									onCreateProject(p);
									closePicker();
								}
							: undefined
					}
					mode={mode}
				/>
			)}
		</div>
	);
}
