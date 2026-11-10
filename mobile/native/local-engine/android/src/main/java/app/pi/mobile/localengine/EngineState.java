package app.pi.mobile.localengine;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Process-wide engine state machine + ring log buffer.
 * The plugin (UI bridge) and the foreground service both live in the app process,
 * so a single static instance is the shared source of truth.
 */
public final class EngineState {

	/** Immutable status snapshot handed to listeners and getStatus(). */
	public static final class Status {
		public final String phase;
		public final String abi;
		public final String builtinVersion;
		public final String installedVersion;
		public final String baseUrl;
		public final String token;
		public final String error;

		Status(
			String phase,
			String abi,
			String builtinVersion,
			String installedVersion,
			String baseUrl,
			String token,
			String error
		) {
			this.phase = phase;
			this.abi = abi;
			this.builtinVersion = builtinVersion;
			this.installedVersion = installedVersion;
			this.baseUrl = baseUrl;
			this.token = token;
			this.error = error;
		}
	}

	/** One log line with a monotonic sequence number (never resets, survives engine restarts). */
	public static final class LogEntry {
		public final long seq;
		public final String line;
		public final String stream;

		LogEntry(long seq, String line, String stream) {
			this.seq = seq;
			this.line = line;
			this.stream = stream;
		}
	}

	public interface StatusListener {
		void onStatus(Status status);
	}

	public interface LogListener {
		void onLog(LogEntry entry);
	}

	public static final String PHASE_NOT_INSTALLED = "notInstalled";
	public static final String PHASE_INSTALLING = "installing";
	public static final String PHASE_INSTALLED = "installed";
	public static final String PHASE_STARTING = "starting";
	public static final String PHASE_RUNNING = "running";
	public static final String PHASE_STOPPING = "stopping";
	public static final String PHASE_ERROR = "error";

	private static final int LOG_CAPACITY = 2000;

	private static volatile String phase = PHASE_NOT_INSTALLED;
	private static volatile String abi = "";
	private static volatile String builtinVersion = "";
	private static volatile String installedVersion = null;
	private static volatile String baseUrl = null;
	private static volatile String token = null;
	private static volatile String error = null;
	private static final Object phaseLock = new Object();
	private static final List<StatusListener> statusListeners = new ArrayList<>();
	private static final List<LogListener> logListeners = new ArrayList<>();
	private static final Object logLock = new Object();
	private static final ArrayDeque<LogEntry> logBuffer = new ArrayDeque<>();
	private static final AtomicLong logSeq = new AtomicLong(0);

	private EngineState() {}

	public static Status snapshot() {
		return new Status(phase, abi, builtinVersion, installedVersion, baseUrl, token, error);
	}

	public static void setAbi(String value) {
		abi = value == null ? "" : value;
	}

	public static void setBuiltinVersion(String value) {
		builtinVersion = value == null ? "" : value;
	}

	public static void setInstalledVersion(String value) {
		installedVersion = value;
	}

	public static String getPhase() {
		return phase;
	}

	public static String getInstalledVersion() {
		return installedVersion;
	}

	public static String getBaseUrl() {
		return baseUrl;
	}

	public static String getToken() {
		return token;
	}

	/** Transitions the phase; notifies listeners and wakes awaitPhase() waiters. */
	public static void setPhase(String next) {
		synchronized (phaseLock) {
			phase = next;
			phaseLock.notifyAll();
		}
		fireStatus();
	}

	public static void setError(String message) {
		error = message == null ? null : message;
		setPhase(PHASE_ERROR);
	}

	public static void setRunning(String url, String sessionToken) {
		baseUrl = url;
		token = sessionToken;
		setPhase(PHASE_RUNNING);
	}

	/** Called when the process ends or is stopped; drops the endpoint but keeps the install. */
	public static void setStopped() {
		baseUrl = null;
		token = null;
		setPhase(installedVersion == null ? PHASE_NOT_INSTALLED : PHASE_INSTALLED);
	}

	public static void resetRuntime() {
		installedVersion = null;
		baseUrl = null;
		token = null;
		error = null;
		setPhase(PHASE_NOT_INSTALLED);
	}

	/** Blocks until the phase reaches one of the targets or the timeout elapses. Returns final phase. */
	public static String awaitPhase(long timeoutMs, String... targets) throws InterruptedException {
		long deadline = System.currentTimeMillis() + timeoutMs;
		synchronized (phaseLock) {
			while (true) {
				for (String target : targets) {
					if (target.equals(phase)) return phase;
				}
				long remaining = deadline - System.currentTimeMillis();
				if (remaining <= 0) return phase;
				phaseLock.wait(remaining);
			}
		}
	}

	public static void addStatusListener(StatusListener listener) {
		synchronized (statusListeners) {
			statusListeners.add(listener);
		}
		listener.onStatus(snapshot());
	}

	public static void removeStatusListener(StatusListener listener) {
		synchronized (statusListeners) {
			statusListeners.remove(listener);
		}
	}

	public static void addLogListener(LogListener listener) {
		synchronized (logListeners) {
			logListeners.add(listener);
		}
	}

	public static void removeLogListener(LogListener listener) {
		synchronized (logListeners) {
			logListeners.remove(listener);
		}
	}

	public static void log(String stream, String line) {
		android.util.Log.d("LocalEngine", "[" + stream + "] " + line); // 诊断直出 logcat
		LogEntry entry = new LogEntry(logSeq.incrementAndGet(), line, stream);
		synchronized (logLock) {
			logBuffer.addLast(entry);
			while (logBuffer.size() > LOG_CAPACITY) logBuffer.removeFirst();
		}
		synchronized (logListeners) {
			for (LogListener listener : logListeners) {
				try {
					listener.onLog(entry);
				} catch (RuntimeException ignored) {
					// a broken UI listener must never take the engine down
				}
			}
		}
	}

	public static void systemLog(String line) {
		log("system", line);
	}

	/** Returns the last {@code lines} entries and the highest sequence handed out so far. */
	public static List<LogEntry> snapshotLogs(int lines) {
		List<LogEntry> all;
		synchronized (logLock) {
			all = new ArrayList<>(logBuffer);
		}
		int from = Math.max(0, all.size() - Math.max(1, lines));
		return all.subList(from, all.size());
	}

	public static long maxLogSeq() {
		return logSeq.get();
	}

	public static String describeStatus(Status status) {
		return String.format(
			Locale.US,
			"phase=%s version=%s url=%s",
			status.phase,
			status.installedVersion == null ? "-" : status.installedVersion,
			status.baseUrl == null ? "-" : status.baseUrl
		);
	}

	private static void fireStatus() {
		Status current = snapshot();
		synchronized (statusListeners) {
			for (StatusListener listener : statusListeners) {
				try {
					listener.onStatus(current);
				} catch (RuntimeException ignored) {
					// never crash the engine over a UI hiccup
				}
			}
		}
	}
}
