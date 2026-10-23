import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

// Fixed, window-bound protocol. Never inject into the user's global input stream.
struct Failure: Error { let code: String }
struct AppTarget: Codable, Equatable {
  let kind: String, pid: Int32, startedAt: Double, windowId: UInt32, appName: String, title: String
}
struct AppContext: Codable, Equatable {
  let kind: String, target: AppTarget, x: Double, y: Double, width: Double, height: Double
}
let lock = NSLock()
var cancelled = false, effectStarted = false
func fail(_ code: String) -> Failure { Failure(code: code) }
func emit(_ value: [String: Any]) { let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
func object<T: Encodable>(_ value: T) -> Any { try! JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }
func decode<T: Decodable>(_ value: Any?, as type: T.Type) throws -> T {
  guard let value = value, JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value), let result = try? JSONDecoder().decode(type, from: data) else { throw fail("HOST_COMPUTER_TARGET_REQUIRED") }
  return result
}
func context(for target: AppTarget) throws -> AppContext {
  guard target.kind == "app", target.pid > 0, target.windowId > 0, target.startedAt.isFinite else { throw fail("HOST_COMPUTER_TARGET_REQUIRED") }
  guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isTerminated,
    app.launchDate?.timeIntervalSince1970 == target.startedAt,
    let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], target.windowId) as? [[String: Any]],
    let window = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == target.windowId && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid }),
    (window[kCGWindowLayer as String] as? Int) == 0,
    let bounds = window[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
    rect.width > 0, rect.height > 0 else { throw fail("HOST_COMPUTER_TARGET_CHANGED") }
  return AppContext(kind: "app", target: target, x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
}
func validate(_ expected: AppContext) throws {
  guard expected.kind == "app", try context(for: expected.target) == expected else { throw fail("HOST_COMPUTER_TARGET_CHANGED") }
}
func targets() -> [AppTarget] {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return Array(windows.compactMap { window -> AppTarget? in
    guard (window[kCGWindowLayer as String] as? Int) == 0,
      let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
      let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated, let launch = app.launchDate,
      let windowId = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
      let bounds = window[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 1, rect.height > 1 else { return nil }
    return AppTarget(kind: "app", pid: pid, startedAt: launch.timeIntervalSince1970, windowId: windowId,
      appName: String((app.localizedName ?? "Application").prefix(240)), title: String((window[kCGWindowName as String] as? String ?? "").prefix(500)))
  }.prefix(128))
}
func point(_ value: [String: Any], _ context: AppContext) throws -> CGPoint {
  guard let x = value["x"] as? Double, let y = value["y"] as? Double, x.isFinite, y.isFinite,
    x >= 0, y >= 0, x < context.width, y < context.height else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  return CGPoint(x: x + context.x, y: y + context.y)
}
func releaseInput() { lock.lock(); cancelled = true; lock.unlock() }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func settable(_ element: AXUIElement, _ name: String) -> Bool {
  var value: DarwinBoolean = false; return AXUIElementIsAttributeSettable(element, name as CFString, &value) == .success && value.boolValue
}
func axRect(_ element: AXUIElement) -> CGRect? {
  guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
    let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero, dimensions = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
  return CGRect(origin: point, size: dimensions)
}
func targetWindow(_ context: AppContext) throws -> (AXUIElement, AXUIElement) {
  let app = AXUIElementCreateApplication(context.target.pid)
  AXUIElementSetMessagingTimeout(app, 0.5)
  let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
  let matching = windows.filter { window in
    guard let rect = axRect(window), abs(rect.minX - context.x) < 1, abs(rect.minY - context.y) < 1,
      abs(rect.width - context.width) < 1, abs(rect.height - context.height) < 1 else { return false }
    return context.target.title.isEmpty || attribute(window, kAXTitleAttribute) as? String == context.target.title
  }
  guard matching.count == 1 else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  return (app, matching[0])
}
func elementsAtPoint(_ window: AXUIElement, _ point: CGPoint) throws -> [AXUIElement] {
  var pending = [window], matches: [AXUIElement] = [], visited = 0
  let deadline = Date().addingTimeInterval(5)
  while !pending.isEmpty && visited < 4000 && Date() < deadline {
    let element = pending.removeLast(); visited += 1
    if let rect = axRect(element), rect.contains(point) { matches.append(element) }
    let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    guard children.count + pending.count + visited <= 4000 else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
    pending.append(contentsOf: children)
  }
  guard pending.isEmpty else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  return matches
}
func textTarget(_ context: AppContext, _ point: CGPoint) throws -> AXUIElement {
  let (app, window) = try targetWindow(context)
  let fields = try elementsAtPoint(window, point).filter { element in
    guard let role = attribute(element, kAXRoleAttribute) as? String else { return false }
    return [kAXTextFieldRole as String, kAXTextAreaRole as String].contains(role)
      && attribute(element, kAXSubroleAttribute) as? String != "AXSecureTextField" && (attribute(element, kAXEnabledAttribute) as? Bool) == true
  }
  guard fields.count == 1, let focusedWindow = attribute(app, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window),
    let focusedElement = attribute(app, kAXFocusedUIElementAttribute), CFEqual(focusedElement, fields[0]) else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  AXUIElementSetMessagingTimeout(fields[0], 0.5)
  return fields[0]
}
func click(_ command: [String: Any], _ context: AppContext) throws {
  guard command["button"] == nil || command["button"] as? String == "left" else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  let (_, window) = try targetWindow(context)
  let controls = try elementsAtPoint(window, point(command, context)).filter { element in
    guard let role = attribute(element, kAXRoleAttribute) as? String, [kAXButtonRole as String, kAXCheckBoxRole as String, kAXRadioButtonRole as String].contains(role),
      (attribute(element, kAXEnabledAttribute) as? Bool) == true else { return false }
    var actions: CFArray?
    return AXUIElementCopyActionNames(element, &actions) == .success && (actions as? [String] ?? []).contains(kAXPressAction)
  }
  guard controls.count == 1 else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  AXUIElementSetMessagingTimeout(controls[0], 0.5)
  try validate(context)
  lock.lock(); defer { lock.unlock() }
  if cancelled { throw fail("TOOL_EXECUTION_CANCELLED") }
  effectStarted = true
  guard AXUIElementPerformAction(controls[0], kAXPressAction as CFString) == .success else { throw fail("TOOL_STATE_INVALID") }
}
func selectedRange(_ element: AXUIElement) throws -> CFRange {
  guard let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  var range = CFRange()
  guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0 else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  return range
}
func setAttribute(_ element: AXUIElement, _ name: String, _ value: CFTypeRef, _ context: AppContext) throws {
  try validate(context)
  lock.lock(); defer { lock.unlock() }
  if cancelled { throw fail("TOOL_EXECUTION_CANCELLED") }
  effectStarted = true
  guard AXUIElementSetAttributeValue(element, name as CFString, value) == .success else { throw fail("TOOL_STATE_INVALID") }
}
func typeText(_ command: [String: Any], _ context: AppContext) throws {
  guard let text = command["text"] as? String, text.utf16.count <= 32_000 else { throw fail("INVALID_REQUEST") }
  let element = try textTarget(context, point(command, context))
  guard let value = attribute(element, kAXValueAttribute) as? String, value.utf16.count <= 65_536 else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  if command["replace"] as? Bool == true {
    guard settable(element, kAXValueAttribute) else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
    try setAttribute(element, kAXValueAttribute, text as CFString, context)
    guard attribute(element, kAXValueAttribute) as? String == text else { throw fail("TOOL_STATE_INVALID") }; return
  }
  let range = try selectedRange(element)
  guard range.location <= value.utf16.count, range.length <= value.utf16.count - range.location else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  let replacement = (value as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
  if settable(element, kAXSelectedTextAttribute) {
    try setAttribute(element, kAXSelectedTextAttribute, text as CFString, context)
    guard attribute(element, kAXValueAttribute) as? String == replacement else { throw fail("TOOL_STATE_INVALID") }; return
  }
  guard settable(element, kAXValueAttribute) else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  try setAttribute(element, kAXValueAttribute, replacement as CFString, context)
  guard attribute(element, kAXValueAttribute) as? String == replacement else { throw fail("TOOL_STATE_INVALID") }
  if settable(element, kAXSelectedTextRangeAttribute) {
    var caret = CFRange(location: range.location + text.utf16.count, length: 0)
    if let position = AXValueCreate(.cfRange, &caret) { try setAttribute(element, kAXSelectedTextRangeAttribute, position, context) }
  }
}
func key(_ command: [String: Any], _ context: AppContext) throws {
  guard let key = command["key"] as? String, ["meta+a", "cmd+a", "command+a"].contains(key.lowercased()) else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  let element = try textTarget(context, point(command, context))
  guard let value = attribute(element, kAXValueAttribute) as? String, settable(element, kAXSelectedTextRangeAttribute) else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  var range = CFRange(location: 0, length: value.utf16.count)
  guard let selected = AXValueCreate(.cfRange, &range) else { throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED") }
  try setAttribute(element, kAXSelectedTextRangeAttribute, selected, context)
  let actual = try selectedRange(element)
  guard actual.location == 0, actual.length == value.utf16.count else { throw fail("TOOL_STATE_INVALID") }
}
@available(macOS 14.0, *)
func capture(_ context: AppContext) throws -> [String: Any] {
  guard CGPreflightScreenCaptureAccess() else { throw fail("HOST_COMPUTER_PERMISSION") }
  let ready = DispatchSemaphore(value: 0)
  var content: SCShareableContent?
  SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { value, _ in content = value; ready.signal() }
  guard ready.wait(timeout: .now() + 10) == .success, let window = content?.windows.first(where: { $0.windowID == context.target.windowId && $0.owningApplication?.processID == context.target.pid }) else { throw fail("HOST_COMPUTER_TARGET_CHANGED") }
  try validate(context)
  let config = SCStreamConfiguration(), scale = min(1, 1600 / max(context.width, context.height))
  config.width = max(1, Int((context.width * scale).rounded())); config.height = max(1, Int((context.height * scale).rounded()))
  config.showsCursor = false; config.ignoreShadowsSingleWindow = true; config.scalesToFit = true
  let captured = DispatchSemaphore(value: 0)
  var image: CGImage?
  SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config) { value, _ in image = value; captured.signal() }
  guard captured.wait(timeout: .now() + 10) == .success, let image = image else { throw fail("BROWSER_UNAVAILABLE") }
  try validate(context)
  guard let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.75]), data.count <= 2_097_152 else { throw fail("BROWSER_MEDIA_INVALID") }
  return ["dataBase64": data.base64EncodedString(), "width": image.width, "height": image.height]
}
let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard bytes.count <= 100_000, let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let operation = command["operation"] as? String else { emit(["ok": false, "code": "INVALID_REQUEST"]); exit(2) }
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main), interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
for source in [termination, interruption] { source.setEventHandler { releaseInput(); exit(130) }; source.resume() }
DispatchQueue.global().async {
  do {
    if operation == "listTargets" { emit(["ok": true, "targets": object(targets())]); exit(0) }
    if operation == "status" || operation == "capture" {
      let target = try decode(command["target"], as: AppTarget.self), current = try context(for: target)
      if operation == "status" { emit(["ok": true, "accessibility": AXIsProcessTrusted(), "context": object(current)]); exit(0) }
      if #available(macOS 14.0, *) { emit(["ok": true, "context": object(current), "capture": try capture(current)]); exit(0) }
      throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED")
    }
    let expected = try decode(command["context"], as: AppContext.self); try validate(expected)
    guard AXIsProcessTrusted() else { throw fail("HOST_COMPUTER_PERMISSION") }
    switch operation {
    case "click": try click(command, expected)
    case "type": try typeText(command, expected)
    case "key": try key(command, expected)
    default: throw fail("HOST_COMPUTER_ACTION_UNSUPPORTED")
    }
    emit(["ok": true]); exit(0)
  } catch { releaseInput(); emit(["ok": false, "code": effectStarted ? "TOOL_STATE_INVALID" : (error as? Failure)?.code ?? "INVALID_REQUEST"]); exit(2) }
}
dispatchMain()
