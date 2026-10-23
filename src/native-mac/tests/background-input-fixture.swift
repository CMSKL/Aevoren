import AppKit
import CoreGraphics
import Foundation

// Opt-in fixture: the app's internal key window stays behind existing apps. No activation or input injection.
let output = CommandLine.arguments[1]
let baselineFront = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
let baselinePointer = CGEvent(source: nil)?.location ?? .zero
var samples = 0, pointerChanged = false, frontChanged = false, activations = 0
var fixtureActivated = false, eventTapEstablished = false
var helperPids: Set<Int64> = [], helperGlobalEvents: [[String: Int64]] = []
var presses = 0
var applicationEvents: [[String: Int]] = [], windowEvents = 0
@objc(BackgroundProbeApplication)
final class BackgroundProbeApplication: NSApplication {
  override func sendEvent(_ event: NSEvent) {
    if [.leftMouseDown, .leftMouseUp, .leftMouseDragged].contains(event.type), applicationEvents.count < 100 {
      applicationEvents.append(["type": Int(event.type.rawValue), "windowNumber": event.windowNumber, "x": Int(event.locationInWindow.x), "y": Int(event.locationInWindow.y)])
    }
    super.sendEvent(event)
  }
}
final class BackgroundWindow: NSWindow {
  override func sendEvent(_ event: NSEvent) {
    if [.leftMouseDown, .leftMouseUp, .leftMouseDragged].contains(event.type) { windowEvents += 1 }
    super.sendEvent(event)
  }
}
final class Delegate: NSObject, NSApplicationDelegate {
  var window: BackgroundWindow!
  var eventTap: CFMachPort?
  let field = NSTextField(frame: NSRect(x: 30, y: 170, width: 300, height: 24))
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = BackgroundWindow(contentRect: NSRect(x: 100, y: 100, width: 420, height: 260), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Aevoren background input fixture"
    let button = NSButton(frame: NSRect(x: 20, y: 20, width: 300, height: 120))
    button.title = "Background action"; button.bezelStyle = .rounded; button.target = self; button.action = #selector(press)
    window.contentView!.addSubview(button)
    field.stringValue = "unchanged fixture"; window.contentView!.addSubview(field)
    window.orderBack(nil)
    window.makeKey(); window.makeFirstResponder(field)
    if CGPreflightListenEventAccess() {
      let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
      let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
      eventTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, _ in
        let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
        if helperPids.contains(pid), helperGlobalEvents.count < 100 { helperGlobalEvents.append(["sourcePid": pid, "type": Int64(type.rawValue)]) }
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { eventTapEstablished = false }
        return Unmanaged.passUnretained(event)
      }, userInfo: nil)
      if let tap = eventTap, let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) {
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes); CGEvent.tapEnable(tap: tap, enable: true); eventTapEstablished = true
      }
    }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
      activations += 1
      if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier == ProcessInfo.processInfo.processIdentifier { fixtureActivated = true }
      self.sample()
    }
    Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in self.sample() }
    Timer.scheduledTimer(withTimeInterval: 40, repeats: false) { _ in NSApplication.shared.terminate(nil) }
    sample()
  }
  @objc func press(_ sender: NSButton) { presses += 1; sender.title = "Confirmed background action \(presses)"; sample() }
  func sample() {
    samples += 1
    pointerChanged = pointerChanged || CGEvent(source: nil)?.location != baselinePointer
    frontChanged = frontChanged || NSWorkspace.shared.frontmostApplication?.processIdentifier != baselineFront
    fixtureActivated = fixtureActivated || NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
    if let data = try? Data(contentsOf: URL(fileURLWithPath: output + ".helpers.json")), let pids = try? JSONDecoder().decode([Int64].self, from: data) { helperPids = Set(pids) }
    let value: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "startedAt": NSRunningApplication.current.launchDate?.timeIntervalSince1970 ?? 0,
      "windowId": window.windowNumber, "appName": "Background fixture", "title": window.title,
      "samples": samples, "pointerChanged": pointerChanged, "frontChanged": frontChanged, "activationEvents": activations,
      "fixtureActivated": fixtureActivated, "eventTapEstablished": eventTapEstablished, "helperGlobalEvents": helperGlobalEvents,
      "pointerChangeAttribution": pointerChanged ? "unattributed" : "no sampled change",
      "internalKeyWindow": window.isKeyWindow, "applicationActive": NSApplication.shared.isActive,
      "applicationEvents": applicationEvents, "windowEvents": windowEvents,
      "presses": presses, "text": field.stringValue]
    if let data = try? JSONSerialization.data(withJSONObject: value) { try? data.write(to: URL(fileURLWithPath: output), options: .atomic) }
  }
}
let application = BackgroundProbeApplication.shared
application.setActivationPolicy(.accessory)
let delegate = Delegate(); application.delegate = delegate
application.run()
