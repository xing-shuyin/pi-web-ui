package app.pi.mobile.localengine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Foreground service hosting the on-device engine:
 * proot(rootfs) → node → dist/server/index.js listening on 127.0.0.1:<random port>.
 *
 * Readiness is detected by probing the loopback port we allocated ourselves — the server
 * banner format never leaks into control flow. stdout/stderr feed the ring log only.
 */
public final class LocalEngineService extends Service {

	private static final String CHANNEL_ID = "pi_localengine";
	private static final int NOTIFICATION_ID = 0x4c45; // "LE"
	private static final long READY_TIMEOUT_MS = 120_000;   // 模拟器/低端机上 proot+node 冷启动可达 60-90s
	private static final long READY_INTERVAL_MS = 700;
	private static final int CRASH_RESTART_LIMIT = 3;
	private static final long[] CRASH_BACKOFF_MS = { 2_000, 5_000, 10_000 };

	/**
	 * rename 兼容层：App 进程带着 zygote 下发的 seccomp 过滤器，`renameat2` 直接返回 ENOSYS，
	 * glibc 的 `rename()` 不做回退 —— 不带它，proot 里的 node 所有 rename 全崩（原子写/插件物化/会话落盘）。
	 * 详见 assets/pi-localengine/rename-compat.cjs 与 docs/mobile-local-engine.md。
	 */
	private static final String RENAME_COMPAT_ASSET = "pi-localengine/rename-compat.cjs";
	private static final String RENAME_COMPAT_GUEST_PATH = "/root/.pi-mobile/rename-compat.cjs";

	private static volatile Process process;
	private static volatile int boundPort = -1;
	private static volatile String sessionToken = null;
	private static int crashCount = 0;
	private volatile boolean renameCompatReady = false;

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.localengine_notification_running)));
		if (process != null && process.isAlive()) {
			EngineState.systemLog("引擎进程仍在运行，复用现有实例。");
			return START_STICKY;
		}
		Thread launcher = new Thread(this::launchEngine, "localengine-launch");
		launcher.setDaemon(true);
		launcher.start();
		return START_STICKY;
	}

	@Override
	public void onDestroy() {
		Process current = process;
		process = null;
		if (current != null) {
			current.destroy();
			destroyForciblyAfter(current, 3_000);
		}
		if (EngineState.PHASE_STOPPING.equals(EngineState.getPhase())) {
			EngineState.setStopped();
		}
		super.onDestroy();
	}

	private void launchEngine() {
		try {
			EngineState.setPhase(EngineState.PHASE_STARTING);
			File rootfs = RuntimeInstaller.rootfsDir(this);
			File node = new File(rootfs, "usr/local/bin/node");
			File appRoot = new File(rootfs, "usr/local/lib/node_modules/pi-web-ui");
			File serverEntry = new File(appRoot, "dist/server/index.js");
			File sdkHook = new File(appRoot, "dist/server/resolve-global-sdk.js");
			File proot = new File(rootfs, "usr/local/bin/proot");

			if (!proot.isFile()) throw new IOException("运行环境不完整：缺少 proot，请重新安装运行环境。");
			if (!node.isFile()) throw new IOException("运行环境不完整：缺少 node，请重新安装运行环境。");
			if (!serverEntry.isFile()) throw new IOException("运行环境不完整：缺少 dist/server，请重新安装运行环境。");
			RuntimeInstaller.ensureDataLayout(this);
			installRenameCompat(rootfs);
			File prootTmp = new File(getCacheDir(), "proot-tmp");
			if (!prootTmp.isDirectory() && !prootTmp.mkdirs()) throw new IOException("无法创建 proot 临时目录。");

			int port = allocatePort();
			String token = randomToken();
			boundPort = port;
			sessionToken = token;

			List<String> command = new ArrayList<>();
			command.add(proot.getAbsolutePath());
			command.add("-r");
			command.add(rootfs.getAbsolutePath());
			command.add("-0");
			command.add("-w");
			command.add("/root");
			command.add("-b");
			command.add("/dev");
			command.add("-b");
			command.add("/proc");
			command.add("-b");
			command.add("/sys");
			command.add("-b");
			command.add(new File(getCacheDir(), "proot-tmp").getAbsolutePath() + ":/tmp");
			command.add("/usr/local/bin/node");
			if (renameCompatReady) {
				command.add("--require");
				command.add(RENAME_COMPAT_GUEST_PATH);
			}
			command.add("--import");
			command.add("/usr/local/lib/node_modules/pi-web-ui/dist/server/resolve-global-sdk.js");
			command.add("/usr/local/lib/node_modules/pi-web-ui/dist/server/index.js");

			ProcessBuilder builder = new ProcessBuilder(command);
			builder.redirectErrorStream(false);
			builder.environment().putAll(engineEnvironment(port, token, rootfs));
			EngineState.systemLog("启动引擎：port=" + port);
			for (Map.Entry<String, String> entry : builder.environment().entrySet()) {
				EngineState.systemLog("env " + entry.getKey() + "=" + entry.getValue());
			}
			EngineState.systemLog("cmd " + String.join(" ", command));
			Process started = builder.start();
			process = started;
			pump(started.getInputStream(), "stdout");
			pump(started.getErrorStream(), "stderr");
			watchExit(started);
			awaitReady(port);
			EngineState.setRunning("http://127.0.0.1:" + port, token);
			crashCount = 0;
			EngineState.systemLog("引擎就绪：" + EngineState.getBaseUrl());
		} catch (Exception failure) {
			EngineState.setError("引擎启动失败：" + failure.getMessage());
			stopSelf();
		}
	}

	/** Exit watcher with bounded crash restart; gives up loudly after CRASH_RESTART_LIMIT. */
	private void watchExit(Process running) {
		Thread watcher = new Thread(() -> {
			int code;
			try {
				code = running.waitFor();
			} catch (InterruptedException failure) {
				return;
			}
			if (process != running) return; // a newer instance took over
			EngineState.systemLog("引擎进程退出，code=" + code);
			boolean deliberate = EngineState.PHASE_STOPPING.equals(EngineState.getPhase())
				|| EngineState.PHASE_INSTALLING.equals(EngineState.getPhase());
			if (deliberate) {
				EngineState.setStopped();
				return;
			}
			if (crashCount < CRASH_RESTART_LIMIT) {
				long backoff = CRASH_BACKOFF_MS[Math.min(crashCount, CRASH_BACKOFF_MS.length - 1)];
				crashCount++;
				EngineState.systemLog("自动重启 #" + crashCount + "（" + backoff + "ms 后）");
				try {
					Thread.sleep(backoff);
				} catch (InterruptedException failure) {
					return;
				}
				launchEngine();
			} else {
				EngineState.setError("引擎反复崩溃（连续 " + crashCount + " 次），已停止自动重启，请查看引擎日志。");
				stopSelf();
			}
		}, "localengine-watch");
		watcher.setDaemon(true);
		watcher.start();
	}

	/** Loopback probe: the port is ours, so a successful connect means the HTTP server is up. */
	private void awaitReady(int port) throws InterruptedException, IOException {
		long deadline = System.currentTimeMillis() + READY_TIMEOUT_MS;
		while (System.currentTimeMillis() < deadline) {
			if (process == null) throw new IOException("引擎进程已退出。");
			try (Socket probe = new Socket()) {
				probe.connect(new InetSocketAddress("127.0.0.1", port), 800);
				return;
			} catch (IOException notYet) {
				Thread.sleep(READY_INTERVAL_MS);
			}
		}
		throw new IOException("引擎在 " + (READY_TIMEOUT_MS / 1000) + " 秒内未就绪，请查看引擎日志。");
	}

	private void pump(java.io.InputStream stream, String streamName) {
		Thread pump = new Thread(() -> {
			try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream), 8 * 1024)) {
				String line;
				while ((line = reader.readLine()) != null) {
					EngineState.log(streamName, line);
				}
			} catch (IOException closed) {
				EngineState.systemLog(streamName + " 流已关闭。");
			}
		}, "localengine-pump-" + streamName);
		pump.setDaemon(true);
		pump.start();
	}

	/**
	 * 把 rename 兼容层写进 rootfs 再让 node `--require` 它。App 内运行时装不了包，preload 只能自带；
	 * 每次启动按内容比对重写，升级 APK 后旧 rootfs 里的副本跟着换。
	 */
	private void installRenameCompat(File rootfs) {
		File target = new File(rootfs, "root/.pi-mobile/rename-compat.cjs");
		try (InputStream asset = getAssets().open(RENAME_COMPAT_ASSET)) {
			byte[] expected = readAll(asset);
			if (!hasContent(target, expected)) {
				File parent = target.getParentFile();
				if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建 " + parent);
				try (FileOutputStream out = new FileOutputStream(target)) {
					out.write(expected);
				}
			}
			renameCompatReady = true;
		} catch (IOException failure) {
			renameCompatReady = false;
			EngineState.systemLog("警告：rename 兼容层写入失败（" + failure.getMessage() + "），引擎落盘可能报 ENOSYS。");
		}
	}

	private static byte[] readAll(InputStream stream) throws IOException {
		ByteArrayOutputStream buffer = new ByteArrayOutputStream();
		byte[] chunk = new byte[8 * 1024];
		int read;
		while ((read = stream.read(chunk)) >= 0) buffer.write(chunk, 0, read);
		return buffer.toByteArray();
	}

	private static boolean hasContent(File file, byte[] expected) {
		if (!file.isFile() || file.length() != expected.length) return false;
		try (FileInputStream in = new FileInputStream(file)) {
			byte[] actual = new byte[expected.length];
			int offset = 0;
			while (offset < actual.length) {
				int read = in.read(actual, offset, actual.length - offset);
				if (read < 0) return false;
				offset += read;
			}
			return java.util.Arrays.equals(actual, expected);
		} catch (IOException missing) {
			return false;
		}
	}

	private Map<String, String> engineEnvironment(int port, String token, File rootfs) {
		Map<String, String> env = new HashMap<>();
		env.put("PI_WEB_HOST", "127.0.0.1");
		env.put("PI_WEB_PORT", String.valueOf(port));
		env.put("PI_WEB_TOKEN", token);
		env.put("PI_WEB_DATA_DIR", "/root/piwebui-data/data"); // bind 点上的 rename 是 ENOSYS，数据必须住 rootfs 内部真实路径
		env.put("PI_WEB_CWD", "/root/piwebui-data/workspace");
		env.put("PI_WEB_SDK", "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent");
		env.put("HOME", "/root");
		env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
		env.put("LANG", "C.UTF-8");
		env.put("TMPDIR", "/tmp");
		env.put("LD_LIBRARY_PATH", new File(rootfs, "usr/local/lib").getAbsolutePath()); // proot 自身加载 libtalloc/libandroid-shmem 用
		env.put("PROOT_LOADER", new File(rootfs, "usr/local/libexec/proot/loader").getAbsolutePath()); // loader 在 execve 时重映射 ELF interpreter
		env.put("PROOT_NO_SECCOMP", "1");
		env.put("PROOT_TMP_DIR", new File(getCacheDir(), "proot-tmp").getAbsolutePath());
		return env;
	}

	private Notification buildNotification(String text) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
			NotificationChannel channel = new NotificationChannel(
				CHANNEL_ID,
				getString(R.string.localengine_channel_name),
				NotificationManager.IMPORTANCE_LOW
			);
			channel.setDescription(getString(R.string.localengine_channel_description));
			manager.createNotificationChannel(channel);
		}
		Notification.Builder builder =
			Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
				? new Notification.Builder(this, CHANNEL_ID)
				: new Notification.Builder(this);
		return builder
			.setSmallIcon(android.R.drawable.ic_dialog_info)
			.setContentTitle(getString(R.string.localengine_notification_title))
			.setContentText(text)
			.setOngoing(true)
			.build();
	}

	private static int allocatePort() throws IOException {
		try (ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
			return socket.getLocalPort();
		}
	}

	private static String randomToken() {
		SecureRandom random = new SecureRandom();
		StringBuilder builder = new StringBuilder(64);
		String alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		for (int i = 0; i < 64; i++) builder.append(alphabet.charAt(random.nextInt(alphabet.length())));
		return builder.toString();
	}

	private static void destroyForciblyAfter(Process target, long delayMs) {
		Thread cleaner = new Thread(() -> {
			try {
				Thread.sleep(delayMs);
			} catch (InterruptedException ignored) {
				return;
			}
			if (target.isAlive()) {
				target.destroyForcibly();
				EngineState.systemLog("引擎进程未响应停止请求，已强制结束。");
			}
		}, "localengine-stop");
		cleaner.setDaemon(true);
		cleaner.start();
	}
}
