import { registerHooks } from "node:module";

export const SENTINEL = "// pi-web-ui #794: bounded shell lifecycle v1";

export const SHELL_WAIT_SOURCE = `function waitForShellLifecycle(child, { onData, signal, timeout, timeoutMs, kill }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let exited = false;
        let exitCode = null;
        let stopError;
        let executionTimer;
        let drainTimer;
        let idleTimer;
        let stopTimer;
        const cleanup = () => {
            clearTimeout(executionTimer);
            clearTimeout(drainTimer);
            clearTimeout(idleTimer);
            clearTimeout(stopTimer);
            signal?.removeEventListener("abort", onAbort);
            child.removeListener("exit", onExit);
            child.removeListener("close", onClose);
            child.removeListener("error", onError);
            for (const stream of [child.stdout, child.stderr]) {
                stream?.removeListener("data", onOutput);
                stream?.destroy();
            }
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(exitCode);
        };
        const stop = (error) => {
            if (settled || stopError) return;
            stopError = error;
            clearTimeout(executionTimer);
            clearTimeout(drainTimer);
            clearTimeout(idleTimer);
            // Killing is best effort; inherited handles must never prevent settlement.
            stopTimer = setTimeout(() => finish(stopError), 1000);
            try { kill(); } catch { /* preserve the original timeout/cancellation */ }
        };
        const onAbort = () => stop(new Error("aborted"));
        const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish(stopError), 100);
        };
        const onOutput = (data) => {
            if (settled || stopError) return;
            try { onData(data); } catch (error) { stop(error); return; }
            if (exited) armIdle();
        };
        const onExit = (code) => {
            exited = true;
            exitCode = code;
            clearTimeout(executionTimer);
            if (stopError) { finish(stopError); return; }
            // Preserve the SDK's quiet-period drain, but never extend this hard cap.
            drainTimer = setTimeout(() => {
                try { onData(Buffer.from("\\n[Output collection stopped: inherited pipes remained open after the shell exited.]\\n")); }
                catch (error) { finish(error); return; }
                finish();
            }, 1000);
            armIdle();
        };
        const onClose = (code) => {
            exitCode = code;
            finish(stopError);
        };
        const onError = (error) => finish(stopError ?? error);
        child.once("exit", onExit);
        child.once("close", onClose);
        child.once("error", onError);
        child.stdout?.on("data", onOutput);
        child.stderr?.on("data", onOutput);
        if (timeoutMs !== undefined) {
            executionTimer = setTimeout(() => stop(new Error("timeout:" + timeout)), timeoutMs);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}`;

const OLD_LIFECYCLE =
	/            let timedOut = false;\r?\n[\s\S]*?            finally \{[\s\S]*?signal\.removeEventListener\("abort", onAbort\);\r?\n            \}/;
const REPLACEMENT = `            try {
                const exitCode = await waitForShellLifecycle(child, {
                    onData, signal, timeout, timeoutMs,
                    kill: () => { if (child.pid) killProcessTree(child.pid); },
                });
                const signalCode = child.signalCode;
                return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
            } finally {
                if (child.pid) untrackDetachedChildPid(child.pid);
            }`;

export function patchBashProcessSource(source: string): {
	code: string;
	status: "patched" | "already" | "unsupported";
} {
	if (source.includes(SENTINEL)) return { code: source, status: "already" };
	if (!source.includes('from "../../utils/child-process.js"') || !OLD_LIFECYCLE.test(source)) {
		return { code: source, status: "unsupported" };
	}
	const code = source
		.replace(/import \{ waitForChildProcess \} from "\.\.\/\.\.\/utils\/child-process\.js";\r?\n/, "")
		.replace(OLD_LIFECYCLE, REPLACEMENT);
	return { code: `${code}\n${SENTINEL}\n${SHELL_WAIT_SOURCE}\n`, status: "patched" };
}

export function registerBashProcessPatch(): void {
	registerHooks({
		load(url, context, nextLoad) {
			const loaded = nextLoad(url, context);
			if (!url.replaceAll("\\\\", "/").endsWith("/@earendil-works/pi-coding-agent/dist/core/tools/bash.js"))
				return loaded;
			if (loaded.source == null) return loaded;
			const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
			const result = patchBashProcessSource(source);
			if (result.status === "unsupported")
				console.warn(`[bash-process] SDK lifecycle patch not applied (unrecognized source): ${url}`);
			return { ...loaded, source: result.code };
		},
	});
}
