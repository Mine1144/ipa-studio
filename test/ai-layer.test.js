/* ทดสอบชั้น AI จริง (ไม่ต้อง iOS) — ยืนยัน prompt + การ parse JSON + memory
   ใช้: node test/ai-layer.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const www = path.join(__dirname, '..', 'www');
const sandbox = { console, fetch, FormData, Blob, Date, JSON, Math, String, Number, Object, Array, Promise };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['ai.js', 'prompts.js', 'memory.js']) {
  vm.runInContext(fs.readFileSync(path.join(www, f), 'utf8'), sandbox, { filename: f });
}
const { AI, Prompts, Memory } = vm.runInContext('({ AI, Prompts, Memory })', sandbox);

const KEY = process.env.TYPHOON_KEY || '';

const SCENARIOS = [
  {
    name: 'A. โกรธ (คาดว่าเป็นพ่อที่เป็นคนสูงวัย)',
    ocr: "You have no idea what you've done!\nDon't come near me.",
    cues: [{ index: 0, box: [0.3, 0.2, 0.2, 0.3], eyeOpen: 0.05, browEyeGap: 0.06, mouthOpen: 0.16, mouthWide: 0.3, faceTurn: 0.1, hint: 'อาจกำลังโกรธ/หงุด' }],
    expect: {},
  },
  {
    name: 'B. คนสูงวัยพูดสุภาพ (คาดว่า register = สุภาพ)',
    ocr: 'Have you eaten yet, child? You look exhausted.',
    cues: [{ index: 0, box: [0.35, 0.15, 0.25, 0.35], eyeOpen: 0.09, browEyeGap: 0.14, mouthOpen: 0.05, mouthWide: 0.44, faceTurn: -0.05, hint: 'อาจกำลังยิ้ม' }],
    expect: { memory: true },
  },
];

(async () => {
  if (!KEY) { console.error('ตั้ง env TYPHOON_KEY ก่อน (หรือใส่ key ใน www/local-config.js)'); process.exit(2); }
  AI.apply({ baseUrl: 'https://api.opentyphoon.ai/v1', key: KEY, model: 'typhoon-v2.5-30b-a3b-instruct' });

  Memory.upsertCharacter('ป้อม', { role: 'พ่อ', ageHint: 'คนสูงวัย', emotion: 'โกรธ', register: 'สุภาพ', line: 'ลูกมึงทำอะไรของมึง' });
  Memory.upsertCharacter('เบส', { role: 'เพื่อนร่วมทีม', ageHint: 'วัยรุ่น', emotion: 'ตกใจ', line: 'เฮ้ย ระวัง!' });

  let pass = 0;
  for (const sc of SCENARIOS) {
    const p = Prompts.buildTranslatePrompt({
      ocrText: sc.ocr, cues: sc.cues,
      characters: Memory.state.characters,
      recentLines: Memory.state.recentLines,
      register: 'auto', keepTone: true, mode: 'both', persona: 'ต้น', maxChars: 140,
    });

    const t0 = Date.now();
    const res = await AI.chatJSON(
      [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
      { temperature: 0.55, max_tokens: 420 }
    );
    const ms = Date.now() - t0;

    const line = Prompts.cleanLine(res.line || '', 180);
    const commentary = Prompts.cleanLine(res.commentary || '', 180);

    console.log('\n============ ' + sc.name + ' (' + ms + ' ms) ============');
    console.log('OCR       :', sc.ocr.replace(/\n/g, ' | '));
    console.log('line      :', line);
    console.log('commentary:', commentary);
    console.log('speaker   :', res.speaker, '| emotion:', res.emotion, '| register:', res.register, '| age:', res.ageHint, '| role:', res.role);
    console.log('memory    :', res.memory || '(ว่าง)');

    const okSpeaker = !sc.expect.speaker || res.speaker === sc.expect.speaker;
    // register ต้องสอดคล้องกับวัยของตัวละครที่เลือก (สุภาพ↔คนสูงวัย, เถาะ↔วัยรุ่น, กลาง↔วัยกลางคน)
    const consistent = {
      'คนสูงวัย': 'สุภาพ', 'วัยรุ่น': 'เถาะ', 'วัยกลางคน': 'กลาง', 'เด็ก': 'เถาะ',
    };
    const expectedRegister = consistent[res.ageHint];
    const okRegister = !expectedRegister || res.register === expectedRegister;
    const okMemory = !sc.expect.memory || (res.memory || '').length > 0;

    console.log(`ตรวจ: speaker=${okSpeaker ? 'ผ่าน' : 'ไม่ผ่าน (' + res.speaker + ')'} ` +
      `register↔วัย=${okRegister ? 'ผ่าน' : 'ไม่ผ่าน (' + res.register + ' vs ' + res.ageHint + ')'} ` +
      `memory=${okMemory ? 'ผ่าน' : 'ว่าง'}`);
    if (okSpeaker && okRegister && okMemory) pass++;

    if (res.speaker) {
      Memory.upsertCharacter(res.speaker, {
        role: res.role, ageHint: res.ageHint, emotion: res.emotion, register: res.register, line: line || commentary,
      });
    }
    if (res.memory) Memory.note(res.memory, res.speaker);
  }

  console.log('\n--- ตัวละครที่จำได้หลัง 2 ฉาก ---');
  for (const c of Memory.characterList()) {
    console.log(`• ${c.name} | ${c.role || '-'} | ${c.ageHint || '-'} | ${c.emotion || '-'} | ${c.register || '-'}`);
  }
  console.log('\n--- ไทม์ไลน์ ---');
  console.log(Memory.timelineText());
  console.log(`\nผลผ่าน ${pass}/${SCENARIOS.length} กรณี`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

