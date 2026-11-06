import Capacitor
import Foundation
import Security

@objc(PiCredentialsPlugin)
public final class PiCredentialsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PiCredentialsPlugin"
    public let jsName = "PiCredentials"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "app.pi.mobile.credentials")

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "app.pi.mobile") + ".PiCredentials",
            kSecAttrAccount as String: "connection-v1",
            kSecAttrSynchronizable as String: false
        ]
    }

    @objc public func get(_ call: CAPPluginCall) {
        queue.async {
            var query = self.query
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status == errSecItemNotFound {
                call.resolve(["credentials": NSNull()])
                return
            }
            guard status == errSecSuccess, let data = item as? Data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                  let serverUrl = object["serverUrl"], let token = object["token"] else {
                call.reject("Could not read connection credentials from Keychain", "CREDENTIALS_READ")
                return
            }
            call.resolve(["credentials": ["serverUrl": serverUrl, "token": token, "mode": object["mode"] ?? "hub"]])
        }
    }

    @objc public func set(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? "hub"
        guard mode == "hub" || mode == "direct" else {
            call.reject("Unknown connection mode", "INVALID_ARGUMENT")
            return
        }
        guard let serverUrl = call.getString("serverUrl"), !serverUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let token = call.getString("token"), !token.isEmpty else {
            call.reject("serverUrl and token are required", "INVALID_ARGUMENT")
            return
        }
        queue.async {
            guard let data = try? JSONSerialization.data(withJSONObject: ["serverUrl": serverUrl, "token": token, "mode": mode]) else {
                call.reject("Could not encode connection credentials", "CREDENTIALS_WRITE")
                return
            }
            let attributes: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            ]
            var status = SecItemUpdate(self.query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                var item = self.query
                attributes.forEach { item[$0.key] = $0.value }
                status = SecItemAdd(item as CFDictionary, nil)
            }
            guard status == errSecSuccess else {
                call.reject("Could not securely save connection credentials to Keychain", "CREDENTIALS_WRITE")
                return
            }
            call.resolve()
        }
    }

    @objc public func clear(_ call: CAPPluginCall) {
        queue.async {
            let status = SecItemDelete(self.query as CFDictionary)
            if status == errSecSuccess || status == errSecItemNotFound { call.resolve() }
            else { call.reject("Could not clear connection credentials from Keychain", "CREDENTIALS_WRITE") }
        }
    }
}
