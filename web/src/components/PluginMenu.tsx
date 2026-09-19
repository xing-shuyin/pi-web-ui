import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { FiMenu, FiSettings } from "react-icons/fi";
import { PiPushPinFill, PiPushPinSlash } from "react-icons/pi";
import { PluginIcon } from "../plugin-icon";
import { useI18n } from "../i18n";

/**
 * 插件面板（顶栏那个 🧩 入口，Chrome 扩展图标的位置）：列出**全部已装插件**，
 * 每行一个「钉到顶栏」开关 —— 钉住的插件视图 tab 才回到顶栏，没钉的只在面板里。
 *
 * 为什么是 portal + `position: fixed`：触发器坐在横滑的 `.topbar-flow` 里
 * （窄屏 `overflow-x:auto` 会让纵向也变成裁剪，CSS Overflow 3 §3.1），
 * 面板往下展开正好落在被裁的轴上，`z-index` 再高也逃不出来 —— 与
 * TopbarOverflowMenu / ContextMenu 同一招（portal 到 body + 实测钳制）。
 *
 * 锚点传的是**点击那一刻**的矩形快照（`anchorRect`），不是 ref：触发器常从
 * 「⋯」溢出菜单里被点（那里的 `.plugin-topbar-menu-keep` 点完即卸载），
 * ref 那一刻已经指不到东西了。快照的代价是滚动/缩放后位置不再跟随 ——
 * 所以这里滚动/缩放直接关闭，而不是像 TopbarOverflowMenu 那样重算。
 */
export interface PluginMenuRow {
	id: string;
	name: string;
	icon?: string;
	iconSvg?: string;
	error?: string;
	/** false = 纯渲染器插件（没有独立界面，钉不钉都没有 tab）。 */
	view?: boolean;
}

interface PluginMenuProps {
	/** 触发器的视口矩形（点击时快照）。 */
	anchorRect: { left: number; right: number; top: number; bottom: number };
	/** 触发器本体（可能已随「⋯」菜单卸载，只用来忽略点在自己身上的 mousedown）。 */
	anchorEl?: HTMLElement | null;
	plugins: PluginMenuRow[];
	/** 已经钉在顶栏上的插件 id。 */
	pinnedIds: ReadonlySet<string>;
	/** 插件视图的当前顺序（同时决定已钉 tab 在顶栏里的相对顺序）。 */
	orderedPluginIds?: readonly string[];
	onTogglePin: (pluginId: string, pinned: boolean) => void;
	onReorder: (pluginIds: string[]) => void;
	onOpenView: (pluginId: string) => void;
	onManagePlugins: () => void;
	onClose: () => void;
}

export function PluginMenu({
	anchorRect,
	anchorEl,
	plugins,
	pinnedIds,
	orderedPluginIds,
	onTogglePin,
	onReorder,
	onOpenView,
	onManagePlugins,
	onClose,
}: PluginMenuProps) {
	const { t } = useI18n();
	const menuRef = useRef<HTMLDivElement>(null);
	// 实测钳制后的最终坐标；null = 还没量过（那一帧先藏起来，不闪一下）。
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const draggingIdRef = useRef<string | null>(null);
	const [dropId, setDropId] = useState<string | null>(null);
	const orderedPlugins = useMemo(() => {
		const rank = new Map((orderedPluginIds ?? []).map((id, index) => [id, index]));
		return plugins
			.map((plugin, index) => ({ plugin, index }))
			.sort((a, b) => (rank.get(a.plugin.id) ?? 1_000_000 + a.index) - (rank.get(b.plugin.id) ?? 1_000_000 + b.index))
			.map(({ plugin }) => plugin);
	}, [plugins, orderedPluginIds]);
	const movePlugin = (id: string, delta: number) => {
		const ids = orderedPlugins.filter((p) => p.view !== false && !p.error).map((p) => p.id);
		const from = ids.indexOf(id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= ids.length) return;
		const [moved] = ids.splice(from, 1);
		if (!moved) return;
		ids.splice(to, 0, moved);
		onReorder(ids);
	};
	const dropPlugin = (sourceId: string | null, targetId: string) => {
		if (!sourceId || sourceId === targetId) return;
		const ids = orderedPlugins.filter((p) => p.view !== false && !p.error).map((p) => p.id);
		const from = ids.indexOf(sourceId);
		const to = ids.indexOf(targetId);
		if (from < 0 || to < 0) return;
		const [moved] = ids.splice(from, 1);
		if (!moved) return;
		ids.splice(to, 0, moved);
		onReorder(ids);
	};
	// onClose 是内联箭头（每 render 换身份）：进 deps 会让监听每次渲染都解绑/重绑，
	// 离散按键事件落在缝里就丢了。与 TopbarOverflowMenu 同形，走 ref。
	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	});

	const measure = () => {
		const el = menuRef.current?.getBoundingClientRect();
		if (!el) return;
		const MARGIN = 8;
		const GAP = 6;
		const w = el.width;
		const h = el.height;
		// 右对齐到触发器右缘，钳在视口内。
		const x = Math.max(MARGIN, Math.min(anchorRect.right - w, window.innerWidth - w - MARGIN));
		// 默认挂触发器下方；下方放不下就翻到上方；两边都放不下就贴顶并靠 max-height 内滚。
		let y = anchorRect.bottom + GAP;
		if (y + h > window.innerHeight - MARGIN) y = anchorRect.top - h - GAP;
		if (y < MARGIN) y = MARGIN;
		setPos((prev) => (prev?.x === x && prev?.y === y ? prev : { x, y }));
	};

	// 挂载后、内容变化后：绘制前实测一次（layout effect，用户看不到中间态）。
	useLayoutEffect(() => {
		measure();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [anchorRect, orderedPlugins]);

	useEffect(() => {
		const inside = (target: EventTarget | null) =>
			target instanceof Node && (!!menuRef.current?.contains(target) || (!!anchorEl && anchorEl.contains(target)));
		const onDown = (e: MouseEvent) => {
			// 点触发器自己不算「外面」：它的 onClick 负责开关（否则 mousedown 先关、
			// click 又开，看上去关不掉）。
			if (!inside(e.target)) onCloseRef.current();
		};
		// 捕获期：Esc 先到我们，且不怕冒泡链上有人 stopPropagation（与 ContextMenu 同款）。
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCloseRef.current();
		};
		// 锚点是快照，滚走了就跟不上 —— 直接关，不留下一个飘在原地的面板。
		const onMove = () => onCloseRef.current();
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("resize", onMove, true);
		window.addEventListener("scroll", onMove, true);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("resize", onMove, true);
			window.removeEventListener("scroll", onMove, true);
		};
	}, [anchorEl]);

	return createPortal(
		<div
			ref={menuRef}
			className="pm-panel"
			role="menu"
			aria-label={t("pluginMenuTitle")}
			style={{
				left: pos?.x ?? -9999,
				top: pos?.y ?? -9999,
				visibility: pos ? "visible" : "hidden",
			}}
		>
			{/* 标题与 aria-label 重复，纯装饰 —— 对读屏器藏掉，免得它插在 menuitem 中间。 */}
			<div className="pm-head" aria-hidden="true">
				<span className="pm-head-icon">🧩</span>
				{t("pluginMenuTitle")}
			</div>
			<div className="pm-list">
				{plugins.length === 0 ? (
					<div className="pm-empty">{t("pluginMenuEmpty")}</div>
				) : (
					orderedPlugins.map((p) => {
						// 报错插件：合并引擎整份丢弃了它的贡献（含合成视图条目），钉住也是空操作；
						// 纯渲染器插件（view:false）压根没有视图。两类都只列出来、不给开关。
						const noView = p.view === false || !!p.error;
						const pinned = !noView && pinnedIds.has(p.id);
						const hint = p.error ?? (p.view === false ? t("pluginMenuNoView") : undefined);
						// 与顶栏/布局页同一套图标口径：词表名当文字画（这里没有词表，直接兜 🧩），
						// emoji/单字符原样画，插件自带 SVG 优先。
						const glyph = p.iconSvg ? undefined : p.icon && !/[a-z]/i.test(p.icon) ? p.icon : "🧩";
						return (
							<div
								key={p.id}
								className={`pm-row${dropId === p.id ? " drop-target" : ""}`}
								role="none"
								onDragOver={(e) => {
									if (noView || !draggingIdRef.current) return;
									e.preventDefault();
									setDropId(p.id);
								}}
								onDrop={(e) => {
									e.preventDefault();
									dropPlugin(e.dataTransfer.getData("text/plain") || draggingIdRef.current, p.id);
									draggingIdRef.current = null;
									setDraggingId(null);
									setDropId(null);
								}}
							>
								{!noView && (
									<button
										type="button"
										className="pm-drag"
										draggable
										aria-label={t("pluginMenuReorder")}
										title={t("pluginMenuReorderHint")}
										onDragStart={(e: DragEvent<HTMLButtonElement>) => {
											setDraggingId(p.id);
											draggingIdRef.current = p.id;
											e.dataTransfer.effectAllowed = "move";
											e.dataTransfer.setData("text/plain", p.id);
											// 使用挂到 DOM 上的透明拖拽图像：浏览器不会把把手单独拖成一张浮图。
											const ghost = document.createElement("div");
											ghost.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0";
											document.body.appendChild(ghost);
											e.dataTransfer.setDragImage(ghost, 0, 0);
											requestAnimationFrame(() => ghost.remove());
										}}
										onDragEnd={() => {
											draggingIdRef.current = null;
											setDraggingId(null);
											setDropId(null);
										}}
										onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
											if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
											e.preventDefault();
											movePlugin(p.id, e.key === "ArrowUp" ? -1 : 1);
										}}
									>
										<FiMenu aria-hidden />
									</button>
								)}
								<button
									type="button"
									role="menuitem"
									className="pm-row-main"
									disabled={noView}
									title={hint}
									onClick={() => onOpenView(p.id)}
								>
									<PluginIcon icon={glyph} iconSvg={p.iconSvg} className="pm-icon" />
									<span className="pm-name">{p.name}</span>
									{hint && <span className="pm-sub">{hint}</span>}
								</button>
								{!noView && (
									<button
										type="button"
										role="menuitemcheckbox"
										aria-checked={pinned}
										aria-label={pinned ? t("pluginMenuUnpin") : t("pluginMenuPin")}
										className={`pm-pin${pinned ? " on" : ""}`}
										onClick={() => onTogglePin(p.id, !pinned)}
									>
										{pinned ? <PiPushPinFill aria-hidden /> : <PiPushPinSlash aria-hidden />}
									</button>
								)}
							</div>
						);
					})
				)}
			</div>
			<button
				type="button"
				role="menuitem"
				className="pm-manage"
				onClick={() => {
					onClose();
					onManagePlugins();
				}}
			>
				<FiSettings aria-hidden />
				<span>{t("pluginMenuManage")}</span>
			</button>
		</div>,
		document.body,
	);
}
