/* ตัวคุยกับ Opentyphoon API (OpenAI-compatible)
   - chat/completions : https://api.opentyphoon.ai/v1/chat/completions
   - OCR (multipart)   : https://api.opentyphoon.ai/v1/ocr   (จำกัด 20 ครั้ง/นาที) */
const AI = (() => {
  const cfg = {
    baseUrl: 'https://api.opentyphoon.ai/v1',
    key: '',
    model: 'typhoon-v2.5-30b-a3b-instruct',
    ocrModel: 'typhoon-ocr',
  };

  function apply(patch) { Object.assign(cfg, patch || {}); }

  function authHeaders() {
    if (!cfg.key) throw new Error('ยังไม่ได้ใส่ API key');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` };
  }

  /** เรียก chat แบบไม่ stream — ใช้กับงานที่ต้องการผลลัพธ์ครบก่อน */
  async function chat(messages, opts = {}) {
    const body = {
      model: opts.model || cfg.model,
      messages,
      temperature: opts.temperature ?? 0.6,
      top_p: opts.top_p ?? 0.95,
      max_tokens: opts.max_tokens ?? 400,
      repetition_penalty: opts.repetition_penalty ?? 1.05,
      stream: false,
    };
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text.slice(0, 220)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? '';
    return { content, raw: json };
  }

  /** เรียก chat แล้วบังคับให้เป็น JSON (โมเดลไทยตอบ JSON ได้ แต่ต้องมี fallback) */
  async function chatJSON(messages, opts = {}) {
    const { content } = await chat(messages, opts);
    const parsed = extractJSON(content);
    if (!parsed) throw new Error('โมเดลไม่ได้ตอบเป็น JSON: ' + content.slice(0, 160));
    return parsed;
  }

  /** ดึง object ทั้งก้อนจากข้อความที่อาจมี ```json ... ``` หรือมีข้อความนำหน้า */
  function extractJSON(text) {
    if (!text) return null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }

  /** OCR: ส่งภาพ (base64 data url) ไปอ่านข้อความบนจอ */
  async function ocr(dataUrl, opts = {}) {
    if (!cfg.key) throw new Error('ยังไม่ได้ใส่ API key');
    const blob = await (await fetch(dataUrl)).blob();
    const fd = new FormData();
    fd.append('file', blob, 'frame.jpg');
    fd.append('model', cfg.ocrModel);
    fd.append('max_tokens', String(opts.max_tokens ?? 700));
    fd.append('temperature', '0.1');
    fd.append('top_p', '0.95');
    fd.append('repetition_penalty', '1.05');

    const res = await fetch(`${cfg.baseUrl}/ocr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OCR ${res.status}: ${text.slice(0, 220)}`);
    }
    const json = await res.json();
    const raw = json?.results?.[0]?.message?.content ?? '';
    return parseOcrContent(raw);
  }

  /** เนื้อหา OCR คืนเป็น JSON string ที่มี natural_text */
  function parseOcrContent(raw) {
    if (!raw) return '';
    let text = raw;
    try {
      const obj = JSON.parse(raw);
      text = obj.natural_text || obj.text || obj.markdown || raw;
    } catch (_) {
      /* บางครั้งคืน markdown ตรง ๆ */
    }
    return String(text).trim();
  }

  /** ASR: ถอดเสียงพูดเป็นข้อความ
      รับ WAV (16kHz mono 16-bit) ที่ทำไว้ฝั่ง native — endpoint เป็น OpenAI-compatible */
  async function asr(wavBase64) {
    if (!cfg.key) throw new Error('ยังไม่ได้ใส่ API key');
    const bytes = base64ToBytes(wavBase64);
    const blob = new Blob([bytes], { type: 'audio/wav' });
    const fd = new FormData();
    fd.append('file', blob, 'chunk.wav');
    fd.append('model', cfg.asrModel || 'typhoon-asr-realtime');

    const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ASR ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    return String(json?.text ?? '').trim();
  }

  function base64ToBytes(b64) {
    const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** รวมไฟล์ WAV หลายชิ้น (16k mono 16bit) ให้เป็นไฟล์เดียว */
  function concatWavChunks(chunksB64) {
    const parts = [];
    let total = 0;
    for (const b64 of chunksB64) {
      const bytes = base64ToBytes(b64);
      if (bytes.length <= 44) continue;
      const pcm = bytes.subarray(44);
      parts.push(pcm);
      total += pcm.length;
    }
    if (!total) return null;

    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const ascii = (offset, s) => { for (let i = 0; i < s.length; i++) header[offset + i] = s.charCodeAt(i); };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + total, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, total, true);

    const out = new Uint8Array(44 + total);
    out.set(header, 0);
    let offset = 44;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }

  /** ทดสอบ key กับโมเดล */
  async function test() {
    const { content } = await chat(
      [{ role: 'user', content: 'ตอบว่า "ต่อมา" เท่านั้น' }],
      { max_tokens: 20, temperature: 0.1 }
    );
    return content;
  }

  return { cfg, apply, chat, chatJSON, ocr, asr, concatWavChunks, base64ToBytes, test, extractJSON };
})();
