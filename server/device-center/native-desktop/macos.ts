export const macDesktopScript = String.raw`
import Foundation
import CoreGraphics
import AppKit
import Carbon
import ImageIO
import ApplicationServices
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreImage
import VideoToolbox
import Darwin

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
guard #available(macOS 14.0, *) else { fail("Native capture requires macOS 14 or newer.") }
let mode = CommandLine.arguments.last ?? "view"
let readOnly = mode != "control" && mode != "video"
let preview = mode == "preview"
let videoMode = mode == "video" || mode == "video-view"

// Encoder callbacks and the capture loop share a length-prefixed stdout pipe.
let packetLock = NSLock()
func writePacket(_ payload: Data) {
    packetLock.lock(); defer { packetLock.unlock() }
    var length = UInt32(payload.count).bigEndian
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
    FileHandle.standardOutput.write(payload)
}

// H.264 硬编码（VideoToolbox）：供浏览器 WebCodecs 解码，码率仅为 JPEG 的十分之一。
// 输出帧格式：[4 字节大端长度][0x02][标志位: 1=关键帧][Annex-B 数据]
final class VideoEncoder {
    private let session: VTCompressionSession
    private var sps: Data?
    private var pps: Data?
    private var firstKey = true
    init(width: Int, height: Int, fps: Double, bitrate: Int) {
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true] as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &created)
        guard status == noErr, let session = created else { fail("Cannot create H.264 encoder (\(status)).") }
        self.session = session
        let primaries = kCVImageBufferColorPrimaries_ITU_R_709_2
        let transfer = kCVImageBufferTransferFunction_sRGB
        let matrix = kCVImageBufferYCbCrMatrix_ITU_R_709_2
        // The incoming desktop is rendered to sRGB by ScreenCaptureKit. Keep both
        // RGB-to-YUV conversion and the H.264 color description in that same space.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_PixelTransferProperties, value: [
            kVTPixelTransferPropertyKey_DestinationColorPrimaries: primaries,
            kVTPixelTransferPropertyKey_DestinationTransferFunction: transfer,
            kVTPixelTransferPropertyKey_DestinationYCbCrMatrix: matrix
        ] as CFDictionary)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ColorPrimaries, value: primaries)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_TransferFunction, value: transfer)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_YCbCrMatrix, value: matrix)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: Int(fps)))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        setBitrate(bitrate)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }
    func setBitrate(_ bitrate: Int) {
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: [NSNumber(value: bitrate / 4), NSNumber(value: 1)] as CFArray)
    }
    func finish() {
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
    }
    private func parameterSets(_ sample: CMSampleBuffer) {
        guard let format = CMSampleBufferGetFormatDescription(sample) else { return }
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr, count >= 2 else { return }
        var sets: [Data] = []
        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let base = pointer else { continue }
            sets.append(Data(bytes: base, count: size))
        }
        if sets.count >= 2 { sps = sets[0]; pps = sets[1] }
    }
    /// AVCC（长度前缀）转 Annex-B，关键帧前插入 SPS/PPS。
    private func annexB(_ sample: CMSampleBuffer) -> (Data, Bool)? {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr, let base = pointer else { return nil }
        var out = Data()
        if keyframe { parameterSets(sample) }
        if keyframe, let s = sps, let p = pps {
            out.append(contentsOf: [0, 0, 0, 1]); out.append(s)
            out.append(contentsOf: [0, 0, 0, 1]); out.append(p)
        }
        var offset = 0
        while offset + 4 <= length {
            var size: UInt32 = 0
            memcpy(&size, base + offset, 4)
            let n = Int(UInt32(bigEndian: size))
            offset += 4
            guard n > 0, offset + n <= length else { break }
            out.append(contentsOf: [0, 0, 0, 1])
            out.append(Data(bytes: base + offset, count: n))
            offset += n
        }
        return out.isEmpty ? nil : (out, keyframe)
    }
    func encode(_ pixels: CVPixelBuffer, forceKey: Bool = false) {
        var flags = VTEncodeInfoFlags()
        let properties = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixels, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), duration: .invalid, frameProperties: properties, infoFlagsOut: &flags) { [weak self] status, _, sample in
            guard status == noErr, let self, let sample, let (data, key) = self.annexB(sample) else { return }
            var payload = Data([0x02, key ? (self.firstKey ? 3 : 1) : 0])
            if key { self.firstKey = false }
            payload.append(data)
            writePacket(payload)
        }
    }
}

// 无屏幕权限也能验证编码器：合成帧走完整 VT → Annex-B 通路。
if mode == "video-selftest" {
    let width = 640, height = 360
    let encoder = VideoEncoder(width: width, height: height, fps: 30, bitrate: 1_500_000)
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
    guard let pixels = buffer else { fail("Cannot allocate test buffer.") }
    for frame in 0..<30 {
        CVPixelBufferLockBaseAddress(pixels, [])
        if let base = CVPixelBufferGetBaseAddress(pixels) {
            let stride = CVPixelBufferGetBytesPerRow(pixels)
            for y in 0..<height {
                let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
                for x in 0..<width {
                    let p = row + x * 4
                    p[0] = UInt8((x + frame * 4) % 256); p[1] = UInt8(y % 256); p[2] = UInt8((x + y) % 256); p[3] = 255
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(pixels, [])
        encoder.encode(pixels, forceKey: frame == 15)
        usleep(33_000)
    }
    sleep(1)
    exit(0)
}
var maxEdge = preview ? 640.0 : 1920.0
var jpegQuality = 0.65
var captureFPS = 30.0
var cursorRevision = 0
var requestedCursor: String? // Old viewers and preview retain the original embedded cursor.
var requestedDisplay: CGDirectDisplayID = 0
var activeDisplay: CGDirectDisplayID = CGMainDisplayID()
func displayIds() -> [CGDirectDisplayID] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32), count: UInt32 = 0
    guard CGGetActiveDisplayList(32, &ids, &count) == .success else { return [CGMainDisplayID()] }
    return Array(ids.prefix(Int(count)))
}
func pixelSize(_ id: CGDirectDisplayID) -> (width: Int, height: Int) {
    if let mode = CGDisplayCopyDisplayMode(id) { return (mode.pixelWidth, mode.pixelHeight) }
    return (CGDisplayPixelsWide(id), CGDisplayPixelsHigh(id))
}
func displayRefresh(_ id: CGDirectDisplayID) -> Double? {
    if let hz = CGDisplayCopyDisplayMode(id)?.refreshRate, hz >= 5 && hz <= 1000 { return (hz * 100).rounded() / 100 }
    // Variable-refresh modes can report zero. AppKit supplies the supported ceiling.
    let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }
    guard let hz = screen?.maximumFramesPerSecond, (5...1000).contains(hz) else { return nil }
    return Double(hz)
}
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
    "Home":115,"PageUp":116,"Delete":117,"End":119,"PageDown":121,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,
    "Numpad0":CGKeyCode(kVK_ANSI_Keypad0),"Numpad1":CGKeyCode(kVK_ANSI_Keypad1),"Numpad2":CGKeyCode(kVK_ANSI_Keypad2),
    "Numpad3":CGKeyCode(kVK_ANSI_Keypad3),"Numpad4":CGKeyCode(kVK_ANSI_Keypad4),"Numpad5":CGKeyCode(kVK_ANSI_Keypad5),
    "Numpad6":CGKeyCode(kVK_ANSI_Keypad6),"Numpad7":CGKeyCode(kVK_ANSI_Keypad7),"Numpad8":CGKeyCode(kVK_ANSI_Keypad8),"Numpad9":CGKeyCode(kVK_ANSI_Keypad9),
    "NumpadDecimal":CGKeyCode(kVK_ANSI_KeypadDecimal),"NumpadMultiply":CGKeyCode(kVK_ANSI_KeypadMultiply),"NumpadAdd":CGKeyCode(kVK_ANSI_KeypadPlus),
    "NumpadDivide":CGKeyCode(kVK_ANSI_KeypadDivide),"NumpadEnter":CGKeyCode(kVK_ANSI_KeypadEnter),"NumpadSubtract":CGKeyCode(kVK_ANSI_KeypadMinus),
    "NumpadEqual":CGKeyCode(kVK_ANSI_KeypadEquals),"NumpadComma":CGKeyCode(kVK_JIS_KeypadComma),"NumLock":CGKeyCode(kVK_ANSI_KeypadClear),"NumpadClear":CGKeyCode(kVK_ANSI_KeypadClear)
]
let modifiers: [CGKeyCode: CGEventFlags] = [54:.maskCommand,55:.maskCommand,56:.maskShift,60:.maskShift,58:.maskAlternate,61:.maskAlternate,59:.maskControl,62:.maskControl]
let keypadCodes = Set(keyMap.filter { $0.key.hasPrefix("Numpad") || $0.key == "NumLock" }.map { $0.value })
func flags() -> CGEventFlags {
    var f = CGEventFlags()
    for k in keys { if let bit = modifiers[k] { f.formUnion(bit) } }
    return f
}
func key(_ code: CGKeyCode, _ down: Bool) {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    event?.flags = flags()
    if keypadCodes.contains(code) { event?.flags.insert(.maskNumericPad) }
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
let frames = DesktopFrames()
// stdin EOF is also a disconnect: release even if no explicit close was delivered.
DispatchQueue.global().async {
    defer { release(); exit(0) }
    while let line = readLine() {
        if line.utf8.count > 32768 { fail("Input exceeds limit.") }
        guard let data = line.data(using: .utf8), let e = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = e["type"] as? String else { continue }
        if type == "close" { return }
        if type == "ack" { acknowledged.signal(); continue }
        if videoMode && type == "video_flow", let paused = e["paused"] as? Bool { frames.setPaused(paused); continue }
        if videoMode && type == "video_keyframe" { frames.requestKeyframe(); continue }
        if type == "cursor_mode" && !preview, let mode = e["mode"] as? String, mode == "local" || mode == "remote" {
            lock.lock(); requestedCursor = mode; cursorRevision += 1; lock.unlock()
            continue
        }
        if type == "display" {
            if let id = e["id"] as? String, let display = UInt32(id) { lock.lock(); requestedDisplay = display; lock.unlock() }
            continue
        }
        if type == "configure" && !preview {
            if let edge = e["maxEdge"] as? Int, let quality = e["quality"] as? Int, let fps = e["fps"] as? Int, (640...4096).contains(edge), (35...85).contains(quality), (5...240).contains(fps) {
                lock.lock(); maxEdge = Double(edge); jpegQuality = Double(quality) / 100; captureFPS = Double(fps); lock.unlock()
            }
            continue
        }
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
                let bounds = CGDisplayBounds(activeDisplay)
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
// Keep a bounded, continuous ScreenCaptureKit stream instead of starting a screenshot for every frame.
final class DesktopFrames: NSObject, SCStreamOutput, SCStreamDelegate {
    let condition = NSCondition()
    var latest: CVPixelBuffer?
    var failure: String?
    private var lastVideo: CVPixelBuffer?
    private var paused = false, forceKey = false
    private var remaining = 0, nextDetail = 0.0
    func setPaused(_ value: Bool) {
        condition.lock(); defer { condition.unlock() }
        if !value && paused { nextDetail = max(nextDetail, ProcessInfo.processInfo.systemUptime + 0.2) }
        paused = value
        condition.signal()
    }
    func requestKeyframe() {
        condition.lock(); defer { condition.unlock() }
        forceKey = true; condition.signal()
    }
    func clearSource() {
        condition.lock(); defer { condition.unlock() }
        latest = nil; lastVideo = nil; remaining = 0; forceKey = true; condition.signal()
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        condition.lock(); failure = String(describing: error); condition.broadcast(); condition.unlock()
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int else { return }
        if status == SCFrameStatus.blank.rawValue || status == SCFrameStatus.suspended.rawValue || status == SCFrameStatus.stopped.rawValue { clearSource(); return }
        guard status == SCFrameStatus.complete.rawValue, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        condition.lock(); latest = pixels; if !paused { condition.signal() }; condition.unlock()
    }
    func take() -> CVPixelBuffer? {
        condition.lock(); defer { condition.unlock() }
        if latest == nil && failure == nil { _ = condition.wait(until: Date(timeIntervalSinceNow: 1)) }
        if let message = failure { fail("ScreenCaptureKit stream stopped: " + message) }
        let pixels = latest; latest = nil; return pixels
    }
    func takeVideo(quality: Double, fps: Double) -> (CVPixelBuffer, Bool)? {
        condition.lock(); defer { condition.unlock() }
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while true {
            if let message = failure { fail("ScreenCaptureKit stream stopped: " + message) }
            let now = ProcessInfo.processInfo.systemUptime
            if !paused {
                if let pixels = latest {
                    latest = nil; lastVideo = pixels
                    remaining = quality >= 0.65 ? 8 : 0; nextDetail = now + 0.2
                    let key = forceKey; forceKey = false
                    return (pixels, key)
                }
                if let pixels = lastVideo, forceKey { forceKey = false; return (pixels, true) }
                if let pixels = lastVideo, remaining > 0 && quality >= 0.65 && now >= nextDetail {
                    remaining -= 1; nextDetail = now + max(0.125, 1 / fps)
                    return (pixels, false)
                }
            }
            if now >= deadline { return nil }
            let wake = !paused && remaining > 0 && quality >= 0.65 ? min(deadline, nextDetail) : deadline
            _ = condition.wait(until: Date(timeIntervalSinceNow: max(0, wake - now)))
        }
    }
}
let captureQueue = DispatchQueue(label: "pi.desktop.capture", qos: .userInteractive)
let imageContext = CIContext(options: [.cacheIntermediates: false])
var stream: SCStream?
var currentDisplay: SCDisplay?
var configuredEdge = 0.0, configuredFPS = 0.0
var reportedCursorRevision = 0
var configuredCursor: String?
func configureStream(edge: Double, fps: Double, displayID: CGDirectDisplayID, cursor: String?) {
    let done = DispatchSemaphore(value: 0)
    var failure: String?
    Task {
        do {
            if currentDisplay?.displayID != displayID {
                if let old = stream { try await old.stopCapture(); stream = nil }
                captureQueue.sync { frames.clearSource() }
                currentDisplay = nil
            }
            if stream == nil {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                    failure = "No active main display."; done.signal(); return
                }
                currentDisplay = display
            }
            guard let display = currentDisplay else { done.signal(); return }
            let config = SCStreamConfiguration()
            let pixels = pixelSize(displayID), scale = min(1.0, edge / Double(max(pixels.width, pixels.height)))
            config.width = max(2, Int(Double(pixels.width) * scale) & ~1)
            config.height = max(2, Int(Double(pixels.height) * scale) & ~1)
            config.showsCursor = cursor != "local"
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.colorSpaceName = CGColorSpace.sRGB
            config.queueDepth = 3
            config.minimumFrameInterval = preview ? CMTime(value: 3, timescale: 1) : CMTime(value: 1, timescale: CMTimeScale(fps))
            if let active = stream {
                if cursor != configuredCursor { captureQueue.sync { frames.clearSource() } }
                try await active.updateConfiguration(config)
            }
            else {
                let active = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: frames)
                try active.addStreamOutput(frames, type: .screen, sampleHandlerQueue: captureQueue)
                stream = active
                try await active.startCapture()
            }
        } catch { failure = String(describing: error) }
        done.signal()
    }
    guard done.wait(timeout: .now() + 15) == .success, failure == nil else {
        release(); fail("ScreenCaptureKit stream failed: " + (failure ?? "timeout; check Screen Recording permission."))
    }
    configuredEdge = edge; configuredFPS = fps; configuredCursor = cursor
    lock.lock(); activeDisplay = displayID; lock.unlock()
}
var reportedAt = 0.0, lastFrameAt = 0.0
var cachedPixels: CVPixelBuffer?
var cachedDisplayID: CGDirectDisplayID = 0
var videoEncoder: VideoEncoder?
var encoderWidth = 0, encoderHeight = 0, encoderRate = 0
var encoderFPS = 0.0, lastVideoAlive = 0.0
func videoBitrate(edge: Double, quality: Double, fps: Double) -> Int {
    let baseKbps = max(1500.0, 9000.0 * pow(edge / 1920.0, 2))
    let detail = quality <= 0.7 ? pow(quality / 0.7, 2) : 1 + (quality - 0.7) / 0.25
    let fpsFactor = sqrt(max(15.0, fps) / 60.0)
    return 1000 * Int(min(50000.0, max(600.0, baseKbps * detail * fpsFactor)).rounded())
}
while true {
    lock.lock(); let edge = maxEdge, quality = jpegQuality, fps = captureFPS, requested = requestedDisplay, cursor = requestedCursor, revision = cursorRevision; lock.unlock()
    let ids = displayIds(), chosen = ids.contains(requested) ? requested : CGMainDisplayID()
    if edge != configuredEdge || fps != configuredFPS || currentDisplay?.displayID != chosen || cursor != configuredCursor {
        let cursorChanged = cursor != configuredCursor
        if cursorChanged { cachedPixels = nil }
        configureStream(edge: edge, fps: fps, displayID: chosen, cursor: cursor)
    }
    if reportedCursorRevision != revision, let mode = cursor, let data = try? JSONSerialization.data(withJSONObject: ["type":"cursor", "kind": mode == "remote" ? "embedded" : "local"]) {
        writePacket(data); reportedCursorRevision = revision
    }
    let now = ProcessInfo.processInfo.systemUptime
    if now - reportedAt >= 2 {
        let displays = ids.map { id -> [String: Any] in
            let pixels = pixelSize(id)
            var item: [String: Any] = ["id": String(id), "width": pixels.width, "height": pixels.height, "primary": id == CGMainDisplayID()]
            if let hz = displayRefresh(id) { item["refreshHz"] = hz }
            return item
        }
        let info: [String: Any] = ["type": "displays", "capture": "screencapturekit", "maxEdge": 4096, "selected": String(chosen), "displays": displays]
        if let data = try? JSONSerialization.data(withJSONObject: info) { writePacket(data) }
        reportedAt = now
    }
    if videoMode {
        if let (pixels, forceKey) = frames.takeVideo(quality: quality, fps: fps) {
            let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
            let bitrate = videoBitrate(edge: Double(max(w, h)), quality: quality, fps: fps)
            if videoEncoder == nil || encoderWidth != w || encoderHeight != h || encoderFPS != fps {
                videoEncoder?.finish()
                videoEncoder = VideoEncoder(width: w, height: h, fps: fps, bitrate: bitrate)
                encoderWidth = w; encoderHeight = h; encoderFPS = fps
            } else if bitrate != encoderRate { videoEncoder?.setBitrate(bitrate) }
            encoderRate = bitrate
            videoEncoder?.encode(pixels, forceKey: forceKey)
        } else if now - lastVideoAlive >= 2 {
            writePacket(Data([5]))
            lastVideoAlive = now
        }
        continue
    }
    if cachedDisplayID != chosen { cachedPixels = nil; cachedDisplayID = chosen }
    let fresh = frames.take()
    if let latest = fresh { cachedPixels = latest }
    if fresh == nil && ProcessInfo.processInfo.systemUptime - lastFrameAt < 3 { continue }
    guard let pixels = cachedPixels else { continue }
    autoreleasepool {
        let input = CIImage(cvPixelBuffer: pixels)
        guard let image = imageContext.createCGImage(input, from: input.extent) else { fail("Cannot read captured image.") }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { release(); fail("Cannot create JPEG encoder.") }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), data.length > 0, data.length <= 4194304 else { release(); fail("JPEG exceeds 4 MB or encoding failed.") }
        writePacket(data as Data)
        lastFrameAt = ProcessInfo.processInfo.systemUptime
    }
    if acknowledged.wait(timeout: .now() + 15) == .timedOut { release(); fail("Frame consumer stopped responding.") }
}
`;
