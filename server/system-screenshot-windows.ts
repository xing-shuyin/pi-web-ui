import { spawn } from "node:child_process";

export const WINDOWS_SCREENSHOT_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

public sealed class PiScreenSelection : Form {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    readonly Bitmap screen;
    readonly string hint;
    readonly System.Windows.Forms.Timer timer;
    Point start;
    Rectangle selection;
    bool dragging;
    public Bitmap Result;

    PiScreenSelection(Bitmap screen, Rectangle bounds, string hint, Task<string> cancel, Process parent) {
        this.screen = screen;
        this.hint = hint;
        Text = "pi-web-ui system screenshot";
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        ShowInTaskbar = false;
        TopMost = true;
        DoubleBuffered = true;
        KeyPreview = true;
        Cursor = Cursors.Cross;
        var deadline = DateTime.UtcNow.AddSeconds(90);
        timer = new System.Windows.Forms.Timer { Interval = 100 };
        timer.Tick += (s, e) => {
            if (cancel.IsCompleted || parent.HasExited || DateTime.UtcNow >= deadline) Close();
        };
        timer.Start();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) timer.Dispose();
        base.Dispose(disposing);
    }
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        Activate();
        SetForegroundWindow(Handle);
    }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.DrawImageUnscaled(screen, 0, 0);
        using (var shade = new SolidBrush(Color.FromArgb(115, 0, 0, 0)))
        using (var outside = new Region(ClientRectangle)) {
            if (selection.Width > 0 && selection.Height > 0) outside.Exclude(selection);
            e.Graphics.FillRegion(shade, outside);
        }
        if (selection.Width > 0 && selection.Height > 0) {
            e.Graphics.DrawRectangle(Pens.White, selection.X, selection.Y, selection.Width - 1, selection.Height - 1);
        }
        // Keep instructions on the display containing the pointer, including negative-origin monitors.
        var display = Screen.FromPoint(Cursor.Position).Bounds;
        var position = new Point(display.Left - Left + 20, display.Top - Top + 20);
        using (var background = new SolidBrush(Color.FromArgb(210, 0, 0, 0))) {
            var size = e.Graphics.MeasureString(hint, SystemFonts.MessageBoxFont);
            e.Graphics.FillRectangle(background, position.X - 8, position.Y - 6, size.Width + 16, size.Height + 12);
            e.Graphics.DrawString(hint, SystemFonts.MessageBoxFont, Brushes.White, position);
        }
    }
    Point Clamp(Point p) {
        return new Point(Math.Max(0, Math.Min(screen.Width, p.X)), Math.Max(0, Math.Min(screen.Height, p.Y)));
    }
    void UpdateSelection(Point end) {
        end = Clamp(end);
        selection = Rectangle.FromLTRB(Math.Min(start.X, end.X), Math.Min(start.Y, end.Y),
                                       Math.Max(start.X, end.X), Math.Max(start.Y, end.Y));
        Invalidate();
    }
    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button == MouseButtons.Right) { Close(); return; }
        if (e.Button != MouseButtons.Left) return;
        start = Clamp(e.Location);
        dragging = true;
        Capture = true;
        UpdateSelection(start);
    }
    protected override void OnMouseMove(MouseEventArgs e) {
        if (dragging) UpdateSelection(e.Location);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        if (e.Button != MouseButtons.Left || !dragging) return;
        UpdateSelection(e.Location);
        dragging = false;
        Capture = false;
        if (selection.Width < 2 || selection.Height < 2) { Invalidate(); return; }
        Result = screen.Clone(selection, PixelFormat.Format32bppArgb);
        Close();
    }
    protected override void OnKeyDown(KeyEventArgs e) {
        if (e.KeyCode == Keys.Escape) { e.Handled = true; Close(); }
        base.OnKeyDown(e);
    }
    public static void Run(string token, string hint, int parentId, bool hideWindow) {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        var window = GetForegroundWindow();
        var title = new StringBuilder(2048);
        GetWindowText(window, title, title.Capacity);
        // Never minimize a different foreground window if focus changed during helper startup.
        if (hideWindow && (window == IntPtr.Zero || title.ToString().IndexOf(token, StringComparison.Ordinal) < 0))
            throw new InvalidOperationException("window-not-focused");
        var restore = IsZoomed(window) ? 3 : 9;
        using (var parent = Process.GetProcessById(parentId)) {
            // Console.In.ReadLineAsync can block synchronously on .NET Framework's SyncTextReader.
            var cancel = Task.Run(() => Console.In.ReadLine());
            if (cancel.IsCompleted || parent.HasExited) return;
            // Only hidden windows need recovery if the helper cannot exit normally.
            if (hideWindow) {
                Console.Error.WriteLine("window:" + window.ToInt64() + ":" + restore);
                Console.Error.Flush();
            }
            try {
                if (hideWindow) ShowWindow(window, 6);
                System.Threading.Thread.Sleep(400);
                if (cancel.IsCompleted || parent.HasExited) return;
                var bounds = SystemInformation.VirtualScreen;
                if ((long)bounds.Width * bounds.Height > 100000000)
                    throw new InvalidOperationException("screen-too-large");
                using (var screen = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb)) {
                    using (var graphics = Graphics.FromImage(screen))
                        graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
                    using (var picker = new PiScreenSelection(screen, bounds, hint, cancel, parent)) {
                        Application.Run(picker);
                        using (var result = picker.Result) {
                            if (result == null) return;
                            using (var stream = new MemoryStream()) {
                                result.Save(stream, ImageFormat.Png);
                                Console.Out.Write(Convert.ToBase64String(stream.ToArray()));
                            }
                        }
                    }
                }
            } finally {
                if (hideWindow && IsWindow(window)) {
                    ShowWindow(window, restore);
                    SetForegroundWindow(window);
                }
            }
        }
    }
}
`;

export function windowsScreenshotScript(
	token: string,
	locale: "zh" | "en",
	parentId = process.pid,
	hideWindow = true,
): string {
	if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("invalid screenshot token");
	const hint =
		locale === "zh"
			? "拖动框选 · 松开完成 · Esc / 右键取消"
			: "Drag to select · Release to capture · Esc / right click to cancel";
	return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOWS_SCREENSHOT_SOURCE}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing
try { [PiScreenSelection]::Run('${token}', '${hint}', ${parentId}, $${hideWindow ? "true" : "false"}) }
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`;
}

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function captureWindowsScreenshot(
	token: string,
	locale: "zh" | "en",
	signal: AbortSignal,
	hideWindow = true,
): Promise<string | null> {
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const script = windowsScreenshotScript(token, locale, process.pid, hideWindow);
		const child = spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-STA",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			],
			{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
		);
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		let failure: Error | null = null;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		let closing = false;
		const cancel = () => {
			if (closing) return;
			closing = true;
			child.stdin.end("cancel\n");
			forceTimer = setTimeout(() => {
				child.kill();
				const window = /window:(\d+):(3|9)/.exec(stderr);
				if (!window) return;
				const recovery = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class PiRestore { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); }'; [PiRestore]::ShowWindow([IntPtr]${window[1]}, ${window[2]}) | Out-Null`;
				const restore = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", recovery], {
					windowsHide: true,
					stdio: "ignore",
				});
				restore.on("error", () => {});
			}, 5000);
		};
		child.stdin.on("error", () => {});
		const timeout = setTimeout(() => {
			failure = new Error("screenshot-timeout");
			cancel();
		}, 150_000);
		const cleanup = () => {
			clearTimeout(timeout);
			clearTimeout(forceTimer);
			signal.removeEventListener("abort", cancel);
		};
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_IMAGE_BYTES) {
				failure = new Error("screen-too-large");
				cancel();
			} else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-8192);
		});
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (code) => {
			cleanup();
			if (failure) return reject(failure);
			if (signal.aborted) return resolve(null);
			if (code !== 0)
				return reject(new Error(stderr.includes("window-not-focused") ? "window-not-focused" : "capture-failed"));
			const base64 = Buffer.concat(chunks).toString().trim();
			if (!base64) return resolve(null);
			if (!Buffer.from(base64.slice(0, 12), "base64").subarray(0, 8).equals(PNG_SIGNATURE))
				return reject(new Error("capture-failed"));
			resolve(`data:image/png;base64,${base64}`);
		});
	});
}
