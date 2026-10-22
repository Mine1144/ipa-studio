/* ความจำตัวละคร + ไทม์ไลน์ฉาก (เก็บใน localStorage ของเครื่อง) */
const Memory = (() => {
  const KEY = 'thai-overlay-memory-v1';

  const state = {
    characters: {},   // name -> { id, name, role, ageHint, emotion, register, lines[], firstSeen, lastSeen }
    timeline: [],     // [{ ts, text, speaker }]
    recentLines: [],  // บรรทัดที่พูดไปแล้ว (กันพูดซ้ำ)
    sceneSummary: '',
    updatedAt: 0,
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(state, JSON.parse(raw));
    } catch (e) { /* เริ่มใหม่ถ้าพัง */ }
    return state;
  }

  function save() {
    state.updatedAt = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function clear() {
    state.characters = {};
    state.timeline = [];
    state.recentLines = [];
    state.sceneSummary = '';
    save();
  }

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

  /** เพิ่ม/อัปเดตตัวละคร (ใช้ชื่อเป็นกุญแจ) */
  function upsertCharacter(name, patch = {}) {
    const clean = String(name || '').trim();
    if (!clean || clean === 'ไม่ทราบ') return null;

    const key = Object.keys(state.characters).find((k) => norm(k) === norm(clean));
    const id = key || clean;
    const now = Date.now();

    if (!state.characters[id]) {
      state.characters[id] = {
        id, name: clean, role: '', ageHint: '', emotion: '', register: '',
        lines: [], firstSeen: now, lastSeen: now,
      };
    }
    const c = state.characters[id];
    // ชื่อที่โมเดลใช้ครั้งแรกคือชื่อที่ถูกต้อง (ห้ามสะกดใหม่)
    c.name = clean;
    if (patch.role) c.role = patch.role;
    if (patch.ageHint) c.ageHint = patch.ageHint;
    if (patch.emotion) c.emotion = patch.emotion;
    if (patch.register) c.register = patch.register;
    if (patch.line) {
      c.lines.push(patch.line);
      if (c.lines.length > 6) c.lines = c.lines.slice(-6);
    }
    c.lastSeen = now;
    return c;
  }

  /** จดไทม์ไลน์ (ไม่เกิน 40 รายการ) */
  function note(text, speaker = '') {
    if (!text) return;
    state.timeline.push({ ts: Date.now(), text: String(text).slice(0, 220), speaker });
    if (state.timeline.length > 40) state.timeline = state.timeline.slice(-40);
  }

  /** จดบรรทัดที่พูดไปแล้ว (กันซ้ำ) */
  function addLine(line) {
    if (!line) return;
    state.recentLines.push(line);
    if (state.recentLines.length > 24) state.recentLines = state.recentLines.slice(-24);
  }

  function setSceneSummary(text) {
    if (text) state.sceneSummary = String(text).slice(0, 400);
  }

  function timelineText(n = 12) {
    return state.timeline.slice(-n).map((t) => `- ${t.text}`).join('\n');
  }

  function characterList() {
    return Object.values(state.characters).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  return {
    state, load, save, clear, upsertCharacter, note, addLine,
    setSceneSummary, timelineText, characterList,
  };
})();
