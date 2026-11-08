declare namespace chrome {
	namespace runtime {
		interface MessageSender {
			tab?: { id?: number; url?: string; title?: string };
		}
		function sendMessage(message: unknown): Promise<unknown>;
		function getURL(path: string): string;
		function getManifest(): { version?: string };
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
		function query(info: {
			url?: string | string[];
			active?: boolean;
			currentWindow?: boolean;
			lastFocusedWindow?: boolean;
		}): Promise<Tab[]>;
		function update(tabId: number, props: { active?: boolean }): Promise<Tab>;
		function create(props: { url: string }): Promise<Tab>;
		function captureVisibleTab(
			windowId: number | undefined,
			options: { format: "png" | "jpeg"; quality?: number },
		): Promise<string>;
		function sendMessage<T>(tabId: number, message: unknown): Promise<T>;
		const onUpdated: {
			addListener(cb: (tabId: number, info: { status?: string; url?: string }, tab: Tab) => void): void;
		};
	}

	namespace windows {
		function update(windowId: number, props: { focused?: boolean }): Promise<unknown>;
	}

	namespace storage {
		const sync: {
			get(keys: string[] | null): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
		const local: {
			get(keys: string[] | null): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
		const onChanged:
			| { addListener(cb: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void): void }
			| undefined;
	}

	namespace permissions {
		function contains(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
		function request(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
	}

	namespace i18n {
		function getMessage(messageName: string, substitutions?: string | string[]): string;
		function getUILanguage(): string;
	}
}
