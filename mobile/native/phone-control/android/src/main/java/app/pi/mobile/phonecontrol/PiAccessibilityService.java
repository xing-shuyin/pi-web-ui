package app.pi.mobile.phonecontrol;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.Executor;

/**
 * Drives this phone on behalf of the agent: reads the current screen and performs gestures.
 *
 * The service is the only place with window access, so every plugin method delegates here.
 * Users enable it by hand in system settings — nothing here can (or should) grant that.
 */
public final class PiAccessibilityService extends AccessibilityService {

    /** Bound instance, null while the user has not enabled the service. */
    private static volatile PiAccessibilityService instance;

    static PiAccessibilityService instance() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (instance == this) instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // One-shot reads only: the plugin asks for the tree when it needs it.
    }

    @Override
    public void onInterrupt() {}

    // ---- 读取界面 ----

    JSObject dump(int maxDepth, int maxNodes) {
        JSObject out = new JSObject();
        JSObject screen = new JSObject();
        screen.put("width", getResources().getDisplayMetrics().widthPixels);
        screen.put("height", getResources().getDisplayMetrics().heightPixels);
        out.put("screen", screen);

        AccessibilityNodeInfo root = getRootInActiveWindow();
        JSArray nodes = new JSArray();
        if (root == null) {
            out.put("packageName", "");
            out.put("nodes", nodes);
            return out;
        }
        CharSequence pkg = root.getPackageName();
        out.put("packageName", pkg == null ? "" : pkg.toString());
        walk(root, 0, Math.max(1, maxDepth), Math.max(1, maxNodes), nodes);
        out.put("nodes", nodes);
        return out;
    }

    private void walk(AccessibilityNodeInfo node, int depth, int maxDepth, int maxNodes, JSArray out) {
        if (node == null || depth > maxDepth || out.length() >= maxNodes) return;
        Rect rect = new Rect();
        node.getBoundsInScreen(rect);
        boolean interesting =
            node.isClickable() ||
            node.isEditable() ||
            node.isScrollable() ||
            node.isCheckable() ||
            node.getText() != null ||
            node.getContentDescription() != null;
        if (interesting && rect.width() > 0 && rect.height() > 0) {
            JSObject item = new JSObject();
            item.put("index", out.length());
            item.put("depth", depth);
            if (node.getText() != null) item.put("text", trim(node.getText().toString()));
            if (node.getContentDescription() != null) item.put("desc", trim(node.getContentDescription().toString()));
            CharSequence cls = node.getClassName();
            if (cls != null) item.put("cls", shortName(cls.toString()));
            String viewId = node.getViewIdResourceName();
            if (viewId != null) item.put("viewId", viewId.substring(viewId.lastIndexOf('/') + 1));
            item.put("clickable", node.isClickable());
            item.put("editable", node.isEditable());
            item.put("scrollable", node.isScrollable());
            item.put("enabled", node.isEnabled());
            item.put("selected", node.isSelected());
            item.put("checked", node.isChecked());
            item.put("focused", node.isFocused());
            JSArray bounds = new JSArray();
            bounds.put(rect.left);
            bounds.put(rect.top);
            bounds.put(rect.right);
            bounds.put(rect.bottom);
            item.put("bounds", bounds);
            out.put(item);
        }
        int count = node.getChildCount();
        for (int index = 0; index < count; index++) {
            walk(node.getChild(index), depth + 1, maxDepth, maxNodes, out);
        }
    }

    private static String trim(String value) {
        String flat = value.replace('\n', ' ').trim();
        return flat.length() > 200 ? flat.substring(0, 200) : flat;
    }

    private static String shortName(String className) {
        int dot = className.lastIndexOf('.');
        return dot < 0 ? className : className.substring(dot + 1);
    }

    // ---- 手势 ----

    boolean tap(float x, float y) {
        Path path = new Path();
        path.moveTo(x, y);
        return dispatch(new GestureDescription.StrokeDescription(path, 0, 40));
    }

    boolean longPress(float x, float y, long durationMs) {
        Path path = new Path();
        path.moveTo(x, y);
        return dispatch(new GestureDescription.StrokeDescription(path, 0, clamp(durationMs, 300, 10_000)));
    }

    boolean swipe(float x1, float y1, float x2, float y2, long durationMs) {
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        return dispatch(new GestureDescription.StrokeDescription(path, 0, clamp(durationMs, 50, 10_000)));
    }

    private boolean dispatch(GestureDescription.StrokeDescription stroke) {
        GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
        return dispatchGesture(gesture, null, null);
    }

    // ---- 输入 ----

    boolean setText(String value) {
        AccessibilityNodeInfo target = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (target == null) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) target = findEditable(root);
        }
        if (target == null) return false;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    private AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable()) return node;
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo found = findEditable(node.getChild(index));
            if (found != null) return found;
        }
        return null;
    }

    // ---- 系统动作 ----

    boolean globalAction(String name) {
        int action;
        switch (name) {
            case "back":
                action = GLOBAL_ACTION_BACK;
                break;
            case "home":
                action = GLOBAL_ACTION_HOME;
                break;
            case "recents":
                action = GLOBAL_ACTION_RECENTS;
                break;
            case "notifications":
                action = GLOBAL_ACTION_NOTIFICATIONS;
                break;
            case "quickSettings":
                action = GLOBAL_ACTION_QUICK_SETTINGS;
                break;
            default:
                return false;
        }
        return performGlobalAction(action);
    }

    boolean launchApp(String packageName) {
        Intent intent = getPackageManager().getLaunchIntentForPackage(packageName);
        if (intent == null) return false;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
        return true;
    }

    // ---- 截图 ----

    interface ScreenshotCallback {
        void onResult(String base64, int width, int height, String error);
    }

    void screenshot(Executor executor, int maxWidth, ScreenshotCallback callback) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            callback.onResult(null, 0, 0, "截图需要 Android 11 及以上版本。");
            return;
        }
        takeScreenshot(Display.DEFAULT_DISPLAY, executor, new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult result) {
                HardwareBuffer buffer = result.getHardwareBuffer();
                try {
                    Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                    if (hardware == null) {
                        callback.onResult(null, 0, 0, "截图解码失败。");
                        return;
                    }
                    // 硬件位图不能直接缩放/压缩，先拷成软件位图再处理。
                    Bitmap source = hardware.copy(Bitmap.Config.ARGB_8888, false);
                    int width = source.getWidth();
                    int height = source.getHeight();
                    Bitmap output = source;
                    if (maxWidth > 0 && width > maxWidth) {
                        int targetHeight = Math.max(1, Math.round(height * (maxWidth / (float) width)));
                        output = Bitmap.createScaledBitmap(source, maxWidth, targetHeight, true);
                    }
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    output.compress(Bitmap.CompressFormat.PNG, 100, bytes);
                    callback.onResult(
                        Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP),
                        output.getWidth(),
                        output.getHeight(),
                        null
                    );
                } catch (RuntimeException failure) {
                    callback.onResult(null, 0, 0, "截图处理失败：" + failure.getMessage());
                } finally {
                    buffer.close();
                }
            }

            @Override
            public void onFailure(int errorCode) {
                callback.onResult(null, 0, 0, "截图失败（code=" + errorCode + "），请确认屏幕已解锁。");
            }
        });
    }

    private static long clamp(long value, long min, long max) {
        return Math.max(min, Math.min(max, value));
    }
}
