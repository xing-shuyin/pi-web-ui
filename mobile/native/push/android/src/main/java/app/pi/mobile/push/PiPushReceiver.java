package app.pi.mobile.push;

import android.content.Context;
import android.content.Intent;
import cn.jpush.android.api.JPushInterface;
import cn.jpush.android.api.NotificationMessage;
import cn.jpush.android.service.JPushMessageReceiver;
import com.getcapacitor.JSObject;
import java.util.UUID;

public final class PiPushReceiver extends JPushMessageReceiver {
    static final String OPENED_INTENT = "app.pi.mobile.push.OPENED";
    private static final String OPENED_ID = "app.pi.mobile.push.OPENED_ID";
    private static final String OPENED_EXTRAS = "app.pi.mobile.push.OPENED_EXTRAS";

    @Override
    public void onRegister(Context context, String registrationId) {
        if (registrationId == null || registrationId.isEmpty()) return;
        String previous = PiPushStore.prefs(context).getString("registrationId", "");
        PiPushStore.prefs(context).edit().putString("registrationId", registrationId).commit();
        if (!registrationId.equals(previous)) PiPushPlugin.registrationChanged(registrationId);
    }

    @Override
    public void onNotifyMessageArrived(Context context, NotificationMessage message) {
        if (message != null && PiPushStore.optedIn(context)) {
            PiPushPlugin.notificationReceived(PiPushStore.extras(message.notificationExtras));
        }
    }

    @Override
    public void onNotifyMessageOpened(Context context, NotificationMessage message) {
        if (message == null) return;
        String id = message.msgId == null || message.msgId.isEmpty() ? UUID.randomUUID().toString() : message.msgId;
        JSObject extras = PiPushStore.extras(message.notificationExtras);
        PiPushStore.saveOpened(context, id, extras);
        PiPushPlugin.deliverPending();
        // Save synchronously before launching: JS may not exist yet, or the process may die.
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.putExtra(OPENED_INTENT, true);
            launch.putExtra(OPENED_ID, id);
            launch.putExtra(OPENED_EXTRAS, extras.toString());
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(launch);
        }
    }

    @Override
    public boolean isNeedShowNotification(Context context, NotificationMessage message, String foreground) {
        // Disabling is persisted before stopPush, so callbacks racing shutdown cannot show a new notification.
        return PiPushStore.optedIn(context) && super.isNeedShowNotification(context, message, foreground);
    }

    static void handleIntent(Context context, Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra(OPENED_INTENT, false)) {
            String id = intent.getStringExtra(OPENED_ID);
            if (id != null) PiPushStore.saveOpened(context, id, PiPushStore.extras(intent.getStringExtra(OPENED_EXTRAS)));
            intent.removeExtra(OPENED_INTENT);
            intent.removeExtra(OPENED_ID);
            intent.removeExtra(OPENED_EXTRAS);
            PiPushPlugin.deliverPending();
            return;
        }
        if (!JPushInterface.ACTION_NOTIFICATION_OPENED.equals(intent.getAction())) return;
        String id = intent.getStringExtra(JPushInterface.EXTRA_MSG_ID);
        if (id == null || id.isEmpty()) id = UUID.randomUUID().toString();
        PiPushStore.saveOpened(context, id, PiPushStore.extras(intent.getStringExtra(JPushInterface.EXTRA_EXTRA)));
        intent.setAction(Intent.ACTION_MAIN);
        PiPushPlugin.deliverPending();
    }
}
