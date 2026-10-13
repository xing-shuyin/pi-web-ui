/**
 * 宿主内置条目的**图标预览**：按 `UiSlotEntry.icon` 的名字画出图标。
 *
 * 为什么需要这一层：内置条目的渲染节点在各组件里是**按 id 手写**的（TopBar 的 hostNodes、
 * SideDock 的 renderItemIcon），`icon` 字段此前只是元数据，没有消费方。但「图标编辑」要在
 * **一处同时画出所有栏**的条目 —— 把那些有状态组件（下拉、select、面板开关）搬进编辑面板
 * 既不可能也不该做。于是这里按名字给一份统一的**只读预览**图标。
 *
 * 名字表就是 `BUILTIN_UI_ITEMS` 用到的全部取值；新增内置条目写了没登记的名字不会静默空白，
 * `tests/unit/host-icon.test.ts` 直接失败。
 */
import type { ReactNode } from "react";
import {
	FiActivity,
	FiAnchor,
	FiAperture,
	FiCheck,
	FiChevronUp,
	FiClipboard,
	FiClock,
	FiCode,
	FiCopy,
	FiCornerDownLeft,
	FiCornerUpLeft,
	FiCpu,
	FiCrosshair,
	FiDatabase,
	FiDollarSign,
	FiDownload,
	FiEdit2,
	FiExternalLink,
	FiEye,
	FiFeather,
	FiFile,
	FiFileText,
	FiFolder,
	FiGithub,
	FiGitBranch,
	FiGlobe,
	FiGrid,
	FiImage,
	FiInfo,
	FiLayers,
	FiLink,
	FiList,
	FiLock,
	FiMaximize2,
	FiMenu,
	FiMinimize2,
	FiMessageSquare,
	FiPlus,
	FiRefreshCw,
	FiSave,
	FiScissors,
	FiSearch,
	FiSend,
	FiSettings,
	FiSun,
	FiTerminal,
	FiTrash2,
	FiType,
	FiUpload,
	FiVolume2,
	FiX,
	FiZap,
	FiZoomIn,
} from "react-icons/fi";
import { LuFlaskConical } from "react-icons/lu";
import { PluginIcon } from "./plugin-icon";

/** icon 名 → 预览节点。键就是 BUILTIN_UI_ITEMS 里出现过的全部 `icon` 值。 */
const HOST_ICON_NODES: Record<string, ReactNode> = {
	activity: <FiActivity />,
	aperture: <FiAperture />,
	branch: <FiGitBranch />,
	browser: <FiGlobe />,
	chat: <FiMessageSquare />,
	check: <FiCheck />,
	"chevron-up": <FiChevronUp />,
	clock: <FiClock />,
	code: <FiCode />,
	coins: <FiDollarSign />,
	copy: <FiCopy />,
	cpu: <FiCpu />,
	cut: <FiScissors />,
	database: <FiDatabase />,
	dot: <span className="host-icon-char">●</span>,
	download: <FiDownload />,
	edit: <FiEdit2 />,
	engine: <FiAperture />,
	eye: <FiEye />,
	feather: <FiFeather />,
	file: <FiFile />,
	folder: <FiFolder />,
	gauge: <FiActivity />,
	git: <FiGitBranch />,
	github: <FiGithub />,
	globe: <FiGlobe />,
	grid: <FiGrid />,
	hash: <span className="host-icon-char">#</span>,
	image: <FiImage />,
	info: <FiInfo />,
	layers: <FiLayers />,
	link: <FiLink />,
	list: <FiList />,
	lock: <FiLock />,
	markdown: <FiFileText />,
	maximize: <FiMaximize2 />,
	menu: <FiMenu />,
	minimize: <FiMinimize2 />,
	message: <FiMessageSquare />,
	open: <FiExternalLink />,
	paste: <FiClipboard />,
	pin: <FiAnchor />,
	plus: <FiPlus />,
	refresh: <FiRefreshCw />,
	sandbox: <LuFlaskConical />,
	save: <FiSave />,
	search: <FiSearch />,
	send: <FiSend />,
	settings: <FiSettings />,
	sound: <FiVolume2 />,
	sun: <FiSun />,
	target: <FiCrosshair />,
	terminal: <FiTerminal />,
	text: <FiType />,
	trash: <FiTrash2 />,
	undo: <FiCornerUpLeft />,
	upload: <FiUpload />,
	volume: <FiVolume2 />,
	wrap: <FiCornerDownLeft />,
	x: <FiX />,
	zap: <FiZap />,
	zoom: <FiZoomIn />,
};

/** 已登记的名字（单测守卫用）。 */
export const HOST_ICON_NAMES: readonly string[] = Object.keys(HOST_ICON_NODES);

/**
 * 条目的预览图标。
 * 优先级与渲染层一致：内联 SVG > 已登记的名字 > 非拉丁字形（emoji，插件常用）> 无。
 * 宿主条目写了个没登记的名字时返回 null（只剩文字）—— 单测会先一步把它拦下来。
 */
export function hostEntryIcon(entry: { icon?: string; iconSvg?: string }): ReactNode {
	if (entry.iconSvg) {
		return <PluginIcon icon={entry.icon} iconSvg={entry.iconSvg} />;
	}
	if (!entry.icon) return null;
	const known = HOST_ICON_NODES[entry.icon];
	if (known !== undefined) return known;
	// 拉丁词表名（"mic"）当图标画出来是乱码，不如不画。
	if (!/[a-z]/i.test(entry.icon)) {
		return <span className="plugin-icon-glyph">{entry.icon}</span>;
	}
	return null;
}
