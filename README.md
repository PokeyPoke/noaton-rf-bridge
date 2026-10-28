# Noaton RF Bridge

An ESP32-C3 running [ESPHome](https://esphome.io) that controls Noaton
433 MHz ceiling fans and their lights, and gives the battery wall switches
paired with them fan and light control. It needs no Home Assistant and no
cloud service. You get:

- a phone-friendly web page served by the bridge itself, with per-room fan
  speed, light on/off, brightness, colour, schedules and a wake-up ramp;
- wall switches that keep working without WiFi, with one side for the fan
  and one for the light;
- on-device schedules (8 slots), synced over NTP;
- **Away mode**, which switches each room's light on and off once every
  evening at times that change daily, so the house looks lived in;
- a **Fans Disabled** switch for winter, which turns each wall switch's fan
  side into a dimmer;
- Siri Shortcuts, one per phrase, such as "Turn on office light" or "Set fan
  in the bedroom to 3".

It only works with fans that use **Noaton remotes** (30-bit frames, see
[Protocol](#protocol)). The wall-switch side accepts any 24-bit EV1527 switch.

## Hardware

| Part | Notes |
|---|---|
| ESP32-C3 SuperMini | Any ESP32 that ESPHome supports will do; adjust `board:` in `tools/gen_esphome.py`. |
| SRX882 receiver | VCC and CS/EN to 3V3, DATA to GPIO4 |
| STX882 transmitter | **VCC to 5V**, DATA to GPIO5 |
| Two ~17.3 cm straight wires | Quarter-wave antennas, one per module |

- Power the transmitter from 5V. On 3V3 it didn't reach a fan two rooms away;
  on 5V it reached every room.
- Many C3 SuperMini boards have a poor antenna match, so the config sets WiFi
  output power to 8.5 dB. Raise it if your board copes.

## Setup

You need Python 3 and ESPHome (`pip install esphome`).

1. **Secrets.** Copy `esphome/secrets.yaml.example` to `esphome/secrets.yaml`
   and fill it in.
2. **Rooms.** Copy `home.example.json` to `home.json`. Its codes are made up,
   which is fine for the first flash.
3. **Flash over USB:**
   ```
   python3 tools/gen_esphome.py
   esphome run esphome/rf-bridge.yaml
   ```
4. **Capture your codes.** Watch the log (`esphome logs esphome/rf-bridge.yaml`)
   and press buttons near the bridge:
   - Any button on a room's handheld remote logs `heard 30 bits: …`. The
     **first 20 bits** are that remote's device ID, which goes in `remote`.
   - Each side of a wall switch logs `heard 24 bits: …`. That whole code goes
     in `switch` as `fan` or `light`.
5. **Fill in `home.json`**: one entry per room, in the order you want them
   on the page. `switch`, `away` and `siri` are optional.
6. **Regenerate and flash over WiFi:**
   ```
   python3 tools/gen_esphome.py
   esphome run esphome/rf-bridge.yaml --device <bridge-ip>
   ```
7. Open `http://<bridge-ip>/` (or `http://rf-bridge.local/`) on your phone.

`home.json`, `esphome/secrets.yaml` and the generated `esphome/rf-bridge.yaml`
and `esphome/ui.js` are git-ignored. Your codes work like keys to your fans,
so keep them out of anything you publish.

### `home.json`

```json
{
  "bridge": {"address": "192.168.1.50", "timezone": "Europe/London",
             "rx_pin": "GPIO4", "tx_pin": "GPIO5"},
  "rooms": [
    {"name": "Bedroom",
     "remote": "<20-bit device ID>",
     "switch": {"fan": "<24 bits>", "light": "<24 bits>"},
     "away": {"on": ["20:30", "21:30"], "off": ["22:30", "23:30"]},
     "siri": {"light": "Bedroom Light", "fan": "in the Bedroom"}}
  ]
}
```

- `address`: the bridge's IP. Only the Siri shortcuts use it, so give the
  bridge a fixed lease in your router.
- `away`: the light comes on at a random minute in `on` and goes off at a
  random minute in `off`, picked again every day. Leave it out to keep that
  room dark in Away mode.
- Changing a room's `name` renames its entities, so the bridge forgets that
  room's saved fan and light state.

## Siri Shortcuts (macOS + iPhone)

```
python3 tools/gen_shortcuts.py      # writes signed .shortcut files to shortcuts/
```

Open each file on a Mac and click **Add Shortcut**; iCloud syncs them to the
iPhone. A shortcut's name is the phrase Siri listens for, so each fan speed
has its own. For each room you get:

- Turn On / Turn Off ⟨light⟩
- ⟨light⟩ Low / ⟨light⟩ High (dimmest / brightest)
- Fix ⟨light⟩ (see [Light state](#light-state))
- Turn On / Turn Off Fan ⟨fan⟩, and Set Fan ⟨fan⟩ to 1–6

You also get Turn On All Lights, Turn Off All Lights, Turn Off All Fans,
Disable Fans, Enable Fans, Away Mode On and Away Mode Off.

Avoid the word "brightness" in a phrase: Siri takes it as a request to change
the phone's screen brightness. The shortcuts call the bridge directly, so
they only work on your home network.

## How it behaves

### Light state

A Noaton remote has no light on/off buttons, only Toggle, so the bridge keeps
a record of each light. It updates the record from its own presses, the wall
switches and the handheld remotes it overhears. "On" and "off" send Toggle
only when the record disagrees.

A press the bridge misses leaves the record inverted. **Force off** (the
page, or "Fix ⟨light⟩") puts it right: Warm turns any light on, and Toggle 2 s
later turns it off. Away mode doesn't rely on the record at all: it switches
on with Warm and off with Warm then Toggle.

### Fans

The remote's Power button only turns a fan off, and any speed turns it on.
The bridge tracks each fan's speed, so a wall switch's fan side can turn the
fan back on at its last speed.

With **Fans Disabled** on, the bridge sends no fan button at all, from the
page, schedules, Siri or the wall switches. Instead, a tap on the fan side
starts stepping the light dimmer (or brighter, alternating), and a second tap
stops it. Handheld remotes still talk to their fans directly.

### Command API

Everything the page and the shortcuts do is one POST:

```
curl -X POST -d 'value=0110|LIGHTOFF' http://<bridge>/text/Command/set
```

`0110` picks rooms 2 and 3 in `home.json` order. The action is a 9-bit button
field (see `BUTTONS` in `tools/gen_esphome.py`) or one of `LIGHTON`,
`LIGHTOFF`, `FORCEOFF`, `DIMMEST`, `BRIGHTEST`, `WAKE`, `FANON`, `STOP` or
`DEBUG` (logs every packet for 60 s). The bridge answers 411 to a POST with
no body.

## Protocol

These notes come from measurements of four Noaton remotes and their fans.

- **Remotes:** EV1527-style symmetric bits at T ≈ 370 µs (1 = 1093 µs on +
  383 µs off, 0 = the reverse). Each frame has 30 bits: a 20-bit device ID,
  a 9-bit button field, and an odd-parity bit over the button field only.
  The last bit's off period runs into a frame tail of about 7036 µs. There's
  no rolling code, so a press is the same frame repeated.
- **Button field:** a 5-bit command plus 4 check bits computed from it. Every
  remote uses the same 18 fields; only the device ID differs. None of the
  14 unused commands did anything on these fans, so there's no hidden
  light-off.
- **Wall switches:** EV1527, 24 bits at T ≈ 300 µs, then a 1T sync pulse and
  a 31T gap. They carry no check bits, so the bridge ignores a code heard
  only once.
- The bridge hears its own transmissions. Codes it sent within the last
  1.5 s are dropped on receive.

## License

MIT; see [LICENSE](LICENSE).
