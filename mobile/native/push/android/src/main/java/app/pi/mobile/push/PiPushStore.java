package app.pi.mobile.push;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import java.util.Iterator;
import org.json.JSONException;
import org.json.JSONObject;

final class PiPushStore {
    private PiPushStore() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("pi_push_state", Context.MODE_PRIVATE);
    }

    static boolean optedIn(Context context) {
        SharedPreferences state = prefs(context);
        return state.getBoolean("consent", false) && state.getBoolean("enabled", false);
    }

    static JSObject extras(String json) {
        JSObject result = new JSObject();
        if (json == null || json.isEmpty()) return result;
        try {
            JSONObject source = new JSONObject(json);
            Iterator<String> keys = source.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = source.opt(key);
                if (value != null && value != JSONObject.NULL) result.put(key, String.valueOf(value));
            }
        } catch (JSONException ignored) {
            // Malformed remote extras are discarded, without logging their contents.
        }
        return result;
    }

    static synchronized boolean saveOpened(Context context, String id, JSObject extras) {
        SharedPreferences state = prefs(context);
        if (id.equals(state.getString("lastOpenedId", ""))) return false;
        return state.edit().putString("lastOpenedId", id).putString("pending", extras.toString()).commit();
    }

    static synchronized JSObject consumeOpened(Context context) {
        SharedPreferences state = prefs(context);
        String pending = state.getString("pending", null);
        if (pending == null) return null;
        if (!state.edit().remove("pending").commit()) {
            throw new IllegalStateException("Could not consume the pending notification");
        }
        return new JSObject().put("extras", extras(pending));
    }
}
