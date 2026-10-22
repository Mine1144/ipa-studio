/* ทดสอบเส้นทางเสียง (ASR) + รวมไฟล์ WAV + แปลผ่าน LLM
   ใช้: node test/asr-layer.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const www = path.join(__dirname, '..', 'www');
const sandbox = { console, fetch, FormData, Blob, Date, JSON, Math, String, Number, Object, Array, Promise, atob, btoa };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['ai.js', 'prompts.js', 'memory.js']) {
  vm.runInContext(fs.readFileSync(path.join(www, f), 'utf8'), sandbox, { filename: f });
}
const { AI, Prompts } = vm.runInContext('({ AI, Prompts, Memory })', sandbox);

/** สร้าง WAV 16k mono 16bit 1 วินาที (เสียงทดสอบ) */
function makeToneWav(seconds = 1, freq = 220) {
  const sr = 16000, n = sr * seconds;
  const pcm = new Uint8Array(n * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) {
    view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 8000), true);
  }
  const header = new Uint8Array(44);
  const hv = new DataView(header.buffer);
  const ascii = (o, s) => { for (let i = 0; i < s.length; i++) header[o + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); hv.setUint32(4, 36 + pcm.length, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); hv.setUint32(16, 16, true); hv.setUint16(20, 1, true); hv.setUint16(22, 1, true);
  hv.setUint32(24, sr, true); hv.setUint32(28, sr * 2, true); hv.setUint16(32, 2, true); hv.setUint16(34, 16, true);
  ascii(36, 'data'); hv.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(header, 0); out.set(pcm, 44);
  return out;
}

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return Buffer.from(bin, 'binary').toString('base64');
}

(async () => {
  const KEY = process.env.TYPHOON_KEY || '';
  if (!KEY) { console.error('ตั้ง env TYPHOON_KEY ก่อน'); process.exit(2); }
  AI.apply({ baseUrl: 'https://api.opentyphoon.ai/v1', key: KEY });

  // --- 1) รวมไฟล์ WAV หลายชิ้น (สิ่งที่ native ส่งมาเป็นชิ้น 1 วินาที) ---
  const chunks = [toB64(makeToneWav(1, 220)), toB64(makeToneWav(1, 330))];
  const merged = AI.concatWavChunks(chunks);
  console.log('chunks:', chunks.length, '→ merged bytes:', merged ? merged.length : 0, '(ควร = 44 + 2*32000 =', 44 + 2 * 32000, ')');

  // --- 2) ยิง ASR ---
  const t0 = Date.now();
  const text = await AI.asr(toB64(merged));
  console.log('ASR ตอบ:', JSON.stringify(text), `(${Date.now() - t0} ms)`);

  // --- 3) แปลเสียงผ่าน LLM (จำลองว่า ASR ได้ประโยคภาษาอังกฤษ) ---
  const p = Prompts.buildTranslatePrompt({
    ocrText: '',
    asrText: 'You have no idea what you have done!',
    cues: [{ eyeOpen: 0.05, browEyeGap: 0.06, mouthOpen: 0.16, mouthWide: 0.3, faceTurn: 0.1, hint: 'อาจกำลังโกรธ/หงุด' }],
    characters: {}, recentLines: [], register: 'auto', keepTone: true, mode: 'both', persona: 'หมอ',
  });
  const res = await AI.chatJSON(
    [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
    { temperature: 0.55, max_tokens: 420 }
  );
  console.log('แปลจากเสียง →', JSON.stringify({
    line: res.line, speaker: res.speaker, emotion: res.emotion, register: res.register, ageHint: res.ageHint, memory: res.memory,
  }, null, 1));
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
