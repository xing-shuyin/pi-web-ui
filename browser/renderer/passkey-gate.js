/**
 * passkey 的本地确认闸门（被主进程注入到每个 http(s) 页面，见 `browser/runtime/passkey-gate.ts`）。
 *
 * 页面脚本要在 document-start 就跑起来，所以这里只用 ES5 语法、不依赖任何构建产物；
 * 唯一的依赖是 preload 暴露的 `window.__piPasskey`（`{ version, confirm(kind) }`）。
 * 桥不在 / 调用失败 / 非安全上下文一律直接放行：闸门只是体验层，不能成为 passkey 的单点故障。
 */
(function () {
	if (window.__PI_PASSKEY_GATE__) return;
	if (location.protocol !== "https:" && location.protocol !== "http:") return;
	var container = navigator.credentials;
	if (!container) return;
	window.__PI_PASSKEY_GATE__ = true;

	var NAMES = ["create", "get"];
	NAMES.forEach(function (name) {
		var original = container[name];
		if (typeof original !== "function") return;
		var patched = function (options) {
			// 只拦 WebAuthn；密码类 credential 不经过闸门
			if (!options || !options.publicKey) return original.call(container, options);
			var api = window.__piPasskey;
			if (!api || api.version !== 1 || typeof api.confirm !== "function") return original.call(container, options);
			var approved;
			try {
				approved = Promise.resolve(api.confirm(name));
			} catch (_) {
				return original.call(container, options);
			}
			return approved.then(
				function (ok) {
					if (ok === false)
						throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
					return original.call(container, options);
				},
				function () {
					// 桥挂了就放行，别把登录卡在闸门上
					return original.call(container, options);
				},
			);
		};
		try {
			Object.defineProperty(patched, "name", { value: original.name });
			Object.defineProperty(patched, "length", { value: original.length });
			patched.toString = function () {
				return original.toString();
			};
		} catch (_) {}
		try {
			Object.defineProperty(container, name, { value: patched, configurable: true, writable: true });
		} catch (_) {}
	});
})();
