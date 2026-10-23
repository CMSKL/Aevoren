"""Opt-in native integration test. Operates only a temporary background fixture window."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("--helper", required=True, help="Already compiled background-only helper")
arguments = parser.parse_args()
helper = str(Path(arguments.helper).resolve())
root = Path(tempfile.mkdtemp(prefix="aevoren-background-fixture-"))
app = root / "BackgroundFixture.app"
(app / "Contents" / "MacOS").mkdir(parents=True)
with (app / "Contents" / "Info.plist").open("wb") as output:
    plistlib.dump({"CFBundleExecutable": "BackgroundFixture", "CFBundleIdentifier": "com.aevoren.background-input-fixture",
                  "CFBundleName": "BackgroundFixture", "CFBundlePackageType": "APPL", "LSUIElement": True,
                  "NSPrincipalClass": "BackgroundProbeApplication"}, output)
subprocess.run(["/usr/bin/swiftc", "-swift-version", "5", "-O", str(Path(__file__).with_name("background-input-fixture.swift")),
                "-o", str(app / "Contents" / "MacOS" / "BackgroundFixture")], check=True)
receipt = root / "receipt.json"
helper_pids = root / "receipt.json.helpers.json"
processes = []
report = {"stages": [], "helperSha256": hashlib.sha256(Path(helper).read_bytes()).hexdigest(),
          "sourceSha256": hashlib.sha256(Path(__file__).parents[1].joinpath("computer-input.swift").read_bytes()).hexdigest()}
fixture_pid = None


def state():
    return json.loads(receipt.read_text())


def guarded():
    value = state()
    if value["fixtureActivated"]:
        raise RuntimeError("Fixture became foreground; no further input allowed")
    if value["helperGlobalEvents"]:
        raise RuntimeError("Helper-origin event observed in global input stream; no further input allowed")
    return value


def start(command):
    process = subprocess.Popen([helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    processes.append(process)
    helper_pids.write_text(json.dumps([item.pid for item in processes]))
    # Let the passive observer learn the PID before the helper receives a command.
    time.sleep(0.06)
    guarded()
    process.stdin.write(json.dumps(command))
    process.stdin.close()
    process.stdin = None
    return process


def call(command):
    process = start(command)
    stdout, _ = process.communicate(timeout=25)
    return json.loads(stdout)


try:
    subprocess.run(["/usr/bin/open", "-g", "-n", str(app), "--args", str(receipt)], check=True)
    deadline = time.monotonic() + 8
    while not receipt.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    initial = guarded()
    fixture_pid = initial["pid"]
    target = {"kind": "app", **{key: initial[key] for key in ["pid", "startedAt", "windowId", "appName", "title"]}}
    status = call({"operation": "status", "target": target})
    report["stages"].append({"stage": "targetStatus", "ok": status.get("ok"), "accessibility": status.get("accessibility")})
    if not status.get("ok") or not status.get("accessibility"):
        raise RuntimeError("Target or accessibility unavailable; no permissions were changed")
    context = status["context"]
    report["stages"][-1]["context"] = context
    capture = call({"operation": "capture", "target": target})
    report["stages"].append({"stage": "windowCapture", "ok": capture.get("ok"), "code": capture.get("code"),
                             "dimensions": {key: capture.get("capture", {}).get(key) for key in ["width", "height"]}})
    # Only the owned fixture's pixels are requested; no pixels are persisted in the report.
    if not capture.get("ok"):
        raise RuntimeError("Single-window capture unavailable; input was not attempted")
    context = capture["context"]
    report["stages"][-1]["context"] = context
    initial_pixels = hashlib.sha256(base64.b64decode(capture["capture"]["dataBase64"], validate=True)).digest()
    del capture
    fresh = call({"operation": "status", "target": target})
    report["stages"].append({"stage": "freshTargetStatus", "receipt": fresh})
    if not fresh.get("ok") or fresh.get("context") != context:
        raise RuntimeError("Fixture geometry changed after capture; input was not attempted")
    guarded()
    base = {"context": context}
    point = {"x": 80, "y": context["height"] - 80}
    click = call({**base, "operation": "click", **point})
    time.sleep(0.3)
    clicked = guarded()
    report["stages"].append({"stage": "AXPress", "receipt": click, "presses": clicked["presses"]})
    if not click.get("ok") or clicked["presses"] != 1:
        raise RuntimeError("Target did not confirm AXPress effect; no further input attempted")
    changed_capture = call({"operation": "capture", "target": target})
    pixels_changed = changed_capture.get("ok") and hashlib.sha256(base64.b64decode(changed_capture["capture"]["dataBase64"], validate=True)).digest() != initial_pixels
    report["stages"].append({"stage": "AXPressScreenshotEffect", "ok": changed_capture.get("ok"), "pixelsChanged": pixels_changed})
    del changed_capture
    if not pixels_changed:
        raise RuntimeError("Button count changed without a confirmed fixture screenshot change")
    unsupported = [
        ("move", point), ("drag", {"path": [point, {"x": 100, "y": point["y"]}]}),
        ("scroll", {**point, "deltaY": 1}), ("key", {**point, "key": "Enter"}),
        ("click", {**point, "button": "right"}), ("click", {"x": 390, "y": 150}),
    ]
    for operation, values in unsupported:
        result = call({**base, "operation": operation, **values})
        observed = guarded()
        report["stages"].append({"stage": "unsupported-" + operation, "receipt": result, "presses": observed["presses"]})
        if result.get("code") != "HOST_COMPUTER_ACTION_UNSUPPORTED" or observed["presses"] != 1:
            raise RuntimeError("Unsupported operation did not fail closed before effect")
    text_point = {"x": 80, "y": context["height"] - 182}
    expected_text = "unchanged fixture"
    for operation, values in [("type", {"text": "verified background text", "replace": True}), ("key", {"key": "Meta+a"})]:
        result = call({**base, "operation": operation, **values, **text_point})
        time.sleep(0.1)
        observed = guarded()
        if result.get("ok") and operation == "type":
            expected_text = values["text"]
        report["stages"].append({"stage": "focused-" + operation, "receipt": result,
                                 "verified": bool(result.get("ok")), "textMatchesExpected": observed["text"] == expected_text})
        if not result.get("ok") and result.get("code") != "HOST_COMPUTER_ACTION_UNSUPPORTED":
            raise RuntimeError("Text operation returned an unexpected outcome")
        if observed["text"] != expected_text:
            raise RuntimeError("Text effect did not match the acknowledged outcome")
    result = call({**base, "operation": "type", "text": "verified selected-text insertion", **text_point})
    time.sleep(0.1)
    observed = guarded()
    if result.get("ok"):
        expected_text = "verified selected-text insertion"
    report["stages"].append({"stage": "focused-insertion", "receipt": result,
                             "verified": bool(result.get("ok")), "textMatchesExpected": observed["text"] == expected_text})
    if observed["text"] != expected_text or (not result.get("ok") and result.get("code") != "HOST_COMPUTER_ACTION_UNSUPPORTED"):
        raise RuntimeError("Selected-text insertion did not match the acknowledged outcome")
    for operation, values in [("type", {"text": "must not be written", "replace": True}), ("key", {"key": "Meta+a"})]:
        result = call({**base, "operation": operation, **values, **point})
        observed = guarded()
        report["stages"].append({"stage": "wrong-anchor-" + operation, "receipt": result, "textUnchanged": observed["text"] == expected_text})
        if result.get("code") != "HOST_COMPUTER_ACTION_UNSUPPORTED" or observed["text"] != expected_text:
            raise RuntimeError("Text operation with non-text anchor did not fail closed")
    time.sleep(0.3)
    settled = guarded()
    report["stages"].append({"stage": "noInjectedWindowEvents", "applicationEvents": len(settled["applicationEvents"]), "windowEvents": settled["windowEvents"]})
    if settled["applicationEvents"] or settled["windowEvents"]:
        raise RuntimeError("Unexpected injected mouse event reached fixture")
    report["passed"] = True
except Exception as error:
    report["passed"] = False
    report["error"] = str(error)
finally:
    for process in processes:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
    if receipt.exists():
        report["final"] = state()
        fixture_pid = fixture_pid or report["final"].get("pid")
    (root / "report.json").write_text(json.dumps(report, indent=2))
    if fixture_pid:
        try:
            os.kill(fixture_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    print(json.dumps(report))
    print(root / "report.json")
raise SystemExit(0 if report.get("passed") else 1)
