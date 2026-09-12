/**
 * 手写的 chrome API 最小声明（只声明我们真正用到的那几个）。
 *
 * 为什么不用 `@types/chrome`：多一个 devDependency 就为了让三个文件过类型检查不划算，
 * 而且手写这份**顺带记录了我们到底依赖哪些权限**（改权限时先看这里）。
 */
declare namespace chrome {
	namespace runtime {
		interface MessageSender {
			tab?: { id?: number; url?: string };
		}
		function sendMessage(message: unknown): Promise<unknown>;
		function getURL(path: string): string;
		const onMessage: {
			addListener(
				cb: (
					message: unknown,
					sender: MessageSender,
					respond: (response?: unknown) => void,
				) => boolean | undefined | void,
			): void;
		};
	}

	namespace action {
		const onClicked: { addListener(cb: (tab: { id?: number; url?: string }) => void): void };
		function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
		function setTitle(details: { title: string; tabId?: number }): Promise<void>;
	}

	namespace commands {
		const onCommand: { addListener(cb: (command: string, tab?: { id?: number }) => void): void };
	}

	namespace scripting {
		interface InjectionResult<T> {
			result?: T;
			frameId: number;
		}
		function executeScript<T>(injection: {
			target: { tabId: number; allFrames?: boolean };
			files?: string[];
			/** 注入函数可以同步也可以异步（探测页面的那个会发一次请求）。 */
			func?: (...args: never[]) => T | Promise<T>;
			args?: unknown[];
			world?: "ISOLATED" | "MAIN";
		}): Promise<InjectionResult<T>[]>;
	}

	namespace tabs {
		interface Tab {
			id?: number;
			windowId?: number;
			url?: string;
			active?: boolean;
		}
		function query(info: { url?: string | string[]; active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
		function update(tabId: number, props: { active?: boolean }): Promise<Tab>;
		/** 新开标签页（绑定需要授权时，把用户带到带 `?bind=` 的选项页）。 */
		function create(props: { url: string }): Promise<Tab>;
		/** 截当前可见区域（物理像素，需 activeTab / host 权限）。 */
		function captureVisibleTab(
			windowId: number | undefined,
			options: { format: "png" | "jpeg"; quality?: number },
		): Promise<string>;
	}

	namespace windows {
		function update(windowId: number, props: { focused?: boolean }): Promise<unknown>;
	}

	namespace storage {
		const sync: {
			get(keys: string[] | null): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
	}

	namespace permissions {
		function contains(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
		function request(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
	}
}
