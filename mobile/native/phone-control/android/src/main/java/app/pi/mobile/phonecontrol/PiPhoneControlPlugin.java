package app.pi.mobile.phonecontrol;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge between the web layer and {@link PiAccessibilityService}.
 *
 * Every method fails loudly with SERVICE_DISABLED when the user has not enabled the
 * accessibility service, so callers can drive the "去开启" guidance instead of guessing.
 */
@CapacitorPlugin(name = "PiPhoneControl")
public final class PiPhoneControlPlugin extends Plugin {

    private static final String DISABLED_MESSAGE = "手机操控未开启：请先在系统设置里启用 pi 的无障碍服务。";

    private PiAccessibilityService service(PluginCall call) {
        PiAccessibilityService service = PiAccessibilityService.instance();
        if (service == null) call.reject(DISABLED_MESSAGE, "SERVICE_DISABLED");
        return service;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject data = new JSObject();
        data.put("enabled", PiAccessibilityService.instance() != null);
        data.put("canScreenshot", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
        call.resolve(data);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException failure) {
            // 少数 ROM 没有这个入口，退到应用详情页，至少让用户能摸到权限。
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                fallback.setData(Uri.fromParts("package", getContext().getPackageName(), null));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (RuntimeException second) {
                call.reject("无法打开系统设置：" + second.getMessage());
            }
        }
    }

    @PluginMethod
    public void dump(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        try {
            call.resolve(service.dump(call.getInt("maxDepth", 14), call.getInt("maxNodes", 400)));
        } catch (RuntimeException failure) {
            call.reject("读取界面失败：" + failure.getMessage());
        }
    }

    @PluginMethod
    public void tap(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        if (x == null || y == null) {
            call.reject("缺少坐标 x/y。", "INVALID_ARGS");
            return;
        }
        call.resolve(gestureResult(service.tap(x.floatValue(), y.floatValue())));
    }

    @PluginMethod
    public void longPress(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        if (x == null || y == null) {
            call.reject("缺少坐标 x/y。", "INVALID_ARGS");
            return;
        }
        call.resolve(gestureResult(service.longPress(x.floatValue(), y.floatValue(), call.getInt("durationMs", 800))));
    }

    @PluginMethod
    public void swipe(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        Double x1 = call.getDouble("x1");
        Double y1 = call.getDouble("y1");
        Double x2 = call.getDouble("x2");
        Double y2 = call.getDouble("y2");
        if (x1 == null || y1 == null || x2 == null || y2 == null) {
            call.reject("缺少坐标 x1/y1/x2/y2。", "INVALID_ARGS");
            return;
        }
        call.resolve(
            gestureResult(
                service.swipe(x1.floatValue(), y1.floatValue(), x2.floatValue(), y2.floatValue(), call.getInt("durationMs", 300))
            )
        );
    }

    @PluginMethod
    public void setText(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        String text = call.getString("text");
        if (text == null) {
            call.reject("缺少 text。", "INVALID_ARGS");
            return;
        }
        String error = service.setText(text);
        if (error != null) {
            call.reject(error, "INPUT_REJECTED");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void key(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        String name = call.getString("name");
        if (name == null || !service.globalAction(name)) {
            call.reject("不支持的系统动作：" + name, "INVALID_ARGS");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void launchApp(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        String packageName = call.getString("packageName");
        if (packageName == null || packageName.trim().isEmpty()) {
            call.reject("缺少 packageName。", "INVALID_ARGS");
            return;
        }
        if (!service.launchApp(packageName.trim())) {
            call.reject("这台手机上找不到可以启动的 " + packageName + "。", "APP_NOT_FOUND");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void screenshot(PluginCall call) {
        PiAccessibilityService service = service(call);
        if (service == null) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("截图需要 Android 11 及以上版本。", "UNSUPPORTED");
            return;
        }
        int maxWidth = Math.max(0, call.getInt("maxWidth", 720));
        service.screenshot(ContextCompat.getMainExecutor(getContext()), maxWidth, (base64, width, height, error) -> {
            if (error != null) {
                call.reject(error);
                return;
            }
            JSObject data = new JSObject();
            data.put("data", base64);
            data.put("width", width);
            data.put("height", height);
            call.resolve(data);
        });
    }

    /** 手势派发只是"已交给系统"，个别机型会拒绝（比如锁屏/触摸被拦截），所以把 false 明确报出来。 */
    private static JSObject gestureResult(boolean dispatched) {
        JSObject data = new JSObject();
        data.put("dispatched", dispatched);
        return data;
    }
}
