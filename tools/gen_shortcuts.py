#!/usr/bin/env python3
"""Generate signed iOS/macOS Shortcuts, one per Siri phrase, for the bridge.

    python3 tools/gen_shortcuts.py [out_dir]   # default: shortcuts/

Each shortcut POSTs one value to the bridge, almost always the Command entity's
"<rooms>|<action>" (see noaton::command). A shortcut's name is its Siri phrase,
so the file name is the phrase. Open each .shortcut file on a Mac to add it;
iCloud then syncs it to the iPhone. Signing needs macOS. The bridge must be
reachable, so they work on the home WiFi only.

Rooms and the bridge address come from home.json. A room's "siri" entry sets
its phrases, e.g. {"light": "Office Light", "fan": "in the Office"} gives
"Turn On Office Light" and "Set Fan in the Office to 3".
"""
import os, plistlib, subprocess, sys, tempfile
from urllib.parse import quote

from gen_esphome import ROOT, load_home

HOME = load_home()
BRIDGE = "http://" + HOME["bridge"]["address"]

# (fan phrase, light phrase, room mask) -- mask picks the room by its place in home.json.
ROOMS = []
for _i, _room in enumerate(HOME["rooms"]):
    _siri = _room.get("siri", {})
    _mask = "".join("1" if j == _i else "0" for j in range(len(HOME["rooms"])))
    ROOMS.append((_siri.get("fan", f"in the {_room['name']}"), _siri.get("light", f"{_room['name']} Light"), _mask))
ALL = "1" * len(HOME["rooms"])

POWER = "110010001"   # the remote's Power button: fan off only
SPEEDS = ["111101000", "111001000", "110101001", "110001001", "101101010", "101001010"]


def shortcuts():
    """(name, entity path, form value) for every shortcut."""
    cmd = "/text/Command/set"
    out = []
    for fan, light, mask in ROOMS:
        out += [(f"Turn On {light}", cmd, f"{mask}|LIGHTON"),
                (f"Turn Off {light}", cmd, f"{mask}|LIGHTOFF"),
                # Not "brightness": Siri takes that for the phone's own screen.
                (f"{light} Low", cmd, f"{mask}|DIMMEST"),
                (f"{light} High", cmd, f"{mask}|BRIGHTEST"),
                (f"Fix {light}", cmd, f"{mask}|FORCEOFF"),
                (f"Turn On Fan {fan}", cmd, f"{mask}|FANON"),
                (f"Turn Off Fan {fan}", cmd, f"{mask}|{POWER}")]
        out += [(f"Set Fan {fan} to {n}", cmd, f"{mask}|{field}") for n, field in enumerate(SPEEDS, 1)]
    out += [("Turn On All Lights", cmd, f"{ALL}|LIGHTON"),
            ("Turn Off All Lights", cmd, f"{ALL}|LIGHTOFF"),
            ("Turn Off All Fans", cmd, f"{ALL}|{POWER}"),
            # A switch takes no value, but the bridge answers 411 to an empty POST.
            ("Disable Fans", "/switch/Fans Disabled/turn_on", "1"),
            ("Enable Fans", "/switch/Fans Disabled/turn_off", "1"),
            ("Away Mode On", "/switch/Away Mode/turn_on", "1"),
            ("Away Mode Off", "/switch/Away Mode/turn_off", "1")]
    return out


def text(s):
    return {"Value": {"string": s, "attachmentsByRange": {}}, "WFSerializationType": "WFTextTokenString"}


def workflow(path, value):
    post = {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
            "WFWorkflowActionParameters": {
                "WFURL": BRIDGE + quote(path),
                "WFHTTPMethod": "POST",
                "WFHTTPBodyType": "Form",
                "WFFormValues": {"Value": {"WFDictionaryFieldValueItems": [
                    {"WFItemType": 0, "WFKey": text("value"), "WFValue": text(value)}]},
                    "WFSerializationType": "WFDictionaryFieldValue"}}}
    return {"WFWorkflowClientVersion": "2605.0.5", "WFWorkflowMinimumClientVersion": 900,
            "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
            "WFWorkflowTypes": [], "WFWorkflowInputContentItemClasses": [], "WFWorkflowActions": [post]}


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "shortcuts")
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for name, path, value in shortcuts():
            unsigned = os.path.join(tmp, "unsigned.shortcut")
            with open(unsigned, "wb") as f:
                plistlib.dump(workflow(path, value), f, fmt=plistlib.FMT_BINARY)
            subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", unsigned,
                            "--output", os.path.join(out_dir, name + ".shortcut")],
                           check=True, capture_output=True)
            print(f"{name:40} {path} {value}")


if __name__ == "__main__":
    main()
