// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { DevicePanel, type DevicePanelProps } from "../../web/src/components/DevicePanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { Device } from "../../web/src/components/DeviceDirectory.js";

// 语言由 localStorage 决定；显式钉成中文，避免同批测试文件之间互相影响
beforeEach(() => localStorage.setItem("pi-web-ui:lang", "zh"));

const DEVICES: Device[] = [
	{ id: "win-4f1c9a72-be4d", name: "win", online: true },
	{ id: "mac-66b0571f-3ac9", name: "cdeMac-mini.local", remark: "工作机", online: true },
	{ id: "studio-a71d3e8b-2f45", name: "studio-mbp.lan", online: false },
];

type Handlers = {
	onOpen: ReturnType<typeof vi.fn<DevicePanelProps["onOpen"]>>;
	onRemark: ReturnType<typeof vi.fn<DevicePanelProps["onRemark"]>>;
	onRefresh: ReturnType<typeof vi.fn<DevicePanelProps["onRefresh"]>>;
};

/** React 受控输入必须用原生 setter 改值，直接赋 value 不会触发 onChange。 */
function typeInto(input: HTMLInputElement, value: string): void {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount(props: { mobile?: boolean; devices?: Device[] } = {}): Promise<{
	host: HTMLDivElement;
	handlers: Handlers;
	unmount: () => void;
}> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const handlers: Handlers = {
		onOpen: vi.fn<DevicePanelProps["onOpen"]>(),
		onRemark: vi.fn<DevicePanelProps["onRemark"]>(async () => true),
		onRefresh: vi.fn<DevicePanelProps["onRefresh"]>(),
	};
	await act(async () =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(DevicePanel, {
					devices: props.devices ?? DEVICES,
					error: "",
					currentDeviceId: DEVICES[0].id,
					targetOf: (id: string) => `https://hub.example.com/device/${id}`,
					onOpen: handlers.onOpen,
					onRemark: handlers.onRemark,
					onRefresh: handlers.onRefresh,
					mobile: props.mobile ?? false,
				}),
			),
		),
	);
	return {
		host,
		handlers,
		unmount: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}

it("紧凑行：一台设备一行，备注优先作为名称，本机带标签", async () => {
	const { host, unmount } = await mount();
	try {
		const rows = [...host.querySelectorAll(".dp-row")];
		expect(rows).toHaveLength(3);
		expect(rows[1].querySelector(".dp-name strong")?.textContent).toBe("工作机");
		expect(rows[1].querySelector(".dp-sub")?.textContent).toBe("mac-66b0");
		expect(rows[0].querySelector(".dp-tag")?.textContent).toBe("本机");
		expect(rows[2].classList.contains("is-off")).toBe(true);
		expect(rows[2].querySelector(".dp-sub")?.textContent).toContain("离线");
	} finally {
		unmount();
	}
});

it("点整行打开设备，行尾图标一步进远程桌面（都不进菜单）", async () => {
	const { host, handlers, unmount } = await mount();
	try {
		const rows = [...host.querySelectorAll(".dp-row")];
		const hit = rows[1].querySelector<HTMLAnchorElement>(".dp-hit")!;
		expect(hit.href).toBe(`https://hub.example.com/device/${DEVICES[1].id}`);
		await act(async () => hit.click());
		expect(handlers.onOpen).toHaveBeenCalledTimes(1);
		expect(handlers.onOpen.mock.calls[0][1]).toBe(DEVICES[1].id);

		const desktop = rows[1].querySelector<HTMLButtonElement>('[aria-label="远程桌面"]')!;
		await act(async () => desktop.click());
		expect(handlers.onOpen).toHaveBeenCalledTimes(2);
		expect(handlers.onOpen.mock.calls[1][2]).toBe(true);
	} finally {
		unmount();
	}
});

it("本机行不提供远程入口：没有整行链接、没有远程桌面，只剩 ⋯", async () => {
	const { host, unmount } = await mount();
	try {
		const self = host.querySelectorAll(".dp-row")[0];
		expect(self.querySelector(".dp-hit")).toBeNull();
		expect(self.querySelector('[aria-label="远程桌面"]')).toBeNull();
		expect(self.querySelector('[aria-label="更多操作"]')).not.toBeNull();
		// 占位 chevron 只为对齐「⋯」，不带图标也不算可点
		expect(self.querySelector("svg.dp-chev")).toBeNull();
		// 其它设备仍然两个动作都在
		const other = host.querySelectorAll(".dp-row")[1];
		expect(other.querySelector(".dp-hit")).not.toBeNull();
		expect(other.querySelector('[aria-label="远程桌面"]')).not.toBeNull();
		expect(other.querySelector("svg.dp-chev")).not.toBeNull();
	} finally {
		unmount();
	}
});

it("⋯ 菜单只放低频动作，备注行内编辑回车即保存", async () => {
	const { host, handlers, unmount } = await mount();
	try {
		const menuButton = host.querySelectorAll<HTMLButtonElement>('.dp-row [aria-label="更多操作"]')[0];
		await act(async () => menuButton.click());
		// 菜单 portal 到 body（否则会被滚动容器裁掉）
		const menu = document.body.querySelector(".dp-menu");
		expect(menu).not.toBeNull();
		const items = [...menu!.querySelectorAll("button")].map((item) => item.textContent?.trim());
		expect(items).toEqual(["设置备注", "复制设备 ID"]);
		expect(menu!.textContent).not.toContain("远程桌面");

		await act(async () => menu!.querySelectorAll<HTMLButtonElement>("button")[0].click());
		const input = host.querySelector<HTMLInputElement>(".dp-input");
		expect(input).not.toBeNull();
		await act(async () => typeInto(input!, "主力机"));
		await act(async () => {
			input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(handlers.onRemark).toHaveBeenCalledWith(DEVICES[0].id, "主力机");
	} finally {
		unmount();
	}
});

it("触控布局：显示设备 ID 次行，备注走抽屉底部编辑条 + 保存", async () => {
	const { host, handlers, unmount } = await mount({ mobile: true });
	try {
		expect(host.querySelector(".dp-panel")?.classList.contains("is-mobile")).toBe(true);
		expect(host.querySelectorAll(".dp-sub")[0].textContent).toContain("win-4f1c");
		const menuButton = host.querySelectorAll<HTMLButtonElement>('.dp-row [aria-label="更多操作"]')[1];
		await act(async () => menuButton.click());
		await act(async () => document.body.querySelectorAll<HTMLButtonElement>(".dp-menu button")[0].click());
		const bar = host.querySelector(".dp-editbar");
		const input = host.querySelector<HTMLInputElement>(".dp-editbar-input");
		expect(bar).not.toBeNull();
		expect(input).not.toBeNull();
		await act(async () => typeInto(input!, "设计组"));
		await act(async () => host.querySelector<HTMLFormElement>(".dp-editbar")!.requestSubmit());
		expect(handlers.onRemark).toHaveBeenCalledWith(DEVICES[1].id, "设计组");
		expect(host.querySelector(".dp-input")).toBeNull();
	} finally {
		unmount();
	}
});

it("报错与空列表都有兜底文案，刷新按钮走 onRefresh", async () => {
	const empty = await mount({ devices: [] });
	try {
		expect(empty.host.querySelector(".dp-empty")?.textContent).toContain("暂无其它设备");
		await act(async () => empty.host.querySelector<HTMLButtonElement>('[aria-label="刷新设备"]')!.click());
		expect(empty.handlers.onRefresh).toHaveBeenCalledTimes(1);
	} finally {
		empty.unmount();
	}
	const errored = document.createElement("div");
	document.body.append(errored);
	const root = createRoot(errored);
	try {
		await act(async () =>
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DevicePanel, {
						devices: DEVICES,
						error: "无法读取设备列表，请重试。",
						currentDeviceId: DEVICES[0].id,
						targetOf: (id: string) => `https://hub.example.com/device/${id}`,
						onOpen: vi.fn<DevicePanelProps["onOpen"]>(),
						onRemark: vi.fn<DevicePanelProps["onRemark"]>(async () => true),
						onRefresh: vi.fn<DevicePanelProps["onRefresh"]>(),
						mobile: false,
					}),
				),
			),
		);
		expect(errored.querySelector('[role="alert"]')?.textContent).toContain("无法读取设备列表");
	} finally {
		act(() => root.unmount());
		errored.remove();
	}
});
