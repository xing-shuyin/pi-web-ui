/** 无障碍服务里的一次界面读取：扁平控件列表，坐标是屏幕像素（与截图同坐标系）。 */
export interface PhoneUiNode {
	index: number;
	depth: number;
	text?: string;
	desc?: string;
	/** 短类名，如 Button / EditText / TextView。 */
	cls?: string;
	/** 资源 id 的末段，如 com.android.settings:id/search → search。 */
	viewId?: string;
	clickable: boolean;
	editable: boolean;
	scrollable: boolean;
	enabled: boolean;
	selected: boolean;
	checked: boolean;
	focused: boolean;
	bounds: [number, number, number, number];
}

export interface PhoneUiDump {
	packageName: string;
	screen: { width: number; height: number };
	nodes: PhoneUiNode[];
}

export interface PhoneControlStatus {
	/** 无障碍服务是否已在系统设置里启用。 */
	enabled: boolean;
	/** 截图需要 Android 11+（AccessibilityService.takeScreenshot）。 */
	canScreenshot: boolean;
}

export interface PhoneScreenshot {
	/** PNG 的 base64（不含 data: 前缀）。 */
	data: string;
	width: number;
	height: number;
}

export type PhoneKey = "back" | "home" | "recents" | "notifications" | "quickSettings";

export interface PiPhoneControlPlugin {
	getStatus(): Promise<PhoneControlStatus>;
	/** 打开系统「无障碍」设置页：这个权限只能用户手动勾选。 */
	openAccessibilitySettings(): Promise<void>;
	dump(options?: { maxDepth?: number; maxNodes?: number }): Promise<PhoneUiDump>;
	tap(options: { x: number; y: number }): Promise<void>;
	longPress(options: { x: number; y: number; durationMs?: number }): Promise<void>;
	swipe(options: { x1: number; y1: number; x2: number; y2: number; durationMs?: number }): Promise<void>;
	/** 往当前焦点输入框写文本（ACTION_SET_TEXT），不会逐字符模拟按键。 */
	setText(options: { text: string }): Promise<void>;
	key(options: { name: PhoneKey }): Promise<void>;
	launchApp(options: { packageName: string }): Promise<void>;
	screenshot(options?: { maxWidth?: number }): Promise<PhoneScreenshot>;
}
