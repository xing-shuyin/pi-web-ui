import Capacitor
import Foundation
import UIKit
import UserNotifications

@objc(PiPushPlugin)
public final class PiPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PiPushPlugin"
    public let jsName = "PiPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSystemSettings", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        DispatchQueue.main.async {
            PiPushAppDelegate.shared.attach(self)
        }
    }

    @objc public func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { PiPushAppDelegate.shared.getStatus(call) }
    }

    @objc public func enable(_ call: CAPPluginCall) {
        DispatchQueue.main.async { PiPushAppDelegate.shared.enable(call) }
    }

    @objc public func disable(_ call: CAPPluginCall) {
        DispatchQueue.main.async { PiPushAppDelegate.shared.disable(call) }
    }

    @objc public func getPendingNotification(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let notification = PiPushAppDelegate.shared.consumeOpened().map { $0 as Any } ?? NSNull()
            call.resolve(["notification": notification])
        }
    }

    @objc public func openSystemSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("System application settings are unavailable", "SETTINGS_UNAVAILABLE")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() }
                else { call.reject("System application settings could not be opened", "SETTINGS_UNAVAILABLE") }
            }
        }
    }

    func emitRegistration(_ registrationId: String) {
        notifyListeners("registration", data: ["registrationId": registrationId], retainUntilConsumed: true)
    }

    func emitReceived(_ extras: [String: String]) {
        notifyListeners("notificationReceived", data: ["extras": extras], retainUntilConsumed: true)
    }

    func deliverOpenedIfListening() {
        guard hasListeners("notificationOpened"), let notification = PiPushAppDelegate.shared.consumeOpened() else { return }
        notifyListeners("notificationOpened", data: notification)
    }
}
