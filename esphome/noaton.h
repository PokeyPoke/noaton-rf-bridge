// RF bridge helpers: decode the wall switches and Noaton remotes, send Noaton
// frames, and track each room's fan (on/off, speed) and light (on/off).
//
// Both devices use EV1527-style symmetric bits, where a long ON pulse is 1:
//   - wall switches: 24 bits at T~300us, then a 1T sync pulse and a 31T gap
//   - Noaton remotes: 30 bits at T~370us; the 30th is odd parity over the
//     9-bit button field, and its OFF runs into a fixed 7036us frame tail
// The receiver's 4ms idle splits the stream at each frame gap, so one packet
// is one frame. The README's protocol notes say how this was measured; the
// codes this builds were checked against four fans.
#pragma once

#include <algorithm>
#include <string>
#include <vector>
#include "esphome/core/helpers.h"
#include "esphome/core/log.h"
#include "esphome/components/fan/fan.h"
#include "esphome/components/remote_transmitter/remote_transmitter.h"
#include "esphome/components/switch/switch.h"

namespace noaton {

static const uint32_t kShortUs = 383;
static const uint32_t kLongUs = 1093;
static const uint32_t kTailUs = 7036;
static const int kFrames = 4;

// The remote's Power button only turns the fan off; any speed turns it on.
static const char *const kPower = "110010001";
static const char *const kBreeze = "100001011";
static const char *const kSpeeds[6] = {"111101000", "111001000", "110101001",
                                       "110001001", "101101010", "101001010"};
// The light has a toggle and no on/off buttons. Warm switches an off light on,
// and Cool and White are assumed to as well; Dimmer doesn't.
static const char *const kLightToggle = "010110101";
static const char *const kCool = "110110001";
static const char *const kWarm = "101110010";
static const char *const kWhite = "111010000";
static const char *const kDimmer = "011110100";
static const char *const kBrighter = "100110011";

// True while the bridge records a change it overheard, or replays its state at
// boot. Fan on_state fires on every publish_state(), so without this flag the
// bridge would re-send every remote press it hears.
inline bool &quiet() {
  static bool q = true;  // cleared by on_boot, once restored states are published
  return q;
}

// Receiver diagnostics, logged every few seconds: a silent receiver, a
// receiver drowning in noise and a decoder rejecting real frames all look the
// same from the outside -- nothing happens.
struct RxStats {
  uint32_t packets = 0, frame_sized = 0, decoded = 0;
};
inline RxStats &rx_stats() {
  static RxStats s;
  return s;
}

inline void log_rejected(const std::vector<int32_t> &x) {
  std::string head;
  for (size_t i = 0; i < x.size() && i < 24; i++) head += std::to_string(x[i]) + " ";
  ESP_LOGW("rf", "frame-sized packet (%u values) not decoded: %s", (unsigned) x.size(), head.c_str());
}

// Command "0000|DEBUG": for 60s, log a summary of every packet, to see what
// the receiver is getting when a switch isn't decoded.
inline uint32_t &debug_until() {
  static uint32_t t = 0;
  return t;
}

inline void log_packet(const std::vector<int32_t> &x, size_t ons) {
  int32_t lo = 0, hi = 0, gap = 0;
  for (auto v : x) {
    if (v > 0) {
      lo = lo == 0 ? v : std::min(lo, v);
      hi = std::max(hi, v);
    } else {
      gap = std::min(gap, v);
    }
  }
  std::string head;
  for (size_t i = 0; i < x.size() && i < 80; i++) head += std::to_string(x[i]) + " ";
  ESP_LOGI("rfdbg", "%u values, %u ons, on %d..%d, longest off %d: %s", (unsigned) x.size(), (unsigned) ons,
           lo, hi, gap, head.c_str());
}

// One packet -> bit string, or "" if it doesn't look like a frame.
inline std::string decode_frame(const std::vector<int32_t> &x);
inline std::string decode(const std::vector<int32_t> &x) {
  auto &st = rx_stats();
  st.packets++;
  size_t ons = 0;
  for (auto v : x) ons += v > 0;
  if ((int32_t) (debug_until() - esphome::millis()) > 0) log_packet(x, ons);
  bool frame_sized = ons >= 24 && ons <= 31;
  if (frame_sized) st.frame_sized++;
  std::string bits = decode_frame(x);
  if (!bits.empty()) st.decoded++;
  else if (frame_sized) log_rejected(x);
  return bits;
}

// A remote frame checks itself twice: the button field is a 5-bit command
// whose last 4 bits are NOT(cmd bit 0) then NOT(cmd bits 4..2), and the 30th
// bit is odd parity over the field. A misread frame almost never passes both.
inline bool valid_remote(const std::string &bits) {
  int cmd = 0, tail = 0, ones = 0;
  for (int i = 20; i < 25; i++) cmd = cmd << 1 | (bits[i] == '1');
  for (int i = 25; i < 29; i++) tail = tail << 1 | (bits[i] == '1');
  for (int i = 20; i < 29; i++) ones += bits[i] == '1';
  bool check = tail == ((((cmd & 1) ^ 1) << 3) | ((~cmd >> 2) & 7));
  return check && (bits[29] == '1') == (ones % 2 == 0);
}

// Reads bits by the level in the middle of each bit (1.5T and 2.5T in): high
// for a 1 (3T on), low for a 0 (1T on). A weak frame loses its short 300us
// lows, merging a 1 into the next bit (ONs of 1500, 2100, 2700us), and
// sometimes a 0's short ON; both happen at a bit's edges, so the middle still
// reads right. Bit starts are re-taken from rising edges where there is one.
inline std::string read_bits(const std::vector<std::pair<uint32_t, uint32_t>> &on, size_t first, uint32_t end,
                             uint32_t t) {
  auto high = [&](uint32_t at) {
    for (auto &v : on) {
      if (at < v.first) return false;
      if (at < v.second) return true;
    }
    return false;
  };
  std::string bits;
  uint32_t start = on[first].first;
  size_t edge = first + 1;
  while (start < end && bits.size() < 32) {
    bool a = high(start + t * 3 / 2), b = high(start + t * 5 / 2);
    if (a != b) return "";  // neither a 1 nor a 0
    bits += a ? '1' : '0';
    uint32_t expect = start + 4 * t;
    while (edge < on.size() && on[edge].first + t < expect) edge++;
    start = edge < on.size() && on[edge].first <= expect + t ? on[edge].first : expect;
  }
  // A switch frame ends with its 1T sync pulse, which reads as a 0.
  if (bits.size() == 25 && bits.back() == '0') bits.pop_back();
  if (bits.size() == 30 && !valid_remote(bits)) return "";
  return bits.size() == 24 || bits.size() == 30 ? bits : "";
}

inline std::string decode_frame(const std::vector<int32_t> &raw) {
  // ESPHome ends each packet with the silence that closed it (the frame gap,
  // >4ms). It is not part of the last bit, so drop it.
  std::vector<int32_t> x(raw);
  while (!x.empty() && x.back() < -2500) x.pop_back();
  std::vector<std::pair<uint32_t, uint32_t>> on;
  uint32_t now = 0, sum = 0, n = 0;
  for (auto v : x) {
    uint32_t d = v > 0 ? v : -v;
    if (v > 0) {
      on.push_back({now, now + d});
      // T from the clean short ONs: ~300us for a switch, ~383us for a remote.
      if (d >= 200 && d <= 500) {
        sum += d;
        n++;
      }
    }
    now += d;
  }
  if (on.size() < 8 || n < 3) return "";
  uint32_t t = sum / n;
  // A stray pulse ahead of the frame shifts every bit; try the next starts too.
  for (size_t first = 0; first < 3 && first < on.size(); first++) {
    std::string bits = read_bits(on, first, now, t);
    if (!bits.empty()) return bits;
  }
  return "";
}

// A button repeats its frame for as long as it is held. Act once, when the
// frames stop: replying sooner collides with the switch still transmitting
// (the fan then hears neither), and a long hold must still be one press.
static const uint32_t kReleaseMs = 500;
struct Burst {
  std::string code;
  uint32_t last;
  uint32_t frames;
};
inline std::vector<Burst> &bursts() {
  static std::vector<Burst> b;
  return b;
}

inline void frame(const std::string &code) {
  uint32_t now = esphome::millis();
  for (auto &b : bursts()) {
    if (b.code == code) {
      b.last = now;
      b.frames++;
      return;
    }
  }
  bursts().push_back({code, now, 1});
}

// Presses whose frames have stopped, oldest first; each is returned once.
inline std::vector<Burst> released() {
  std::vector<Burst> out;
  uint32_t now = esphome::millis();
  auto &b = bursts();
  for (size_t i = 0; i < b.size();) {
    if (now - b[i].last >= kReleaseMs) {
      out.push_back(b[i]);
      b.erase(b.begin() + i);
    } else {
      i++;
    }
  }
  return out;
}

// The receiver hears the bridge's own transmissions. Taken for a handheld
// remote, an echoed Toggle would flip the light's record back.
static const uint32_t kEchoMs = 1500;
struct Sent {
  std::string code;
  uint32_t at;
};
inline std::vector<Sent> &recent_sends() {
  static std::vector<Sent> s;
  return s;
}

inline bool own_echo(const std::string &code) {
  uint32_t now = esphome::millis();
  for (auto &s : recent_sends()) {
    if (s.code == code && now - s.at < kEchoMs) return true;
  }
  return false;
}

inline std::string with_parity(const std::string &code29) {
  int ones = 0;
  for (size_t i = 20; i < 29; i++) ones += code29[i] == '1';
  return code29 + (ones % 2 == 0 ? '1' : '0');
}

inline void send(esphome::remote_transmitter::RemoteTransmitterComponent *tx,
                 const std::string &code29) {
  std::string bits = with_parity(code29);
  auto call = tx->transmit();
  auto *data = call.get_data();
  data->set_carrier_frequency(0);
  for (size_t i = 0; i < bits.size(); i++) {
    uint32_t on = bits[i] == '1' ? kLongUs : kShortUs;
    data->mark(on);
    data->space(i + 1 == bits.size() ? kTailUs - on : kLongUs + kShortUs - on);
  }
  call.set_send_times(kFrames);
  call.perform();
  // Stamped after the (blocking) send, so the window covers the whole echo.
  auto &r = recent_sends();
  uint32_t now = esphome::millis();
  r.erase(std::remove_if(r.begin(), r.end(), [now](const Sent &s) { return now - s.at >= kEchoMs; }), r.end());
  r.push_back({bits, now});
}

// Update a fan's record without transmitting.
inline void track_fan(esphome::fan::Fan *f, const std::string &field) {
  bool on = f->state;
  int speed = f->speed;
  if (field == kPower) {
    on = false;
  } else if (field == kBreeze) {
    on = true;
  } else {
    for (int s = 0; s < 6; s++) {
      if (field == kSpeeds[s]) {
        on = true;
        speed = s + 1;
      }
    }
  }
  if (on == f->state && speed == f->speed) return;
  quiet() = true;
  f->state = on;
  f->speed = speed;
  f->publish_state();
  quiet() = false;
}

// Fan on_state: make the fan match its entity. Called for the phone UI and
// for a wall-switch toggle; skipped for overheard or restored changes.
inline void apply(esphome::remote_transmitter::RemoteTransmitterComponent *tx,
                  const std::string &id20, esphome::fan::Fan *f) {
  if (quiet()) return;
  if (!f->state) {
    send(tx, id20 + kPower);
    return;
  }
  if (f->speed < 1 || f->speed > 6) {
    quiet() = true;  // first use: pick a speed without sending twice
    f->speed = 3;
    f->publish_state();
    quiet() = false;
  }
  send(tx, id20 + kSpeeds[f->speed - 1]);
}

// Update a light's record without transmitting. Publishing a switch state
// doesn't run its turn_on/turn_off actions, so this sends nothing.
inline void track_light(esphome::switch_::Switch *l, const std::string &field) {
  bool on = l->state;
  if (field == kLightToggle) on = !on;
  else if (field == kCool || field == kWarm || field == kWhite) on = true;
  if (on != l->state) l->publish_state(on);
}

// ---- rooms, commands and schedules ------------------------------------------
//
// The page and the schedules both name a set of rooms and one 9-bit button
// field; every button is the same field on all four remotes, so one command
// fans out by prefixing each selected room's device ID.

struct Room {
  std::string id20;
  esphome::fan::Fan *fan;
  esphome::switch_::Switch *light;
};

inline esphome::remote_transmitter::RemoteTransmitterComponent *&transmitter() {
  static esphome::remote_transmitter::RemoteTransmitterComponent *tx = nullptr;
  return tx;
}

inline std::vector<Room> &rooms() {
  static std::vector<Room> r;
  return r;
}

// "Fans Disabled" switch: while it is on, the bridge sends no fan button --
// not from the page or a schedule -- and a wall switch's fan gang dims the
// light instead (see fan_gang). A handheld remote talks to its fan directly,
// so it still works, and is still recorded.
inline esphome::switch_::Switch *&fan_lock() {
  static esphome::switch_::Switch *s = nullptr;
  return s;
}
inline bool fans_locked() { return fan_lock() != nullptr && fan_lock()->state; }

// Every button that isn't the light's is the fan's.
inline bool fan_field(const std::string &f) {
  return f != kLightToggle && f != kCool && f != kWarm && f != kWhite && f != kDimmer && f != kBrighter;
}

inline bool valid_field(const std::string &f) {
  return f.size() == 9 && f.find_first_not_of("01") == std::string::npos;
}

// A button the room's remote sent, overheard by the receiver.
inline void heard(size_t room, const std::string &field) {
  if (room >= rooms().size()) return;
  track_fan(rooms()[room].fan, field);
  track_light(rooms()[room].light, field);
}

// Send a button to one room and record what it does to the fan and light.
inline void press(size_t room, const std::string &field) {
  if (transmitter() == nullptr || room >= rooms().size()) return;
  if (fans_locked() && fan_field(field)) {
    ESP_LOGI("rf", "fans disabled: not sending %s to room %u", field.c_str(), (unsigned) room + 1);
    return;
  }
  send(transmitter(), rooms()[room].id20 + field);
  heard(room, field);
}

// Light on or off from its recorded state: Toggle only if it differs, so an
// off light stays off. If the record is wrong (a press the fan missed),
// FORCEOFF puts it right.
inline void set_light(size_t room, bool on) {
  if (room >= rooms().size()) return;
  if (rooms()[room].light->state != on) press(room, kLightToggle);
}

// Light switch entity's turn_on/turn_off action; skipped while restoring at boot.
inline void light_action(size_t room, bool on) {
  if (!quiet()) set_light(room, on);
}

// rooms: "0110" = rooms 2 and 3. Rooms are sent one after another, ~0.2s each.
// field is a 9-bit button, or ON / OFF for the light by its recorded state.
inline void run(const std::string &mask, const std::string &field) {
  bool on = field == "ON", off = field == "OFF";
  if (!on && !off && !valid_field(field)) return;
  for (size_t i = 0; i < rooms().size() && i < mask.size(); i++) {
    if (mask[i] != '1') continue;
    if (on || off) set_light(i, on);
    else press(i, field);
  }
}

inline std::vector<std::string> split(const std::string &s, char sep) {
  std::vector<std::string> out(1);
  for (char c : s) {
    if (c == sep) out.emplace_back();
    else out.back() += c;
  }
  return out;
}

// ---- sequences ----------------------------------------------------------
//
// Brightness has 8 levels and no feedback, so "dimmest" is Dimmer pressed 7
// times -- enough from any level. Presses are spaced so the fan's receiver
// counts each one rather than merging them into one held press. A wake-up
// turns the light on (Dimmer alone doesn't), takes it to dimmest, then
// brightens one level at a time.

static const uint32_t kLightOnMs = 2000;   // let a light come on before toggling it
static const int kLevels = 8;
static const uint32_t kPressGapMs = 1500;  // 700 dropped presses on the real fans
static const uint32_t kWakeMs = 30 * 60 * 1000;

struct Step {
  uint32_t at;
  std::string mask, field;
};

struct Sequence {
  std::vector<Step> steps;
  std::string label;
};

inline Sequence &sequence() {
  static Sequence s;
  return s;
}

inline void queue_presses(std::vector<Step> &out, uint32_t start, const std::string &mask,
                          const char *field, int count) {
  for (int i = 0; i < count; i++) out.push_back({start + i * kPressGapMs, mask, field});
}

// Starting a sequence replaces any running one: two would interleave presses.
inline void start_sequence(const std::string &label, std::vector<Step> steps) {
  sequence().steps = std::move(steps);
  sequence().label = label;
}

inline void stop_sequence() {
  sequence().steps.clear();
  sequence().label.clear();
}

// Called every 100ms from an interval. Sends at most one step per call, so a
// long sequence never blocks the loop for more than one press.
inline void pump() {
  auto &s = sequence().steps;
  if (s.empty()) return;
  uint32_t now = esphome::millis();
  for (size_t i = 0; i < s.size(); i++) {
    if ((int32_t)(now - s[i].at) >= 0) {
      Step step = s[i];
      s.erase(s.begin() + i);
      run(step.mask, step.field);
      if (s.empty()) sequence().label.clear();
      return;
    }
  }
}

// For the page: "" when idle, else e.g. "Wake-up · 5 steps left".
inline std::string pending() {
  auto &s = sequence();
  if (s.steps.empty()) return "";
  return s.label + " · " + std::to_string(s.steps.size()) + (s.steps.size() == 1 ? " step left" : " steps left");
}

// An action is a 9-bit button field, or one of the named sequences.
inline bool valid_action(const std::string &a) {
  return valid_field(a) || a == "DEBUG" || a == "DIMMEST" || a == "BRIGHTEST" || a == "WAKE" || a == "LIGHTON" ||
         a == "LIGHTOFF" || a == "FORCEOFF" || a == "FANON" || a == "STOP";
}

// FANON: each room's fan back on at its recorded speed, like its wall switch.
inline void fans_on(const std::string &mask) {
  for (size_t i = 0; i < rooms().size() && i < mask.size(); i++) {
    if (mask[i] != '1') continue;
    if (fans_locked()) {
      ESP_LOGI("rf", "fans disabled: not turning on room %u", (unsigned) i + 1);
      continue;
    }
    rooms()[i].fan->turn_on().perform();
  }
}

inline void run_action(const std::string &mask, const std::string &action) {
  uint32_t now = esphome::millis();
  std::vector<Step> steps;
  if (action == "STOP") {
    stop_sequence();
  } else if (action == "DEBUG") {
    debug_until() = now + 60000;
  } else if (action == "DIMMEST" || action == "BRIGHTEST") {
    queue_presses(steps, now, mask, action == "DIMMEST" ? kDimmer : kBrighter, kLevels - 1);
    start_sequence(action == "DIMMEST" ? "Dimmest" : "Brightest", std::move(steps));
  } else if (action == "LIGHTON" || action == "LIGHTOFF") {
    run(mask, action == "LIGHTON" ? "ON" : "OFF");
  } else if (action == "FANON") {
    fans_on(mask);
  } else if (action == "FORCEOFF") {
    // Off whatever the record says: Warm switches a light on whatever it was
    // doing, so Warm then Toggle always ends off, and the record with it.
    steps.push_back({now, mask, kWarm});
    steps.push_back({now + kLightOnMs, mask, kLightToggle});
    start_sequence("Force off", std::move(steps));
  } else if (action == "WAKE") {
    steps.push_back({now, mask, "ON"});
    // Give the light a moment to come on before it takes Dimmer presses.
    queue_presses(steps, now + 2000, mask, kDimmer, kLevels - 1);
    for (int k = 1; k < kLevels; k++) steps.push_back({now + k * (kWakeMs / (kLevels - 1)), mask, kBrighter});
    start_sequence("Wake-up", std::move(steps));
  } else {
    run(mask, action);
  }
}

// A wall switch's fan gang. With fans disabled it ramps the light instead:
// a tap starts it stepping dimmer (or brighter, alternating each ramp) and a
// second tap stops it where it is. Left alone, a ramp ends at the end of the
// range after 7 steps, so the direction never drifts from the light's.
inline std::vector<bool> &ramp_up() {
  static std::vector<bool> up(4, true);  // flipped before the first ramp, so it dims
  return up;
}

inline void fan_gang(size_t room) {
  if (room >= rooms().size()) return;
  if (!fans_locked()) {
    rooms()[room].fan->toggle().perform();
    return;
  }
  std::string label = "Ramp room " + std::to_string(room + 1);
  if (sequence().label.rfind(label, 0) == 0) {
    stop_sequence();
    return;
  }
  if (ramp_up().size() <= room) ramp_up().resize(room + 1, true);
  bool up = ramp_up()[room] = !ramp_up()[room];
  std::string mask(rooms().size(), '0');
  mask[room] = '1';
  std::vector<Step> steps;
  // Dimmer and Brighter only: they can't switch a light off, whereas a Toggle
  // sent on a wrong light record would turn an on light off.
  queue_presses(steps, esphome::millis(), mask, up ? kBrighter : kDimmer, kLevels - 1);
  start_sequence(label + (up ? " brighter" : " dimmer"), std::move(steps));
}

// ---- away mode ----------------------------------------------------------
//
// While the "Away Mode" switch is on, each room's light comes on and goes off
// once an evening, at times drawn afresh each day inside its window (set at
// boot from home.json), so the house looks lived in. Neither direction trusts the light record: Warm turns
// a light on whatever it was doing, and Warm then Toggle always ends off.

struct AwayWindow {
  int on_from, on_to, off_from, off_to;  // minutes since midnight; on_from < 0: room left alone
};

inline std::vector<AwayWindow> &away_windows() {
  static std::vector<AwayWindow> w;
  return w;
}

inline esphome::switch_::Switch *&away() {
  static esphome::switch_::Switch *s = nullptr;
  return s;
}

struct AwayState {
  bool active = false;
  int day = -1;                  // day of year the plan is for
  std::vector<int> on, off;      // today's minute per room
  std::vector<bool> lit;         // what away mode last left each light at
};

inline AwayState &away_state() {
  static AwayState s;
  return s;
}

inline int pick_minute(int from, int to) {
  return from + (int) (esphome::random_uint32() % (uint32_t) (to - from + 1));
}

inline void away_light(size_t room, bool on) {
  ESP_LOGI("rf", "away: room %u light %s", (unsigned) room + 1, on ? "on" : "off");
  press(room, kWarm);
  if (on) return;
  // Into the running sequence rather than replacing it, which would drop its steps.
  std::string mask(rooms().size(), '0');
  mask[room] = '1';
  auto &seq = sequence();
  seq.steps.push_back({esphome::millis() + kLightOnMs, mask, kLightToggle});
  if (seq.label.empty()) seq.label = "Away";
}

// Called once a minute with the local time.
inline void away_tick(int hour, int minute, int day_of_year) {
  auto &a = away_state();
  bool enabled = away() != nullptr && away()->state;
  if (!enabled) {
    a.active = false;
    return;
  }
  auto &w = away_windows();
  size_t n = std::min(rooms().size(), w.size());
  if (!a.active) {
    // Just switched on: start from the light records, so lights left on are
    // switched off now and lights already off aren't flashed.
    a.active = true;
    a.lit.assign(n, false);
    for (size_t i = 0; i < n; i++) a.lit[i] = rooms()[i].light->state;
  }
  if (a.day != day_of_year) {
    a.day = day_of_year;
    a.on.assign(n, 0);
    a.off.assign(n, 0);
    for (size_t i = 0; i < n; i++) {
      if (w[i].on_from < 0) continue;
      a.on[i] = pick_minute(w[i].on_from, w[i].on_to);
      a.off[i] = pick_minute(w[i].off_from, w[i].off_to);
      ESP_LOGI("rf", "away: room %u today %02d:%02d-%02d:%02d", (unsigned) i + 1, a.on[i] / 60, a.on[i] % 60,
               a.off[i] / 60, a.off[i] % 60);
    }
  }
  int now = hour * 60 + minute;
  for (size_t i = 0; i < n; i++) {
    if (w[i].on_from < 0) continue;
    bool want = now >= a.on[i] && now < a.off[i];
    if (want == a.lit[i]) continue;
    away_light(i, want);
    a.lit[i] = want;
  }
}

// Command entity: "<rooms>|<action>|<nonce>". The nonce makes a repeated
// command a new value, so pressing the same button twice sends twice.
inline void command(const std::string &value) {
  auto p = split(value, '|');
  if (p.size() >= 2 && valid_action(p[1])) run_action(p[0], p[1]);
}

// Schedule entity: "<enabled>|<HHMM>|<days Mon..Sun>|<rooms>|<action>",
// e.g. "1|0730|1111100|0110|110101001" = weekdays 07:30, rooms 2+3, speed 3,
// or "1|0630|1111100|0100|WAKE". Empty means an unused slot.
inline void schedule_tick(const std::string &slot, int hour, int minute, int monday_first_day) {
  auto p = split(slot, '|');
  if (p.size() != 5 || p[0] != "1" || p[1].size() != 4 || p[2].size() != 7) return;
  if (p[1] != (hour < 10 ? "0" : "") + std::to_string(hour) + (minute < 10 ? "0" : "") + std::to_string(minute)) return;
  if (p[2][monday_first_day] != '1' || !valid_action(p[4])) return;
  run_action(p[3], p[4]);
}

}  // namespace noaton
