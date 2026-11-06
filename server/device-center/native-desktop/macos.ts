export const macDesktopScript = String.raw`
import Foundation
import CoreGraphics
import ImageIO
import ApplicationServices
import ScreenCaptureKit
import Darwin

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
guard #available(macOS 14.0, *) else { fail("Native capture requires macOS 14 or newer.") }
let mode = CommandLine.arguments.last ?? "view"
let readOnly = mode != "control"
// Only an explicit local permission action may trigger TCC or open Settings.
// Use the same Swift process identity as capture and input injection.
func openPrivacy(_ pane: String) {
    let settings = Process()
    settings.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    settings.arguments = ["x-apple.systempreferences:com.apple.preference.security?" + pane]
    settings.standardOutput = FileHandle.nullDevice
    settings.standardError = FileHandle.nullDevice
    try? settings.run()
}
if mode == "permissions-screen" || mode == "permissions-control" {
    if !CGPreflightScreenCaptureAccess() {
        _ = CGRequestScreenCaptureAccess()
        if !CGPreflightScreenCaptureAccess() { openPrivacy("Privacy_ScreenCapture") }
    }
    // Request both permissions for control even if Screen Recording was denied.
    if mode == "permissions-control" && !AXIsProcessTrusted() {
        let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(prompt)
        if !AXIsProcessTrusted() { openPrivacy("Privacy_Accessibility") }
    }
    let result: [String: Bool] = ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    guard let data = try? JSONSerialization.data(withJSONObject: result) else { fail("Cannot serialize permission status.") }
    FileHandle.standardOutput.write(data)
    exit(0)
}
if !CGPreflightScreenCaptureAccess() {
    fail("MAC_SCREEN_PERMISSION_REQUIRED: On this Mac, open the local Device Center and request Screen Recording permission for the app macOS identifies. Restart the actual server after granting access, then reconnect.")
}
if !readOnly && !AXIsProcessTrusted() {
    fail("MAC_ACCESSIBILITY_PERMISSION_REQUIRED: On this Mac, open the local Device Center and request Accessibility permission for the app macOS identifies. Restart the actual server after granting access, then reconnect.")
}
let lock = NSLock()
let acknowledged = DispatchSemaphore(value: 0)
var stopped = false
var keys = Set<CGKeyCode>()
var buttons = Set<Int>()
var lastPoint = CGPoint.zero
let keyMap: [String: CGKeyCode] = [
    "KeyA":0,"KeyS":1,"KeyD":2,"KeyF":3,"KeyH":4,"KeyG":5,"KeyZ":6,"KeyX":7,"KeyC":8,"KeyV":9,"KeyB":11,
    "KeyQ":12,"KeyW":13,"KeyE":14,"KeyR":15,"KeyY":16,"KeyT":17,"Digit1":18,"Digit2":19,"Digit3":20,"Digit4":21,
    "Digit6":22,"Digit5":23,"Equal":24,"Digit9":25,"Digit7":26,"Minus":27,"Digit8":28,"Digit0":29,"BracketRight":30,
    "KeyO":31,"KeyU":32,"BracketLeft":33,"KeyI":34,"KeyP":35,"Enter":36,"KeyL":37,"KeyJ":38,"Quote":39,"KeyK":40,
    "Semicolon":41,"Backslash":42,"Comma":43,"Slash":44,"KeyN":45,"KeyM":46,"Period":47,"Tab":48,"Space":49,
    "Backquote":50,"Backspace":51,"Escape":53,"MetaRight":54,"MetaLeft":55,"ShiftLeft":56,"CapsLock":57,
    "AltLeft":58,"ControlLeft":59,"ShiftRight":60,"AltRight":61,"ControlRight":62,"F1":122,"F2":120,"F3":99,
    "F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,"Insert":114,
    "Home":115,"PageUp":116,"Delete":117,"End":119,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126
]
let modifiers: [CGKeyCode: CGEventFlags] = [54:.maskCommand,55:.maskCommand,56:.maskShift,60:.maskShift,58:.maskAlternate,61:.maskAlternate,59:.maskControl,62:.maskControl]
func flags() -> CGEventFlags {
    var f = CGEventFlags()
    for k in keys { if let bit = modifiers[k] { f.formUnion(bit) } }
    return f
}
func key(_ code: CGKeyCode, _ down: Bool) {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    event?.flags = flags()
    event?.post(tap: .cghidEventTap)
}
func mouse(_ button: Int, _ down: Bool) {
    let kind: CGEventType = button == 0 ? (down ? .leftMouseDown : .leftMouseUp) : button == 2 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
    let event = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: lastPoint, mouseButton: button == 0 ? .left : button == 2 ? .right : .center)
    event?.flags = flags()
    event?.post(tap: .cghidEventTap)
}
func release() {
    lock.lock(); defer { lock.unlock() }
    stopped = true
    let held = keys; keys.removeAll()
    for k in held { key(k, false) }
    for b in buttons { mouse(b, false) }
    buttons.removeAll()
    acknowledged.signal()
}
// stdin EOF is also a disconnect: release even if no explicit close was delivered.
DispatchQueue.global().async {
    defer { release(); exit(0) }
    while let line = readLine() {
        if line.utf8.count > 32768 { fail("Input exceeds limit.") }
        guard let data = line.data(using: .utf8), let e = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = e["type"] as? String else { continue }
        if type == "close" { return }
        if type == "ack" { acknowledged.signal(); continue }
        if readOnly { continue }
        lock.lock()
        if stopped { lock.unlock(); return }
        switch type {
        case "release":
            let held = keys; keys.removeAll()
            for k in held { key(k, false) }
            for b in buttons { mouse(b, false) }
            buttons.removeAll()
        case "pointer":
            if let x = e["x"] as? Double, let y = e["y"] as? Double, let action = e["action"] as? String {
                let bounds = CGDisplayBounds(CGMainDisplayID())
                lastPoint = CGPoint(x: bounds.minX + x * max(0, bounds.width - 1), y: bounds.minY + y * max(0, bounds.height - 1))
                let b = e["button"] as? Int ?? 0
                if action == "move" {
                    let drag = buttons.contains(0) ? CGEventType.leftMouseDragged : buttons.contains(2) ? .rightMouseDragged : buttons.contains(1) ? .otherMouseDragged : .mouseMoved
                    let event = CGEvent(mouseEventSource: nil, mouseType: drag, mouseCursorPosition: lastPoint, mouseButton: buttons.contains(2) ? .right : buttons.contains(1) ? .center : .left)
                    event?.flags = flags(); event?.post(tap: .cghidEventTap)
                } else {
                    if action == "down" { buttons.insert(b) } else { buttons.remove(b) }
                    mouse(b, action == "down")
                }
            }
        case "key":
            if let code = e["code"] as? String, let k = keyMap[code], let action = e["action"] as? String {
                if action == "down" { keys.insert(k) } else { keys.remove(k) }
                key(k, action == "down")
            }
        case "wheel":
            if let dy = e["deltaY"] as? Double { CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap) }
        case "text":
            if let text = e["text"] as? String {
                let units = Array(text.utf16)
                units.withUnsafeBufferPointer { buffer in
                    for down in [true, false] {
                        let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                        event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
                        event?.post(tap: .cghidEventTap)
                    }
                }
            }
        default: break
        }
        lock.unlock()
    }
}
// ScreenCaptureKit is also used by krd. SCScreenshotManager avoids deprecated
// CGDisplayCreateImage on current macOS SDKs and never opens a network port.
@available(macOS 14.0, *)
func captureImage() -> CGImage {
    let ready = DispatchSemaphore(value: 0)
    var result: CGImage?
    var failure: String?
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                failure = "No active main display."; ready.signal(); return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            let scale = min(1.0, 1920.0 / Double(max(display.width, display.height)))
            config.width = max(1, Int(Double(display.width) * scale))
            config.height = max(1, Int(Double(display.height) * scale))
            config.showsCursor = true
            result = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch { failure = String(describing: error) }
        ready.signal()
    }
    guard ready.wait(timeout: .now() + 15) == .success, let image = result else {
        release(); fail("ScreenCaptureKit capture failed: " + (failure ?? "timeout; check Screen Recording permission and active desktop."))
    }
    return image
}
while true {
    autoreleasepool {
        let image = captureImage()
        let scale = min(1.0, 1920.0 / Double(max(image.width, image.height)))
        let width = max(1, Int(Double(image.width) * scale)), height = max(1, Int(Double(image.height) * scale))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { release(); fail("Cannot allocate capture buffer.") }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let data = NSMutableData()
        guard let scaled = context.makeImage(), let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { release(); fail("Cannot create JPEG encoder.") }
        CGImageDestinationAddImage(destination, scaled, [kCGImageDestinationLossyCompressionQuality: 0.65] as CFDictionary)
        guard CGImageDestinationFinalize(destination), data.length > 0, data.length <= 4194304 else { release(); fail("JPEG exceeds 4 MB or encoding failed.") }
        var size = UInt32(data.length).bigEndian
        FileHandle.standardOutput.write(Data(bytes: &size, count: 4))
        FileHandle.standardOutput.write(data as Data)
    }
    if acknowledged.wait(timeout: .now() + 15) == .timedOut { release(); fail("Frame consumer stopped responding.") }
    Thread.sleep(forTimeInterval: 0.1)
}
`;
