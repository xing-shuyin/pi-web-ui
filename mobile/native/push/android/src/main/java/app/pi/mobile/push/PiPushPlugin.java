package app.pi.mobile.push;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import cn.jiguang.api.utils.JCollectionAuth;
import cn.jpush.android.api.JPushInterface;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.lang.ref.WeakReference;
import org.json.JSONObject;

@CapacitorPlugin(name = "PiPush", permissions = {
    @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
})
public final class PiPushPlugin extends Plugin {
    private static WeakReference<PiPushPlugin> instance = new WeakReference<>(null);
    private static boolean initialized;
    private PluginCall pendingEnable;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        getActivity().runOnUiThread(() -> {
            createChannels();
            PiPushReceiver.handleIntent(getContext(), getActivity().getIntent());
            if (PiPushStore.optedIn(getContext()) && "granted".equals(permission())) {
                try {
                    requireAppKey();
                    startSdk();
                } catch (Exception ignored) {
                    // getStatus/enable report configuration errors to JS; never log credentials/payloads.
                }
            }
            String registrationId = PiPushStore.prefs(getContext()).getString("registrationId", "");
            if (!registrationId.isEmpty()) notifyListeners("registration", new JSObject().put("registrationId", registrationId), true);
        });
    }

    private void requireAppKey() throws Exception {
        ApplicationInfo info = getContext().getPackageManager().getApplicationInfo(getContext().getPackageName(), PackageManager.GET_META_DATA);
        String key = info.metaData == null ? null : info.metaData.getString("JPUSH_APPKEY");
        if (key == null || !key.matches("[0-9a-fA-F]{24}")) {
            throw new IllegalStateException("Configure Android manifest placeholder piJpushAppKey with a valid 24-character JPush AppKey");
        }
    }

    private String permission() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return PiPushStore.prefs(getContext()).getBoolean("permissionAsked", false) ? "denied" : "prompt";
        }
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) return "denied";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            NotificationChannel tasks = manager.getNotificationChannel("pi_tasks");
            NotificationChannel attention = manager.getNotificationChannel("pi_attention");
            if (tasks != null && attention != null && tasks.getImportance() == NotificationManager.IMPORTANCE_NONE && attention.getImportance() == NotificationManager.IMPORTANCE_NONE) return "denied";
        }
        return "granted";
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("pi_tasks", "Tasks", NotificationManager.IMPORTANCE_DEFAULT));
        manager.createNotificationChannel(new NotificationChannel("pi_attention", "Needs attention", NotificationManager.IMPORTANCE_HIGH));
    }

    private void startSdk() {
        // Call only after explicit enable or restoring persisted consent + enabled + OS grant.
        JCollectionAuth.setAuth(getContext(), true);
        JPushInterface.setDebugMode(false);
        if (!initialized) {
            JPushInterface.setNotificationCallBackEnable(getContext(), true);
            JPushInterface.init(getContext());
            initialized = true;
        }
        JPushInterface.resumePush(getContext());
        String id = JPushInterface.getRegistrationID(getContext());
        if (id != null && !id.isEmpty()) {
            String previous = PiPushStore.prefs(getContext()).getString("registrationId", "");
            PiPushStore.prefs(getContext()).edit().putString("registrationId", id).apply();
            if (!id.equals(previous)) registrationChanged(id);
        }
    }

    private JSObject status() {
        String permission = permission();
        boolean enabled = PiPushStore.optedIn(getContext()) && "granted".equals(permission);
        if (initialized) enabled = enabled && !JPushInterface.isPushStopped(getContext());
        return new JSObject().put("permission", permission)
            .put("registrationId", PiPushStore.prefs(getContext()).getString("registrationId", ""))
            .put("enabled", enabled);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                requireAppKey();
                if (PiPushStore.optedIn(getContext()) && "granted".equals(permission()) && !initialized) startSdk();
                call.resolve(status());
            } catch (Exception error) {
                call.reject(error.getMessage(), "JPUSH_CONFIGURATION");
            }
        });
    }

    @PluginMethod
    public void enable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                requireAppKey();
                if (pendingEnable != null) {
                    call.reject("A notification permission request is already in progress", "BUSY");
                    return;
                }
                pendingEnable = call;
                createChannels();
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    boolean asked = PiPushStore.prefs(getContext()).getBoolean("permissionAsked", false);
                    if (asked && !getActivity().shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                        pendingEnable = null;
                        call.resolve(status());
                        return;
                    }
                    PiPushStore.prefs(getContext()).edit().putBoolean("permissionAsked", true).commit();
                    requestPermissionForAlias("notifications", call, "notificationPermissionResult");
                } else {
                    finishEnable(call);
                }
            } catch (Exception error) {
                if (pendingEnable == call) pendingEnable = null;
                call.reject(error.getMessage(), "JPUSH_ENABLE");
            }
        });
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pendingEnable == call) finishEnable(call);
        });
    }

    private void finishEnable(PluginCall call) {
        if (pendingEnable != call) return;
        pendingEnable = null;
        if (!"granted".equals(permission())) {
            call.resolve(status());
            return;
        }
        try {
            if (!PiPushStore.prefs(getContext()).edit().putBoolean("consent", true).putBoolean("enabled", true).commit()) {
                throw new IllegalStateException("Could not save notification consent");
            }
            startSdk();
            call.resolve(status());
        } catch (Exception error) {
            PiPushStore.prefs(getContext()).edit().putBoolean("enabled", false).commit();
            call.reject("Could not enable JPush", "JPUSH_ENABLE");
        }
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            PluginCall enabling = pendingEnable;
            pendingEnable = null;
            if (enabling != null) enabling.reject("Notification enable was cancelled", "CANCELLED");
            if (!PiPushStore.prefs(getContext()).edit().putBoolean("enabled", false).commit()) {
                call.reject("Could not save disabled notification state", "STATE_WRITE");
                return;
            }
            try {
                // No init/resume here, including after a process restart.
                if (PiPushStore.prefs(getContext()).getBoolean("consent", false)) JPushInterface.stopPush(getContext());
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not stop JPush", "JPUSH_DISABLE");
            }
        });
    }

    @PluginMethod
    public void getPendingNotification(PluginCall call) {
        try {
            JSObject notification = PiPushStore.consumeOpened(getContext());
            call.resolve(new JSObject().put("notification", notification == null ? JSONObject.NULL : notification));
        } catch (Exception error) {
            call.reject("Could not consume the pending notification", "STATE_WRITE");
        }
    }

    @PluginMethod
    public void openSystemSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Intent settings;
            if (Build.VERSION.SDK_INT >= 26) {
                settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                settings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            }
            try {
                getActivity().startActivity(settings);
                call.resolve();
            } catch (Exception error) {
                try {
                    getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
                    call.resolve();
                } catch (Exception unavailable) {
                    call.reject("System notification settings are unavailable", "SETTINGS_UNAVAILABLE");
                }
            }
        });
    }

    static void registrationChanged(String registrationId) {
        PiPushPlugin plugin = instance.get();
        if (plugin != null) plugin.getActivity().runOnUiThread(() -> plugin.notifyListeners("registration", new JSObject().put("registrationId", registrationId), true));
    }

    static void notificationReceived(JSObject extras) {
        PiPushPlugin plugin = instance.get();
        if (plugin != null) plugin.getActivity().runOnUiThread(() -> plugin.notifyListeners("notificationReceived", new JSObject().put("extras", extras), true));
    }

    static void deliverPending() {
        PiPushPlugin plugin = instance.get();
        if (plugin == null) return;
        plugin.getActivity().runOnUiThread(() -> {
            if (!plugin.hasListeners("notificationOpened")) return;
            try {
                JSObject pending = PiPushStore.consumeOpened(plugin.getContext());
                if (pending != null) plugin.notifyListeners("notificationOpened", pending);
            } catch (IllegalStateException ignored) {
                // Leave the persisted value intact; explicit JS consumption can report the write failure.
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        PiPushReceiver.handleIntent(getContext(), intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance.get() == this) instance.clear();
        if (pendingEnable != null) pendingEnable.reject("Activity was destroyed", "CANCELLED");
        pendingEnable = null;
    }
}
