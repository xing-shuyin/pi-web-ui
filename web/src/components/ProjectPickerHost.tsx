import { ProjectPicker } from "./ProjectPicker";
import { appSend, useAppField } from "../app-globals";

interface ProjectPickerHostProps {
	open: boolean;
	/** 可选覆写：不传时由 `DirectoryBrowser` 内部从 `app-globals` 读取 `pathCompletions`。 */
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	onClose: () => void;
}

/**
 * 项目选择器宿主：单实例 + 单份落盘命令。
 *
 * 顶栏 chip、左右停靠栏条目（`host:open-project` / `host:cwd`）都只是「把 `open` 置 true」，
 * 对话框本身与 `set_cwd` / `make_dir` 的载荷只写在这里 —— 以前对话框长在 `TopBar` 里，
 * 停靠栏那条入口因为没有回调而点不动，挪出来才谈得上共用。
 */
export function ProjectPickerHost({ open, pathCompletions, onClose }: ProjectPickerHostProps) {
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");
	if (!open) return null;
	return (
		<ProjectPicker
			open
			currentCwd={cwd}
			pathCompletions={pathCompletions}
			workspaceRoots={workspaceRoots}
			onClose={onClose}
			onSelectDirectory={(path, name) => appSend({ type: "set_cwd", path, ...(name ? { name } : {}) })}
			onCreateProject={(path, name) => appSend({ type: "make_dir", path, setAsCwd: true, ...(name ? { name } : {}) })}
		/>
	);
}
