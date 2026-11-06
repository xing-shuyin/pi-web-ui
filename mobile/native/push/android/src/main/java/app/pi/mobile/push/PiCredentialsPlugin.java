package app.pi.mobile.push;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "PiCredentials")
public final class PiCredentialsPlugin extends Plugin {
    private static final Object LOCK = new Object();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("pi_credentials_encrypted", Context.MODE_PRIVATE);
    }

    private SecretKey key(boolean create) throws Exception {
        String alias = getContext().getPackageName() + ".pi.credentials.v1";
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new IllegalStateException("The credential encryption key is unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }

    private byte[] aad() {
        return (getContext().getPackageName() + ":PiCredentials:v1").getBytes(StandardCharsets.UTF_8);
    }

    @PluginMethod
    public void get(PluginCall call) {
        synchronized (LOCK) {
            String encoded = prefs().getString("sealed", null);
            if (encoded == null) {
                call.resolve(new JSObject().put("credentials", JSONObject.NULL));
                return;
            }
            try {
                byte[] sealed = Base64.decode(encoded, Base64.NO_WRAP);
                if (sealed.length < 30 || sealed[0] != 1 || sealed[1] != 12) throw new IllegalStateException("Invalid encrypted credentials");
                ByteBuffer buffer = ByteBuffer.wrap(sealed);
                buffer.position(2);
                byte[] iv = new byte[12];
                buffer.get(iv);
                byte[] ciphertext = new byte[buffer.remaining()];
                buffer.get(ciphertext);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
                cipher.updateAAD(aad());
                JSONObject stored = new JSONObject(new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
                JSObject credentials = new JSObject().put("serverUrl", stored.getString("serverUrl")).put("token", stored.getString("token")).put("mode", stored.optString("mode", "hub"));
                call.resolve(new JSObject().put("credentials", credentials));
            } catch (Exception error) {
                // Never attach the exception: it may contain decoded credential data.
                call.reject("Could not decrypt saved connection credentials; clear them and reconnect", "CREDENTIALS_READ");
            }
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String serverUrl = call.getString("serverUrl");
        String token = call.getString("token");
        String mode = call.getString("mode", "hub");
        if (!"hub".equals(mode) && !"direct".equals(mode)) {
            call.reject("Unknown connection mode", "INVALID_ARGUMENT");
            return;
        }
        if (serverUrl == null || serverUrl.trim().isEmpty() || token == null || token.isEmpty()) {
            call.reject("serverUrl and token are required", "INVALID_ARGUMENT");
            return;
        }
        synchronized (LOCK) {
            try {
                byte[] plaintext = new JSONObject().put("serverUrl", serverUrl).put("token", token).put("mode", mode).toString().getBytes(StandardCharsets.UTF_8);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key(true));
                cipher.updateAAD(aad());
                byte[] iv = cipher.getIV();
                if (iv.length != 12) throw new IllegalStateException("Unexpected GCM IV length");
                byte[] ciphertext = cipher.doFinal(plaintext);
                byte[] sealed = ByteBuffer.allocate(2 + iv.length + ciphertext.length).put((byte) 1).put((byte) iv.length).put(iv).put(ciphertext).array();
                if (!prefs().edit().putString("sealed", Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) throw new IllegalStateException("Could not write credentials");
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not securely save connection credentials", "CREDENTIALS_WRITE");
            }
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        synchronized (LOCK) {
            if (!prefs().edit().clear().commit()) {
                call.reject("Could not clear connection credentials", "CREDENTIALS_WRITE");
                return;
            }
            call.resolve();
        }
    }
}
