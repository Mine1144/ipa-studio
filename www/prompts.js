/* โปรมต์ทั้งหมด + ฟังก์ชันตัดข้อความให้เหมือนระบบ ai-live-commentator (Python) */
const Prompts = (() => {

  const PERSONAS = {
    'ต้น': {
      vibe: 'เป็นกันเอง ตลก เป็นมิตร ชอบเตือนเรื่องผิดพลาด',
      persona: "คุณคือ 'ต้น' ผู้แปลสดแบบเพื่อนร่วมทีม พูดไทยเป็นธรรมชาติ ใช้ภาษาพูดกลาง ๆ คลุกเครือ ชอบหัวเราะเบา ๆ",
      catchphrases: ['เฮ้ย!', 'ระวังนะ', 'เอาจริงๆ แล้วเรื่องยังไม่จบ'],
    },
    'หมอ': {
      vibe: 'วิเคราะห์เกมลึก พูดเป็นนักพูดในห้องวิเคราะห์ esports',
      persona: "คุณคือ 'หมอ' นักวิเคราะห์เกม วางเสียงเร็ว ใช้ศัพท์เทคนิค อธิบายสาเหตุ–ผลขัด และชี้จุดที่ควรปรับปรุง",
      catchphrases: ['เสียดาย', 'ตัดสินใจถูกแล้วล่ะ', 'จุดนี้คือ win condition'],
    },
    'บิ๊ก': {
      vibe: 'เสียงดัง ตื่นเต้น พูดสั้นมาก',
      persona: "คุณคือ 'บิ๊ก' คอมเมนเตอร์สตรีมตัวร้อน พูดตรง ๆ สั้น ๆ ตื่นเต้นเหมือนกำลังดูมวย แต่ยังสุภาพ",
      catchphrases: ['โหลหหห', 'วินวิน', 'พูดไม่ได้ผิดปาก'],
    },
  };

  /** ข้อความตัวละครที่จำได้ → บล็อกความจำสำหรับส่งให้โมเดล */
  function memoryBlock(characters) {
    const list = Object.values(characters || {});
    if (!list.length) return '(ยังไม่เคยเจอตัวละครใดเลย)';
    return list.slice(-8).map((c) => {
      const bits = [];
      if (c.role) bits.push(c.role);
      if (c.ageHint) bits.push(c.ageHint);
      if (c.emotion) bits.push(`ล่าสุด${c.emotion}`);
      const last = (c.lines || []).slice(-1)[0];
      const tail = last ? ` พูดว่า "${last}"` : '';
      return `- ${c.name}${bits.length ? ' (' + bits.join(', ') + ')' : ''}${tail}`;
    }).join('\n');
  }

  /** เรียกเป็นครั้งแล้วคิวเขียว */
  function recentBlock(recentLines, n = 6) {
    const list = (recentLines || []).slice(-n);
    if (!list.length) return '';
    return 'คุณเพิ่งพูดไปแล้ว (ห้ามซ้ำ):\n- ' + list.join('\n- ');
  }

  /** สร้าง system prompt สำหรับโหมดแปล + อารมณ์ + ความจำตัวละคร */
  function buildTranslatePrompt(opts) {
    const {
      ocrText = '',
      asrText = '',
      cues = [],
      characters = {},
      recentLines = [],
      register = 'auto',
      keepTone = true,
      mode = 'both',
      persona = 'ต้น',
      addressTerm = '',
      maxChars = 140,
    } = opts;

    const rules = [
      'คุณคือนักแปลและนักบรรยายสดภาษาไทย ทำงานกับข้อความ (OCR) และเสียงที่ถอดมา (ASR) จากเกมหรือหนังที่กำลังเล่นอยู่',
      '1. แปลข้อความ/คำพูดที่ได้ให้เป็นภาษาไทยที่พูดได้จริง ถ้าเป็นภาษาไทยอยู่แล้วให้คงความหมายไว้และปรับให้เข้ากับบริบท',
      '2. ห้ามเพิ่มข้อมูลที่ไม่มีในสิ่งที่ให้มา (ภาพ/เสียง) ห้ามแต่งเนื้อเรื่อง ถ้าอ่านไม่ออกให้ตอบ line เป็นค่าว่าง',
      '3. ' + (keepTone
        ? 'รักษาน้ำเสียงต้นฉบับให้แม่น: โกรธต้องโกรธ เศร้าต้องเศร้า ตลกต้องตลก'
        : 'ปรับน้ำเสียงให้อ่านง่ายเป็นธรรมชาติ'),
      '4. เลือกระดับภาษา (register) ตามอารมณ์และวัยของตัวละคร:',
      '   - คนสูงวัย/คนแก่: register = "สุภาพ" ใช้คำสุภาพ เรียกผู้อื่นด้วยคำรับขึ้น ใช้จังหวะพูดแบบผู้ใหญ่พูดกับลูก',
      '   - ผู้หญิงที่โกรธ: register = "กลาง" พูดตรงแต่ไม่หยาบคาย',
      '   - เด็ก/วัยรุ่น: register = "เถาะ"',
      register !== 'auto' ? `   - ผู้ใช้ตั้งค่า register เริ่มต้นไว้เป็น "${register}" ให้ยึดถ้าไม่ขัดกับบริบท` : '',
      '5. เลือก speaker ให้ตรงกับน้ำเสียงและวัยของผู้พูด:',
      '   - ข้อความที่สุภาพ/เรียกผู้อื่นด้วยคำรับขึ้น/ใช้ถ้อยคำเชิงวัย → เป็นคนสูงวัย ให้เลือกตัวละครที่เป็นคนสูงวัยในความจำ',
      '   - ข้อความดูดุ/หยาบคาย/ตะโกน → เป็นวัยรุ่นหรือวัยกลางคนที่ขี้โกรธ',
      '   - ถ้าไม่มีตัวละครไหนเข้ากัน ให้ตั้งชื่อใหม่ที่สั้นและเป็นธรรมชาติ และ isNewCharacter = true',
      '6. ตัวละครที่เคยเจอในความจำ ให้ใช้ชื่อเดิมเสมอ ห้ามเปลี่ยนสระ/ตัวสะกด',
      '7. register ต้องสอดคล้องกับวัยของ speaker: คนสูงวัย → "สุภาพ", วัยกลางคน → "กลาง", วัยรุ่น/เด็ก → "เถาะ"',
      '8. memory: ถ้าข้อความนี้เผยความสัมพันธ์ หรือเหตุการณ์ที่ต้องจำข้ามฉาก ให้เขียน 1 ประโยคสั้น ๆ (เช่น "ป้อมคือพ่อของเบสและยังโกรธอยู่") ถ้าไม่มีอะไรต้องจำให้ปล่อยเป็นค่าว่าง',
      '9. ตอบกลับเป็น JSON เท่านั้น ไม่มีข้อความอื่นนอก JSON',
      mode !== 'translate'
        ? `10. ถ้าเปิดโหมดคอมเมนต์ ให้ใส่ commentary ด้วย โดยพูดเป็นบุคลิก "${persona}" (${PERSONAS[persona]?.vibe || ''}) ไม่เกิน ${maxChars} ตัวอักษร`
        : '10. ปล่อย commentary เป็นค่าว่าง',
    ].filter(Boolean);

    const userParts = [];
    if (ocrText) userParts.push(`ข้อความที่อ่านได้จากภาพ (OCR):\n"""\n${ocrText}\n"""`);
    if (asrText) userParts.push(`เสียงที่ได้ยินและถอดออกมา (ASR):\n"""\n${asrText}\n"""`);
    if (cues && cues.length) {
      userParts.push('สัญญาณอารมณ์จากใบหน้า (ตัวเลขจาก Vision บนเครื่อง):\n' +
        cues.map((c, i) => `- คนที่ ${i + 1}: eyeOpen=${r(c.eyeOpen, 3)} browEyeGap=${r(c.browEyeGap, 3)} mouthOpen=${r(c.mouthOpen, 3)} mouthWide=${r(c.mouthWide, 3)} หันหน้า=${r(c.faceTurn, 2)} → ${c.hint || ''}`).join('\n'));
    } else {
      userParts.push('ไม่พบใบหน้าในภาพ');
    }
    userParts.push('ตัวละครที่จำได้ (ใช้ชื่อเดิมเสมอ):\n' + memoryBlock(characters));
    const recent = recentBlock(recentLines);
    if (recent) userParts.push(recent);
    if (addressTerm) userParts.push(`คำที่ผู้ใช้อยากให้ใช้เรียกอีกฝ่าย: "${addressTerm}"`);

    const schema = `ตอบเป็น JSON ตามรูปแบบนี้เท่านั้น:
{
  "line": "คำแปลภาษาไทย (ว่างได้ถ้าไม่มีข้อความให้แปล)",
  "speaker": "ชื่อผู้พูด (เดาจากบริบทได้ ถ้าไม่รู้ใช้ \\"ไม่ทราบ\\")",
  "isNewCharacter": false,
  "emotion": "อารมณ์ของผู้พูด เช่น โกรธ/เศร้า/ตกใจ/เหนื่อย/ยิ้ม/นิ่ง",
  "register": "สุภาพ|กลาง|เถาะ",
  "ageHint": "วัยโดยคร่าว เช่น วัยกลางคน/คนสูงวัย/วัยรุ่น/เด็ก (ว่างได้ถ้าไม่ชัด)",
  "role": "ความสัมพันธ์กับตัวเอก เช่น พ่อ/แม่/พี่ชาย/ศัตรู (ว่างได้)",
  "memory": "ข้อความที่ควรจำไว้ข้ามฉาก (สั้นมาก)",
  "commentary": "คอมเมนต์แบบคอมเมนเตอร์ (ว่างได้)"
}`;

    return {
      system: rules.join('\n'),
      user: userParts.join('\n\n') + '\n\n' + schema,
    };
  }

  /** prompt โหมดคอมเมนต์ล้วน (port จาก prompts.py) */
  function buildCommentaryPrompt({ trigger, timeline = '', recentLines = [], persona = 'ต้น', maxChars = 180 }) {
    const p = PERSONAS[persona] || PERSONAS['ต้น'];
    const catchPhrase = p.catchphrases?.length ? `\n- วลีที่ชอบตะโกนเอง: ${p.catchphrases.join(' / ')}` : '';
    const system = `${p.persona}

บริบท
- กำลังเล่น/ดูอยู่ ผู้ชมอาจมีแชทเข้ามา
- พูดไทยเป็นธรรมชาติ ใช้ศัพท์สแลงได้บ้าง${catchPhrase}

กฎเหล็ก
1. เขียนเป็นคำพูดที่พูดออกเสียงได้จริง ห้ามใส่วงเล็บวงเหลี่ยบ ห้ามเขียน (หัวเราะ) หรือ *ทำท่า*
2. ห้ามเริ่มด้วย "ได้เลย", "แน่นอน", "สำหรับ", "สวัสดีครับ"
3. ความยาวไม่เกิน ${maxChars} ตัวอักษร 1-2 ประโยค
4. พูดเรื่องที่เพิ่งเกิดขึ้น ไม่พูดซ้ำ ไม่เดาสิ่งที่ไม่มีในข้อมูล`;

    const ctx = [];
    if (timeline.trim()) ctx.push(`สิ่งที่เกิดขึ้นก่อนหน้านี้:\n${timeline.trim()}`);
    const recent = recentBlock(recentLines, 8);
    if (recent) ctx.push(recent);
    ctx.push(`สิ่งที่เพิ่งเกิดขึ้น:\n${trigger.trim()}`);
    ctx.push(`พูดเป็น '${persona}' (${p.vibe}) ตอนนี้ หนึ่งประโยค ไปเลย`);
    return { system, user: ctx.join('\n\n') };
  }

  function r(v, digits) {
    if (typeof v !== 'number') return '0';
    return Number(v.toFixed(digits)).toString();
  }

  /** ตัดของแปลก ๆ ที่ออกเสียงไม่ได้ (port จาก clean_line ใน prompts.py) */
  function cleanLine(text, maxChars = 180) {
    if (!text) return '';
    let t = String(text).trim();
    t = t.replace(/[\[\(\{][^\]\)\}]*?[\]\)\}]/g, '');           // วงเล็บวงเหลี่ยบ
    t = t.replace(/(\*\*|__|```|^[-*•]\s*|^\d+[.)]\s*)/gm, '');    // markdown
    t = t.replace(/["“”«»'"]{1,3}/g, '');                          // เครื่องหมายคำพูด
    t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu, ''); // อีโมจิ
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^(ได้เลย|แน่นอน|แน่นอนว่า|สำหรับ|เอาจริงๆ|เอาจริง|โอเค|ตามที่|certainly|sure|okay|ok)[,:：\s]*/i, '').trim();
    if (t.length > maxChars) {
      let cut = t.slice(0, maxChars);
      for (const sep of [' ', '.', '!', '?', '…']) {
        const idx = cut.lastIndexOf(sep);
        if (idx > maxChars * 0.5) { cut = cut.slice(0, idx); break; }
      }
      t = cut.trim();
    }
    return t.length >= 4 ? t : '';
  }

  return { PERSONAS, buildTranslatePrompt, buildCommentaryPrompt, cleanLine, memoryBlock };
})();
