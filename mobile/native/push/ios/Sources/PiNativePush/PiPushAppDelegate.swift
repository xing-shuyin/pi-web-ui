import Capacitor
import Foundation
import JCore
import JPush
import UIKit
import UserNotifications

/// Forward the four documented AppDelegate hooks here. No swizzling or SDK setup at launch.
public final class PiPushAppDelegate: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = PiPushAppDelegate()
    private let defaults = UserDefaults.standard
    private weak var plugin: PiPushPlugin?
    private var downstream: UNUserNotificationCenterDelegate?
    private var launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    private var initialized = false
    private var sdkEnabled = false
    private var apnsReady = false
    private var pendingEnable: CAPPluginCall?
    private var enableTimeout: DispatchWorkItem?
    private var disabling = false
    private var revision = 0
    private var loginObserver: NSObjectProtocol?
    private var lastReceivedId: String?

    private var optedIn: Bool {
        defaults.bool(forKey: "pi.push.consent") && defaults.bool(forKey: "pi.push.enabled")
    }

    public func didFinishLaunching(_ options: [UIApplication.LaunchOptionsKey: Any]?) {
        launchOptions = options
        installDelegate()
        if UIApplication.shared.applicationState != .background,
           let remote = options?[.remoteNotification] as? [AnyHashable: Any] {
            saveOpened(remote)
        }
    }

    public func didRegisterForRemoteNotifications(deviceToken: Data) {
        DispatchQueue.main.async {
            guard self.initialized && self.optedIn else { return }
            JPUSHService.registerDeviceToken(deviceToken)
            self.apnsReady = true
            self.refreshRegistration()
            if let call = self.pendingEnable {
                self.finishEnable(call)
            }
        }
    }

    public func didFailToRegisterForRemoteNotifications(error: Error) {
        DispatchQueue.main.async {
            self.apnsReady = false
            self.defaults.set(false, forKey: "pi.push.enabled")
            self.sdkEnabled = false
            if self.initialized { JPUSHService.turnOffPush(nil) }
            self.enableTimeout?.cancel()
            self.enableTimeout = nil
            let call = self.pendingEnable
            self.pendingEnable = nil
            call?.reject("APNs registration failed; check the host Push Notifications entitlement, provisioning profile and network", "APNS_REGISTRATION_FAILED")
        }
    }

    /// The host owns the background-fetch completion handler and must call it exactly once.
    public func didReceiveRemoteNotification(_ userInfo: [AnyHashable: Any]) {
        DispatchQueue.main.async {
            guard self.initialized && self.optedIn else { return }
            JPUSHService.handleRemoteNotification(userInfo)
            self.received(userInfo)
        }
    }

    func attach(_ plugin: PiPushPlugin) {
        self.plugin = plugin
        // Capacitor installs its notification router while constructing the bridge.
        // Retain and forward that delegate, preserving local/push handlers and App plugin behavior.
        installDelegate()
        let id = defaults.string(forKey: "pi.push.registrationId") ?? ""
        if !id.isEmpty { plugin.emitRegistration(id) }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                guard self.optedIn && self.permission(settings) == "granted",
                      let key = try? self.appKey() else { return }
                self.startSdk(key)
            }
        }
    }

    private func installDelegate() {
        let center = UNUserNotificationCenter.current()
        if center.delegate !== self {
            downstream = center.delegate
            center.delegate = self
        }
    }

    private func appKey() throws -> String {
        guard let key = Bundle.main.object(forInfoDictionaryKey: "PiJPushAppKey") as? String,
              key.range(of: "^[0-9a-fA-F]{24}$", options: .regularExpression) != nil else {
            throw NSError(domain: "PiPush", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Configure Info.plist PiJPushAppKey with a valid 24-character JPush AppKey"])
        }
        return key
    }

    private func permission(_ settings: UNNotificationSettings) -> String {
        switch settings.authorizationStatus {
        case .notDetermined: return "prompt"
        case .authorized, .provisional, .ephemeral:
            return settings.alertSetting == .disabled && settings.notificationCenterSetting == .disabled ? "denied" : "granted"
        case .denied: return "denied"
        @unknown default: return "denied"
        }
    }

    private func status(_ settings: UNNotificationSettings) -> [String: Any] {
        let permission = permission(settings)
        return [
            "permission": permission,
            "registrationId": defaults.string(forKey: "pi.push.registrationId") ?? "",
            "enabled": optedIn && permission == "granted" && sdkEnabled
        ]
    }

    func getStatus(_ call: CAPPluginCall) {
        let key: String
        do { key = try appKey() }
        catch { call.reject(error.localizedDescription, "JPUSH_CONFIGURATION"); return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                if self.optedIn && self.permission(settings) == "granted" && !self.initialized {
                    self.startSdk(key)
                }
                call.resolve(self.status(settings))
            }
        }
    }

    func enable(_ call: CAPPluginCall) {
        let key: String
        do { key = try appKey() }
        catch { call.reject(error.localizedDescription, "JPUSH_CONFIGURATION"); return }
        guard pendingEnable == nil && !disabling else {
            call.reject("A notification state change is already in progress", "BUSY")
            return
        }
        pendingEnable = call
        revision += 1
        let requestedRevision = revision
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            DispatchQueue.main.async {
                guard self.revision == requestedRevision && self.pendingEnable === call else { return }
                if settings.authorizationStatus == .notDetermined {
                    center.requestAuthorization(options: [.alert, .badge, .sound]) { _, error in
                        DispatchQueue.main.async {
                            guard self.revision == requestedRevision && self.pendingEnable === call else { return }
                            if error != nil {
                                self.pendingEnable = nil
                                call.reject("Could not request system notification permission", "PERMISSION_REQUEST")
                                return
                            }
                            self.enableIfAuthorized(call, key: key, revision: requestedRevision)
                        }
                    }
                } else {
                    self.enableIfAuthorized(call, key: key, revision: requestedRevision)
                }
            }
        }
    }

    private func enableIfAuthorized(_ call: CAPPluginCall, key: String, revision: Int) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                guard self.revision == revision && self.pendingEnable === call else { return }
                guard self.permission(settings) == "granted" else {
                    self.pendingEnable = nil
                    call.resolve(self.status(settings))
                    return
                }
                self.defaults.set(true, forKey: "pi.push.consent")
                self.defaults.set(true, forKey: "pi.push.enabled")
                self.defaults.synchronize()
                self.startSdk(key)
                if self.apnsReady { self.finishEnable(call) }
                else {
                    let timeout = DispatchWorkItem { [weak self] in
                        guard let self, self.revision == revision, self.pendingEnable === call else { return }
                        self.pendingEnable = nil
                        self.defaults.set(false, forKey: "pi.push.enabled")
                        self.sdkEnabled = false
                        JPUSHService.turnOffPush(nil)
                        UIApplication.shared.unregisterForRemoteNotifications()
                        call.reject("APNs registration timed out; check entitlement, signing and network", "APNS_REGISTRATION_TIMEOUT")
                    }
                    self.enableTimeout = timeout
                    DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
                }
            }
        }
    }

    private func finishEnable(_ call: CAPPluginCall) {
        enableTimeout?.cancel()
        enableTimeout = nil
        pendingEnable = nil
        let completedRevision = revision
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                guard completedRevision == self.revision else {
                    call.reject("Notification enable was cancelled", "CANCELLED")
                    return
                }
                call.resolve(self.status(settings))
            }
        }
    }

    private func startSdk(_ key: String) {
        guard optedIn && !disabling else { return }
        installDelegate()
        if !initialized {
            JGInforCollectionAuth.jCollectionAuth { items in items.isAuth = true }
            JPUSHService.setLogOFF()
            #if DEBUG
            let defaultProduction = false
            #else
            let defaultProduction = true
            #endif
            let production = (Bundle.main.object(forInfoDictionaryKey: "PiJPushAPNsProduction") as? Bool) ?? defaultProduction
            JPUSHService.setup(withOption: launchOptions, appKey: key, channel: "pi_mobile", apsForProduction: production)
            initialized = true
            loginObserver = NotificationCenter.default.addObserver(
                forName: NSNotification.Name(rawValue: kJPFNetworkDidLoginNotification), object: nil, queue: .main
            ) { [weak self] _ in self?.refreshRegistration() }
            JPUSHService.registrationIDCompletionHandler { [weak self] code, id in
                DispatchQueue.main.async {
                    if code == 0, let id { self?.saveRegistration(id) }
                }
            }
        }
        if !sdkEnabled {
            JPUSHService.turnOnPush()
            sdkEnabled = true
        }
        UIApplication.shared.registerForRemoteNotifications()
        refreshRegistration()
    }

    func disable(_ call: CAPPluginCall) {
        guard !disabling else {
            call.reject("A notification state change is already in progress", "BUSY")
            return
        }
        revision += 1
        defaults.set(false, forKey: "pi.push.enabled")
        defaults.synchronize()
        enableTimeout?.cancel()
        enableTimeout = nil
        pendingEnable?.reject("Notification enable was cancelled", "CANCELLED")
        pendingEnable = nil
        sdkEnabled = false
        apnsReady = false
        UIApplication.shared.unregisterForRemoteNotifications()
        // Never initialize to stop. A stopped/never-consented process stays stopped.
        guard defaults.bool(forKey: "pi.push.consent") else { call.resolve(); return }
        disabling = true
        JPUSHService.turnOffPush { code in
            DispatchQueue.main.async {
                self.disabling = false
                if code == 0 { call.resolve() }
                else { call.reject("Could not stop JPush", "JPUSH_DISABLE") }
            }
        }
    }

    private func refreshRegistration() {
        guard initialized else { return }
        saveRegistration(JPUSHService.registrationID())
    }

    private func saveRegistration(_ id: String) {
        guard !id.isEmpty && id != defaults.string(forKey: "pi.push.registrationId") else { return }
        defaults.set(id, forKey: "pi.push.registrationId")
        plugin?.emitRegistration(id)
    }

    private func extras(_ userInfo: [AnyHashable: Any]) -> [String: String] {
        var result: [String: String] = [:]
        for (rawKey, value) in userInfo {
            guard let key = rawKey as? String, key != "aps", !key.hasPrefix("_j_"), key != "actionIdentifier" else { continue }
            if let string = value as? String { result[key] = string }
            else if let number = value as? NSNumber { result[key] = number.stringValue }
            else if JSONSerialization.isValidJSONObject(value),
                    let json = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
                    let string = String(data: json, encoding: .utf8) { result[key] = string }
        }
        return result
    }

    private func messageId(_ userInfo: [AnyHashable: Any]) -> String? {
        if let value = userInfo["_j_msgid"] { return String(describing: value) }
        return nil
    }

    private func received(_ userInfo: [AnyHashable: Any]) {
        // APNs fetch and willPresent can both describe the same foreground notification.
        if let id = messageId(userInfo) {
            if id == lastReceivedId { return }
            lastReceivedId = id
        }
        plugin?.emitReceived(extras(userInfo))
    }

    private func saveOpened(_ userInfo: [AnyHashable: Any]) {
        if let id = messageId(userInfo) {
            if id == defaults.string(forKey: "pi.push.lastOpenedId") { return }
            defaults.set(id, forKey: "pi.push.lastOpenedId")
        }
        defaults.set(extras(userInfo), forKey: "pi.push.pending")
        defaults.synchronize()
        plugin?.deliverOpenedIfListening()
    }

    func consumeOpened() -> [String: Any]? {
        guard let pending = defaults.dictionary(forKey: "pi.push.pending") as? [String: String] else { return nil }
        defaults.removeObject(forKey: "pi.push.pending")
        defaults.synchronize()
        return ["extras": pending]
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       willPresent notification: UNNotification,
                                       withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            let remote = notification.request.trigger is UNPushNotificationTrigger
            var presentation: UNNotificationPresentationOptions = []
            if remote && self.optedIn {
                let info = notification.request.content.userInfo
                if self.initialized { JPUSHService.handleRemoteNotification(info) }
                self.received(info)
                presentation = [.banner, .list, .badge, .sound]
            }
            let ownPresentation = presentation
            if let delegate = self.downstream,
               delegate.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
                delegate.userNotificationCenter?(center, willPresent: notification) { options in
                    completionHandler(options.union(ownPresentation))
                }
            } else {
                completionHandler(ownPresentation)
            }
        }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       didReceive response: UNNotificationResponse,
                                       withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            if response.notification.request.trigger is UNPushNotificationTrigger,
               response.actionIdentifier != UNNotificationDismissActionIdentifier {
                let info = response.notification.request.content.userInfo
                self.saveOpened(info)
                if self.initialized && self.optedIn { JPUSHService.handleRemoteNotification(info) }
            }
            if let delegate = self.downstream,
               delegate.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
                delegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
            } else {
                completionHandler()
            }
        }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
        downstream?.userNotificationCenter?(center, openSettingsFor: notification)
    }
}
