package app.pi.mobile.localengine;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.List;

/**
 * Capacitor bridge for the on-device engine. JS contract lives in src/definitions.ts;
 * readiness waits run on the plugin worker thread, never on the UI thread.
 */
@CapacitorPlugin(name = "LocalEngine")
public class LocalEnginePlugin extends Plugin {

	private final EngineState.StatusListener statusListener = status -> notifyStatus(status);
	private final EngineState.LogListener logListener = entry -> {
		JSObject data = new JSObject();
		JSObject item = new JSObject();
		item.put("seq", entry.seq);
		item.put("line", entry.line);
		item.put("stream", entry.stream);
		// One event per line keeps the JS side trivial; the ring buffer snapshot covers backfill.
		// One event per line keeps the JS side trivial; the ring buffer snapshot covers backfill.
		data.put("entries", new JSObject[] { item });
		notifyListeners("logs", data);
	};

	@Override
	public void load() {
		EngineState.addStatusListener(statusListener);
		EngineState.addLogListener(logListener);
		RuntimeInstaller.ensureDataLayout(getContext());
		refreshInstalledState();
	}

	@Override
	protected void handleOnDestroy() {
		EngineState.removeStatusListener(statusListener);
		EngineState.removeLogListener(logListener);
		super.handleOnDestroy();
	}

	@PluginMethod
	public void getStatus(PluginCall call) {
		refreshInstalledState();
		call.resolve(statusData(EngineState.snapshot()));
	}

	@PluginMethod
	public void install(PluginCall call) {
		String current = EngineState.getPhase();
		if (EngineState.PHASE_RUNNING.equals(current) || EngineState.PHASE_STARTING.equals(current)) {
			call.reject("引擎运行中，请先停止再安装运行环境。");
			return;
		}
		if (EngineState.PHASE_INSTALLED.equals(current)) {
			try {
				RuntimeInstaller.Manifest builtin = RuntimeInstaller.readBuiltinManifest(getContext());
				if (builtin.version.equals(EngineState.getInstalledVersion())) {
					call.resolve(); // already up to date
					return;
				}
				call.reject("已安装其他版本（" + EngineState.getInstalledVersion() + "），请先重置运行环境。");
				return;
			} catch (IOException failure) {
				call.reject("无法读取内置运行环境清单：" + failure.getMessage());
				return;
			}
		}
		try {
			RuntimeInstaller.install(getContext(), (step, done, total) -> {
				JSObject data = new JSObject();
				data.put("step", step);
				data.put("done", done);
				data.put("total", total);
				notifyListeners("progress", data);
			});
			call.resolve();
		} catch (IOException failure) {
			call.reject("安装运行环境失败：" + failure.getMessage());
		} catch (InterruptedException failure) {
			Thread.currentThread().interrupt();
			call.reject("安装被中断。");
		}
	}

	/** 与 LocalEngineService.READY_TIMEOUT_MS 对齐；浅慢设备冷启动可达 90s。 */
	private static final long START_TIMEOUT_MS = 125_000;

	@PluginMethod
	public void start(PluginCall call) {
		refreshInstalledState();
		String current = EngineState.getPhase();
		if (EngineState.PHASE_RUNNING.equals(current)) {
			call.resolve(endpointData());
			return;
		}
		if (!EngineState.PHASE_INSTALLED.equals(current)) {
			call.reject("运行环境尚未安装，请先安装。");
			return;
		}
		try {
			Intent intent = new Intent(getContext(), LocalEngineService.class);
			ContextCompat.startForegroundService(getContext(), intent);
			String reached = EngineState.awaitPhase(START_TIMEOUT_MS, EngineState.PHASE_RUNNING, EngineState.PHASE_ERROR);
			if (EngineState.PHASE_ERROR.equals(reached)) {
				call.reject(EngineState.snapshot().error == null ? "引擎启动失败。" : EngineState.snapshot().error);
				return;
			}
			if (!EngineState.PHASE_RUNNING.equals(reached)) {
				// 绝不可在此返回空 endpoint：UI 会把 null 当凭据存下去。
				call.reject("引擎启动超时（" + (START_TIMEOUT_MS / 1000) + " 秒），请查看引擎日志。");
				return;
			}
			call.resolve(endpointData());
		} catch (InterruptedException failure) {
			Thread.currentThread().interrupt();
			call.reject("等待引擎启动被中断。");
		}
	}

	@PluginMethod
	public void stop(PluginCall call) {
		try {
			String current = EngineState.getPhase();
			if (EngineState.PHASE_RUNNING.equals(current) || EngineState.PHASE_STARTING.equals(current)) {
				EngineState.setPhase(EngineState.PHASE_STOPPING);
				Intent intent = new Intent(getContext(), LocalEngineService.class);
				getContext().stopService(intent);
				EngineState.awaitPhase(10_000, EngineState.PHASE_INSTALLED, EngineState.PHASE_NOT_INSTALLED);
			}
			call.resolve();
		} catch (InterruptedException failure) {
			Thread.currentThread().interrupt();
			call.reject("等待引擎停止被中断。");
		}
	}

	@PluginMethod
	public void getLogSnapshot(PluginCall call) {
		int lines = call.getInt("lines", 300);
		List<EngineState.LogEntry> entries = EngineState.snapshotLogs(lines);
		JSObject[] items = new JSObject[entries.size()];
		for (int index = 0; index < entries.size(); index++) {
			EngineState.LogEntry entry = entries.get(index);
			JSObject item = new JSObject();
			item.put("seq", entry.seq);
			item.put("line", entry.line);
			item.put("stream", entry.stream);
			items[index] = item;
		}
		JSObject data = new JSObject();
		data.put("entries", items);
		data.put("throughSeq", EngineState.maxLogSeq());
		call.resolve(data);
	}

	@PluginMethod
	public void reset(PluginCall call) {
		try {
			String current = EngineState.getPhase();
			if (EngineState.PHASE_RUNNING.equals(current) || EngineState.PHASE_STARTING.equals(current)) {
				EngineState.setPhase(EngineState.PHASE_STOPPING);
				Intent intent = new Intent(getContext(), LocalEngineService.class);
				getContext().stopService(intent);
				EngineState.awaitPhase(10_000, EngineState.PHASE_INSTALLED, EngineState.PHASE_NOT_INSTALLED);
			}
		} catch (InterruptedException failure) {
			Thread.currentThread().interrupt();
			call.reject("等待引擎停止被中断。");
			return;
		}
		RuntimeInstaller.reset(getContext());
		call.resolve();
	}

	private void refreshInstalledState() {
		try {
			RuntimeInstaller.Manifest installed = RuntimeInstaller.readInstalledManifest(getContext());
			if (installed != null) {
				EngineState.setInstalledVersion(installed.version);
				EngineState.setAbi(installed.abi);
			}
			RuntimeInstaller.Manifest builtin = RuntimeInstaller.readBuiltinManifest(getContext());
			EngineState.setAbi(builtin.abi);
			EngineState.setBuiltinVersion(builtin.version);
			String phase = EngineState.getPhase();
			if (installed == null
				&& (EngineState.PHASE_INSTALLED.equals(phase)
					|| EngineState.PHASE_NOT_INSTALLED.equals(phase)
					|| EngineState.PHASE_ERROR.equals(phase)
					|| phase.isEmpty())) {
				EngineState.setPhase(EngineState.PHASE_NOT_INSTALLED);
			} else if (installed != null
				&& (EngineState.PHASE_NOT_INSTALLED.equals(phase)
					|| EngineState.PHASE_ERROR.equals(phase)
					|| phase.isEmpty())) {
				EngineState.setPhase(RuntimeInstaller.isInstalledVersionUsable(getContext())
					? EngineState.PHASE_INSTALLED
					: EngineState.PHASE_NOT_INSTALLED);
				if (!RuntimeInstaller.isInstalledVersionUsable(getContext())) {
					EngineState.setInstalledVersion(null);
				}
			}
		} catch (IOException missingAssets) {
			// No engine artifacts in this APK build — surface a clear error instead of guessing.
			EngineState.setAbi("");
			EngineState.setBuiltinVersion("");
			if (EngineState.PHASE_NOT_INSTALLED.equals(EngineState.getPhase())) {
				EngineState.setError("APK 内没有运行环境产物（localengine assets），请先用 CI 构建填充。");
			}
		}
	}

	private JSObject statusData(EngineState.Status status) {
		JSObject data = new JSObject();
		data.put("phase", status.phase);
		data.put("abi", status.abi);
		data.put("builtinVersion", status.builtinVersion);
		data.put("installedVersion", status.installedVersion);
		data.put("baseUrl", status.baseUrl);
		data.put("token", status.token);
		data.put("error", status.error);
		return data;
	}

	private JSObject endpointData() {
		JSObject endpoint = new JSObject();
		endpoint.put("serverUrl", EngineState.getBaseUrl());
		endpoint.put("token", EngineState.getToken());
		JSObject data = new JSObject();
		data.put("endpoint", endpoint);
		return data;
	}

	private void notifyStatus(EngineState.Status status) {
		notifyListeners("status", statusData(status));
	}
}
