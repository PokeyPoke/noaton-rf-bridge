// RF Bridge page, served by the device (web_server js_include). Room tiles
// pick where a command goes; schedules are stored and run on the device.
//
// Talks to ESPHome's own web API: /events streams entity state, and the one
// write path is the Command text entity ("<rooms>|<action>|<nonce>"), which the
// firmware fans out to every selected room. An action is a 9-bit button field
// or one the firmware expands (LIGHTON, LIGHTOFF, FORCEOFF, DIMMEST, BRIGHTEST, WAKE,
// STOP). Each room's light state is a switch entity the firmware keeps; LIGHTON and
// LIGHTOFF toggle only rooms whose record differs. Schedules are text entities in
// "<on>|<HHMM>|<days Mon..Sun>|<rooms>|<action>" form. The Fans Disabled switch
// makes the firmware drop every fan button from here and schedules, and turns the wall
// switches' fan gang into a brightness ramp.

const CFG = /*CONFIG*/null;

const SHORT = {
  'Power': 'Off', 'Light toggle': 'Toggle', 'Light cool (blue)': 'Cool', 'Light warm (yellow)': 'Warm',
  'Light neutral (white)': 'White', 'LED brighter': 'Brighter', 'LED dimmer': 'Dimmer',
  'Breeze / natural wind': 'Breeze', 'F/R reverse': 'Reverse',
  'Timer 1H': '1 h', 'Timer 4H': '4 h', 'Timer 8H': '8 h',
};
const field = name => CFG.buttons.find(b => b.name === name).field;
const SPEEDS = [1, 2, 3, 4, 5, 6].map(n => field('Fan speed ' + n));
const POWER = field('Power');
const LIGHT_FIELDS = () => LIGHT.map(field);
const isFan = f => /^[01]{9}$/.test(f) && !LIGHT_FIELDS().includes(f);
const LIGHT = ['Light toggle', 'Light cool (blue)', 'Light warm (yellow)', 'Light neutral (white)', 'LED brighter', 'LED dimmer'];
const COLOURS = [['Light cool (blue)', '#bfe3ff'], ['Light warm (yellow)', '#ffb45e'], ['Light neutral (white)', '#fff']];
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const SEQUENCES = { LIGHTON: 'Light on', LIGHTOFF: 'Light off', FORCEOFF: 'Light force off', DIMMEST: 'Light dimmest', BRIGHTEST: 'Light brightest', WAKE: 'Wake-up (30 min)' };

function actionLabel(f) {
  if (SEQUENCES[f]) return SEQUENCES[f];
  if (f === POWER) return 'Fan off';
  const s = SPEEDS.indexOf(f);
  if (s >= 0) return 'Fan speed ' + (s + 1);
  const b = CFG.buttons.find(b => b.field === f);
  if (!b) return '?';
  if (b.name === 'Light toggle') return 'Light toggle';
  if (LIGHT.includes(b.name)) return 'Light ' + SHORT[b.name].toLowerCase();
  if (b.name.startsWith('Timer')) return 'Fan timer ' + SHORT[b.name];
  return SHORT[b.name] || b.name;
}

// ---------------------------------------------------------------- state

const S = {
  sel: load('sel', [true, false, false, false]),
  fanOpen: load('fanOpen', true),
  fans: CFG.rooms.map(() => ({ on: false, speed: 0 })),
  lights: CFG.rooms.map(() => false),
  fansOff: false,
  away: false,
  sched: Array(CFG.schedules).fill(''),
  clock: '', sequence: '', online: false, editing: null,
};
function load(k, d) { try { const v = JSON.parse(localStorage.getItem('rf.' + k)); return v ?? d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem('rf.' + k, JSON.stringify(v)); } catch (e) {} }

// An explicit empty body: the device's server answers 411 to a POST without a length.
const post = path => fetch(path, { method: 'POST', body: '' }).then(r => { if (!r.ok) throw new Error(r.status); });
const mask = sel => sel.map(b => (b ? '1' : '0')).join('');
const roomList = sel => sel.map((b, i) => (b ? i + 1 : 0)).filter(Boolean);
const roomsText = sel => {
  const r = roomList(sel);
  return !r.length ? 'No room picked' : r.length === CFG.rooms.length ? 'All rooms' : (r.length > 1 ? 'Rooms ' : 'Room ') + r.join(', ');
};

let nonce = 0;
async function send(f, label) {
  if (!roomList(S.sel).length && f !== 'STOP') return toast('Pick a room first');
  try {
    await post(`/text/Command/set?value=${encodeURIComponent(`${mask(S.sel)}|${f}|${Date.now() % 100000}${nonce++}`)}`);
    toast(f === 'STOP' ? 'Stopped' : `${label} → ${roomsText(S.sel)}`);
  } catch (e) { toast('Not sent — is the bridge online?'); }
}

function connect() {
  const es = new EventSource('/events');
  const onState = ev => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    const [domain, name] = [d.id.slice(0, d.id.indexOf('/')), d.id.slice(d.id.indexOf('/') + 1)];
    if (domain === 'fan') {
      const i = CFG.rooms.findIndex(r => name === r + ' Fan');
      if (i >= 0) S.fans[i] = { on: d.state === 'ON', speed: d.speed_level || 0 };
    } else if (domain === 'switch' && name === 'Fans Disabled') {
      S.fansOff = d.state === 'ON';
    } else if (domain === 'switch' && name === 'Away Mode') {
      S.away = d.state === 'ON';
    } else if (domain === 'switch') {
      const i = CFG.rooms.findIndex(r => name === r + ' Light');
      if (i >= 0) S.lights[i] = d.state === 'ON';
    } else if (domain === 'text' && name.startsWith('Schedule ')) {
      S.sched[+name.slice(9) - 1] = d.value ?? '';
    } else if (domain === 'text_sensor' && name === 'Clock') {
      S.clock = d.value;
    } else if (domain === 'text_sensor' && name === 'Sequence') {
      S.sequence = d.value;
    } else return;
    if (!S.editing) render();   // a re-render would close an open picker mid-edit
  };
  es.addEventListener('state', onState);
  es.addEventListener('state_detail_all', onState);
  es.onopen = () => { S.online = true; render(); };
  es.onerror = () => { S.online = false; render(); };
}

// ---------------------------------------------------------------- view

const h = (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? v[i] : ''), '');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The selected rooms' common value, or null when they differ or none is picked.
function common(values) {
  const picked = values.filter((_, i) => S.sel[i]);
  return picked.length && picked.every(v => v === picked[0]) ? picked[0] : null;
}
const fanText = f => (f.on ? 'Fan ' + f.speed : 'Fan off');

function header() {
  return h`
  <div class="hd"><h1>RF Bridge</h1>
    <span class="on-l"><span class="dot${S.online ? '' : ' off'}"></span>${S.online ? 'Connected' : 'Offline'}</span></div>
  ${S.sequence ? h`<div class="ban"><span>Running: ${esc(S.sequence)}</span><button class="stop" data-send="STOP">Stop</button></div>` : ''}`;
}

function rooms() {
  return h`
  <div class="sec"><div class="lab c-r">Rooms <button data-act="all">${S.sel.every(Boolean) ? 'None' : 'All'}</button></div>
    <div class="keys">
      ${CFG.rooms.map((r, i) => h`
      <button class="key${S.sel[i] ? ' sel' : ''}" data-act="room" data-i="${i}" aria-pressed="${S.sel[i]}">
        <i class="${S.lights[i] ? 'lit' : ''}"></i>
        <b>${esc(r)}</b><span>${fanText(S.fans[i])} · ${S.lights[i] ? 'Light on' : 'Light off'}</span></button>`).join('')}
    </div></div>`;
}

function light() {
  const lt = common(S.lights);
  return h`
  <div class="sec"><div class="lab c-l">Light</div>
    <div class="plate">
      <div class="row2">
        <div class="rock big"><button class="${lt === true ? 'on' : ''}" data-send="LIGHTON">On</button>
          <button data-send="LIGHTOFF">Off</button></div>
        <div class="rock sm"><button data-send="${field('LED brighter')}"><span class="arrow">▲</span>Brighter</button>
          <button data-send="${field('LED dimmer')}"><span class="arrow">▼</span>Dimmer</button></div>
      </div>
      <div class="col3">${COLOURS.map(([n, c]) => h`<button class="ck" data-send="${field(n)}"><i style="background:${c}"></i>${SHORT[n]}</button>`).join('')}</div>
      <div class="util"><button data-send="${field('Light toggle')}">Toggle</button>
        <button data-send="BRIGHTEST">Brightest</button><button data-send="DIMMEST">Dimmest</button></div>
      <div class="fix"><p>Light state looks wrong? Force off sends Warm, then Toggle 2 s later, and resets the record to off.</p>
        <button class="fo" data-send="FORCEOFF">Force off</button></div>
    </div></div>`;
}

function fan() {
  const sp = common(S.fans.map(f => (f.on ? f.speed : 0)));
  const big = sp === null ? '–' : sp === 0 ? 'Off' : sp;
  const lock = S.fansOff;
  return h`
  <div class="fan${S.fanOpen ? ' open' : ''}${lock ? ' locked' : ''}">
    <div class="fh">
      <button class="fh-t" data-act="fan" aria-expanded="${S.fanOpen}">
        <span class="k">Fan</span><span class="n${sp === 0 ? ' word' : ''}">${big}</span>
        <span class="s">${lock ? 'All fans disabled' : roomsText(S.sel)}<br>tap to ${S.fanOpen ? 'close' : 'open'}</span></button>
      ${lock ? '<button class="q en" data-act="lock" data-v="0">Enable</button>' : h`<button class="q" data-send="${POWER}">Off</button>`}
      <button class="chev-b" data-act="fan" aria-label="${S.fanOpen ? 'Close' : 'Open'}"><i class="chev"></i></button>
    </div>
    ${S.fanOpen ? h`
    <div class="fb">
      <div class="num"><button class="sm" data-send="${POWER}">Off</button>
        ${SPEEDS.map((f, i) => h`<button class="${sp === i + 1 ? 'on' : ''}" data-send="${f}">${i + 1}</button>`).join('')}</div>
      <div><div class="sub">Mode</div><div class="pair">
        <button class="kk" data-send="${field('Breeze / natural wind')}">Breeze</button>
        <button class="kk" data-send="${field('F/R reverse')}">Reverse</button></div></div>
      <div><div class="sub">Fan timer</div><div class="tri">
        ${['Timer 1H', 'Timer 4H', 'Timer 8H'].map(n => h`<button class="kk" data-send="${field(n)}">${SHORT[n]}</button>`).join('')}</div></div>
      <div class="fix"><p>${lock ? 'All fans are disabled: fan buttons here and fan schedules do nothing. A wall switch\'s fan side dims the light instead: tap to start, tap again to stop; each ramp goes the other way.'
        : 'Disable all fans: fan buttons here and fan schedules will do nothing, and a wall switch\'s fan side will dim the light instead. Handheld remotes still work.'}</p>
        <button class="fo" data-act="lock" data-v="${lock ? 0 : 1}">${lock ? 'Enable fans' : 'Disable all'}</button></div>
    </div>` : ''}
  </div>`;
}

// Away mode runs on the bridge (noaton::away_tick); the page only switches it.
function away() {
  return h`
  <div class="sec"><div class="lab c-s">Away mode</div>
    <div class="aw"><p>${S.away ? 'On: every evening each light comes on and goes off once, at times that change daily' + (CFG.away ? ` (${CFG.away}).` : '.')
      : 'While you\'re out, each light comes on and goes off once every evening, at times that change daily. Switching it on turns off lights that are on.'}</p>
      <div class="mr" aria-label="Away mode ${S.away ? 'on' : 'off'}">
        <button class="${S.away ? 'on' : ''}" data-act="away" data-v="1">ON</button>
        <button class="${S.away ? '' : 'on'}" data-act="away" data-v="0">OFF</button></div></div></div>`;
}

function parseSlot(v) {
  const p = (v || '').split('|');
  if (p.length !== 5) return null;
  return { on: p[0] === '1', time: p[1].slice(0, 2) + ':' + p[1].slice(2), days: [...p[2]].map(c => c === '1'),
           rooms: [...p[3]].map(c => c === '1'), field: p[4] };
}
const slotValue = s => `${s.on ? 1 : 0}|${s.time.replace(':', '')}|${mask(s.days)}|${mask(s.rooms)}|${s.field}`;

function daysText(d) {
  const m = mask(d);
  if (m === '1111111') return 'Every day';
  if (m === '1111100') return 'Weekdays';
  if (m === '0000011') return 'Weekends';
  return d.map((on, i) => (on ? DAY_NAMES[i] : '')).filter(Boolean).join(' ') || 'No days';
}

// The editor opens under the row it edits; a new schedule's editor sits in place of Add.
function schedules() {
  const used = S.sched.map((v, i) => [parseSlot(v), i]).filter(([s]) => s)
    .sort((a, b) => a[0].time.localeCompare(b[0].time));
  const free = S.sched.findIndex(v => !parseSlot(v));
  const adding = S.editing && !parseSlot(S.sched[S.editing.slot]);
  return h`
  <div class="sec"><div class="lab c-s">Schedules <span class="clock">${esc(S.clock || '…')}</span></div>
    <div class="list">
      ${used.length ? '' : '<p class="empty">No schedules yet.</p>'}
      ${used.map(([s, i]) => h`
      <div class="row${s.on ? '' : ' paused'}">
        <button class="tm" data-act="edit" data-i="${i}">${s.time}</button>
        <button class="tx" data-act="edit" data-i="${i}"><b>${esc(actionLabel(s.field))}</b>
          <span>${daysText(s.days)} · ${roomsText(s.rooms)}</span></button>
        <div class="mr" aria-label="${s.on ? 'Enabled' : 'Paused'}">
          <button class="${s.on ? 'on' : ''}" data-act="sw" data-i="${i}" data-v="1">ON</button>
          <button class="${s.on ? '' : 'on'}" data-act="sw" data-i="${i}" data-v="0">OFF</button></div>
      </div>
      ${S.editing && S.editing.slot === i ? editor() : ''}`).join('')}
    </div>
    ${adding ? editor() : S.editing ? '' : free >= 0 ? '<button class="add" data-act="add">Add schedule</button>'
      : `<p class="empty">All ${CFG.schedules} slots used.</p>`}
  </div>`;
}

function editor() {
  const e = S.editing;
  const opts = [['Fan', [['Fan off', POWER], ...SPEEDS.map((f, i) => ['Fan speed ' + (i + 1), f]),
                         ...['Breeze / natural wind', 'F/R reverse', 'Timer 1H', 'Timer 4H', 'Timer 8H'].map(n => [actionLabel(field(n)), field(n)])]],
                ['Light', [...Object.entries(SEQUENCES).map(([k, l]) => [l, k]),
                           ...LIGHT.map(n => [actionLabel(field(n)), field(n)])]]];
  const pick = (vals, act, labels) => vals.map((on, i) =>
    h`<button class="${on ? 'on' : ''}" data-act="${act}" data-i="${i}" aria-pressed="${on}">${labels[i]}</button>`).join('');
  return h`
  <div class="editor">
    <div class="sub">Time</div>
    <input type="time" id="e-time" value="${e.time}">
    <div class="sub">Days</div>
    <div class="pick">${pick(e.days, 'eday', DAYS)}</div>
    <div class="sub">Rooms</div>
    <div class="pick">${pick(e.rooms, 'eroom', CFG.rooms.map((r, i) => String(i + 1)))}</div>
    <div class="sub">Do</div>
    <select id="e-field">${opts.map(([g, list]) => h`<optgroup label="${g}">${list.map(([l, f]) =>
      h`<option value="${f}"${f === e.field ? ' selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')}</select>
    ${e.field === 'WAKE' ? '<p class="note">Turns the light on (Toggle, only if recorded as off), goes to dimmest, then brightens one level every ~4 min until full after 30 min.</p>' : ''}
    <div class="acts">
      ${parseSlot(S.sched[e.slot]) ? '<button class="fo" data-act="del">Delete</button>' : ''}
      <span class="grow"></span>
      <button class="kk" data-act="cancel">Cancel</button>
      <button class="kk save" data-act="save">Save</button>
    </div>
  </div>`;
}

function render() {
  const focus = document.activeElement && document.activeElement.id;
  if (S.editing) {   // keep unsaved editor inputs across live re-renders
    const t = document.getElementById('e-time'), f = document.getElementById('e-field');
    if (t) S.editing.time = t.value;
    if (f) S.editing.field = f.value;
  }
  document.getElementById('app').innerHTML = header() + rooms() + light() + fan() + away() + schedules();
  if (focus) document.getElementById(focus)?.focus();
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 2200);
}

// ---------------------------------------------------------------- events

async function saveSlot(i, value) {
  try { await post(`/text/Schedule ${i + 1}/set?value=${encodeURIComponent(value)}`); }
  catch (e) { toast('Not saved — is the bridge online?'); }
}

document.addEventListener('change', ev => { if (ev.target.id === 'e-field') render(); });

document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-send],[data-act]');
  if (!b) return;
  if (b.dataset.send && S.fansOff && isFan(b.dataset.send)) return toast('Fans are disabled');
  if (b.dataset.send) return send(b.dataset.send, actionLabel(b.dataset.send));
  const i = +b.dataset.i;
  switch (b.dataset.act) {
    case 'room': S.sel[i] = !S.sel[i]; save('sel', S.sel); break;
    case 'all': S.sel = S.sel.map(() => !S.sel.every(Boolean)); save('sel', S.sel); break;
    case 'lock': {
      const on = b.dataset.v === '1';
      try { await post(`/switch/Fans Disabled/${on ? 'turn_on' : 'turn_off'}`); S.fansOff = on; toast(on ? 'All fans disabled' : 'Fans enabled'); }
      catch (e) { toast('Not sent — is the bridge online?'); }
      break;
    }
    case 'away': {
      const on = b.dataset.v === '1';
      try { await post(`/switch/Away Mode/${on ? 'turn_on' : 'turn_off'}`); S.away = on; toast(on ? 'Away mode on' : 'Away mode off'); }
      catch (e) { toast('Not sent — is the bridge online?'); }
      break;
    }
    case 'fan': S.fanOpen = !S.fanOpen; save('fanOpen', S.fanOpen); break;
    case 'add': S.editing = { slot: S.sched.findIndex(v => !parseSlot(v)), on: true, time: '07:00',
                              days: [1, 1, 1, 1, 1, 0, 0].map(Boolean), rooms: [...S.sel], field: SPEEDS[2] }; break;
    // Tapping the row being edited closes its editor.
    case 'edit': S.editing = S.editing && S.editing.slot === i ? null : { slot: i, ...parseSlot(S.sched[i]) }; break;
    case 'eday': S.editing.days[i] = !S.editing.days[i]; break;
    case 'eroom': S.editing.rooms[i] = !S.editing.rooms[i]; break;
    case 'cancel': S.editing = null; break;
    case 'sw': {
      const s = parseSlot(S.sched[i]), on = b.dataset.v === '1';
      if (s.on === on) return;
      s.on = on; S.sched[i] = slotValue(s); saveSlot(i, S.sched[i]); break;
    }
    case 'del': S.sched[S.editing.slot] = ''; saveSlot(S.editing.slot, ''); S.editing = null; toast('Schedule deleted'); break;
    case 'save': {
      const e = S.editing;
      e.time = document.getElementById('e-time').value || e.time;
      e.field = document.getElementById('e-field').value;
      if (!e.days.some(Boolean)) return toast('Pick at least one day');
      if (!e.rooms.some(Boolean)) return toast('Pick at least one room');
      S.sched[e.slot] = slotValue(e); saveSlot(e.slot, S.sched[e.slot]); S.editing = null;
      toast('Schedule saved');
      break;
    }
  }
  render();
});

// ---------------------------------------------------------------- boot

document.title = 'RF Bridge';
document.head.insertAdjacentHTML('beforeend', `
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b2a33">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&display=swap">
<style>
  /* One dark palette. Without internet the font falls back to the system one. */
  :root { --bg:#0b2a33; --panel:#12414d; --key:#185566; --line:#2b7f90; --text:#f4fff9; --mute:#a4e6d6; --ink:#0b2a33;
          --ban:#175a4b; --dangerbg:#16414a; --r:#e98a78; --l:#e6c777; --f:#6fdcec; --s:#b4e78a; --banx:#e6c777;
          --danger:#ee9482; --dot:#b4e78a; color-scheme:dark; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html, body { margin:0; background:var(--bg); }
  body { font-family:'Inter Tight',system-ui,-apple-system,sans-serif; color:var(--text); }
  esp-app { display:none; }
  button { font:inherit; color:inherit; border:0; background:none; cursor:pointer; padding:0; text-align:left; }
  button:active { transform:scale(.97); }
  #app { max-width:430px; margin:0 auto; padding:20px 16px 40px; display:flex; flex-direction:column; gap:18px; }
  .c-r { color:var(--r) !important; } .c-l { color:var(--l) !important; } .c-s { color:var(--s) !important; }

  .hd { display:flex; justify-content:space-between; align-items:flex-start; padding-top:14px; position:relative; }
  .hd:before { content:""; position:absolute; top:0; left:0; right:0; height:6px; border-radius:3px;
               background:linear-gradient(90deg,var(--r),var(--l),var(--f),var(--s)); }
  h1 { margin:0; font-size:34px; line-height:.95; font-weight:800; letter-spacing:-1.4px; }
  .on-l { font-size:12px; font-weight:600; display:flex; align-items:center; gap:6px; margin-top:4px; color:var(--mute); }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dot); } .dot.off { background:var(--danger); }
  .ban { display:flex; align-items:center; justify-content:space-between; gap:10px; background:var(--ban); color:var(--banx);
         padding:2px 2px 2px 14px; font-size:13px; font-weight:600; border-radius:8px; margin-top:-4px; }
  .stop { background:var(--banx); color:var(--ban); padding:0 16px; min-height:44px; font-weight:700; text-align:center; border-radius:6px; font-size:13px; }

  .sec { border-top:1px solid var(--line); padding-top:8px; display:flex; flex-direction:column; gap:10px; }
  .lab { font-size:11px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; display:flex; justify-content:space-between;
         align-items:center; color:var(--mute); }
  .lab button { text-transform:none; letter-spacing:0; font-size:13px; font-weight:600; color:var(--r); min-height:44px; margin:-14px 0; padding:0 2px; }
  .clock { letter-spacing:0; text-transform:none; font-weight:600; }

  .keys { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .key { position:relative; min-height:60px; background:var(--key); border:1px solid var(--line); border-radius:10px; padding:9px 12px;
         display:flex; flex-direction:column; justify-content:center; gap:1px; }
  .key b { font-size:16px; font-weight:700; } .key span { font-size:12px; color:var(--mute); font-weight:500; }
  /* The corner dot is the room's light: lit when the bridge records it on. */
  .key i { position:absolute; top:10px; right:10px; width:8px; height:8px; border-radius:50%; background:var(--line); }
  .key i.lit { background:var(--l); box-shadow:0 0 8px var(--l); }
  .key.sel { background:var(--r); color:var(--ink); border-color:var(--r); box-shadow:0 4px 16px color-mix(in srgb,var(--r) 35%,transparent); }
  .key.sel span { color:var(--ink); opacity:.8; }
  .key.sel i { background:color-mix(in srgb,var(--ink) 25%,transparent); box-shadow:none; } .key.sel i.lit { background:var(--ink); }

  .plate { background:var(--panel); border-radius:14px; padding:10px; display:flex; flex-direction:column; gap:10px; }
  .row2 { display:grid; grid-template-columns:1.2fr 1fr; gap:10px; }
  .rock { background:var(--key); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  .rock button { min-height:50px; display:flex; align-items:center; justify-content:center; gap:8px; font-weight:700; }
  .rock button + button { border-top:1px solid var(--line); }
  .rock.big button { font-size:20px; } .rock.sm button { font-size:14px; font-weight:600; gap:6px; }
  .rock .on { background:var(--l); color:var(--ink); }
  .rock .arrow { font-size:11px; }
  .col3 { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .ck { min-height:48px; background:var(--key); border:1px solid var(--line); border-radius:10px; display:flex; align-items:center;
        justify-content:center; gap:8px; font-weight:600; font-size:14px; }
  .ck i { display:block; width:14px; height:14px; border-radius:50%; border:1px solid rgba(0,0,0,.25); }
  .util { display:grid; grid-template-columns:repeat(3,1fr); }
  .util button { min-height:44px; font-weight:600; font-size:13px; color:var(--l); text-align:center; }
  .fix { display:flex; align-items:center; justify-content:space-between; gap:10px; border-top:1px solid var(--line); padding-top:8px; }
  .aw { display:flex; align-items:center; gap:12px; }
  .aw p { margin:0; font-size:12px; line-height:1.45; color:var(--mute); flex:1; }
  .fix p { margin:0; font-size:11px; line-height:1.45; color:var(--mute); flex:1; }
  .fo { min-height:44px; padding:0 14px; border:1px solid var(--danger); color:var(--danger); font-weight:700; border-radius:10px;
        font-size:13px; white-space:nowrap; background:var(--dangerbg); text-align:center; }

  .fan { border-top:1px solid var(--line); }
  .fh { display:flex; align-items:center; gap:10px; min-height:60px; }
  .fh-t { flex:1; display:flex; align-items:center; gap:12px; min-height:60px; }
  .fh .k { font-size:11px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; width:34px; color:var(--f); }
  .fh .n { font-size:32px; font-weight:800; letter-spacing:-1.5px; line-height:1; color:var(--f); min-width:24px; }
  .fh .n.word { font-size:22px; letter-spacing:-.5px; }
  .fh .s { font-size:12px; color:var(--mute); flex:1; line-height:1.3; }
  .fh .q { min-height:44px; min-width:52px; border:1px solid var(--line); border-radius:10px; background:var(--key); font-weight:700;
           font-size:13px; text-align:center; }
  .chev-b { min-height:44px; min-width:28px; display:flex; align-items:center; justify-content:center; }
  .chev { width:9px; height:9px; border-right:2px solid var(--text); border-bottom:2px solid var(--text); transform:rotate(45deg); margin-top:-3px; }
  .open .chev { transform:rotate(-135deg); margin-top:3px; }
  .locked .fh .n, .locked .fb .num, .locked .fb .pair, .locked .fb .tri { opacity:.35; }
  .fh .q.en { border-color:var(--f); color:var(--f); }
  .fb { display:flex; flex-direction:column; gap:12px; padding:2px 0 4px; }
  .num { display:flex; gap:2px; }
  .num button { flex:1; min-height:48px; font-size:26px; font-weight:700; letter-spacing:-.5px; color:var(--mute); text-align:center;
                border-bottom:3px solid transparent; }
  .num button.sm { font-size:16px; letter-spacing:0; }
  .num button.on { color:var(--f); border-bottom-color:var(--f); }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:8px; } .tri { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .kk { min-height:44px; padding:0 14px; background:var(--key); border:1px solid var(--line); border-radius:10px; font-weight:600;
        font-size:14px; text-align:center; }
  .sub { font-size:11px; letter-spacing:1.2px; text-transform:uppercase; font-weight:700; color:var(--mute); margin-bottom:6px; }

  .row { display:flex; align-items:center; gap:12px; border-top:1px solid var(--line); padding:9px 0; }
  .list > .row:first-child { border-top:0; }
  .row.paused .tm, .row.paused .tx { opacity:.5; }
  .tm { font-size:24px; font-weight:700; letter-spacing:-.8px; width:70px; flex:none; min-height:44px; }
  .tx { flex:1; min-height:44px; } .tx b { display:block; font-size:14px; font-weight:600; } .tx span { font-size:12px; color:var(--mute); }
  .mr { display:flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; flex:none; background:var(--key); }
  .mr button { min-width:34px; min-height:44px; font-size:10px; font-weight:700; text-align:center; color:var(--mute); }
  .mr button.on { background:var(--s); color:var(--ink); }
  .add { min-height:46px; border:1px dashed var(--s); border-radius:10px; font-weight:700; font-size:14px; text-align:center; color:var(--s); }
  .empty { margin:0; font-size:13px; color:var(--mute); }

  .editor { background:var(--panel); border-radius:14px; padding:12px; margin:4px 0 8px; display:flex; flex-direction:column; gap:4px; }
  .editor .sub { margin:8px 0 2px; } .editor .sub:first-child { margin-top:0; }
  .editor input, .editor select { width:100%; font:inherit; font-size:16px; padding:10px 12px; min-height:44px; border-radius:10px;
                                  border:1px solid var(--line); background:var(--key); color:var(--text); }
  .pick { display:flex; gap:6px; }
  .pick button { flex:1; min-height:44px; border:1px solid var(--line); border-radius:10px; background:var(--key); font-weight:700;
                 font-size:14px; text-align:center; color:var(--mute); }
  .pick button.on { background:var(--s); border-color:var(--s); color:var(--ink); }
  .note { margin:6px 0 0; font-size:12px; line-height:1.45; color:var(--mute); }
  .acts { display:flex; gap:8px; align-items:center; margin-top:12px; } .grow { flex:1; }
  .kk.save { background:var(--s); border-color:var(--s); color:var(--ink); font-weight:700; }

  #toast { position:fixed; left:50%; bottom:24px; transform:translate(-50%,16px); opacity:0; background:var(--text); color:var(--bg);
           border-radius:14px; padding:8px 16px; font-size:13px; font-weight:700; transition:.2s; pointer-events:none; max-width:90vw;
           box-shadow:0 6px 24px rgba(0,0,0,.35); }
  #toast.show { opacity:1; transform:translate(-50%,0); }
</style>`);
document.body.insertAdjacentHTML('afterbegin', '<div id="app"></div><div id="toast" role="status"></div>');
render();
connect();
