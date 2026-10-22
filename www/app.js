/* ตัวควบคุมหลักของ "ไทยซับ" — จับภาพ → วิเคราะห์ → แปล → แสดงผล (ทั้งในแอปและบน PiP) */
(() => {
  const SETTINGS_KEY = 'thai-overlay-settings-v1';

  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.opentyphoon.ai/v1',
    model: 'typhoon-v2.5-30b-a3b-instruct',
    ocrEnabled: true,
    facesEnabled: true,
    asrSource: 'off',        // off | system | mic
    asrEverySec: 5,
    intervalSec: 4,
    maxWidth: 900,
    register: 'auto',
    addressTerm: '',
    keepTone: true,
    persona: 'ต้น',
    ttsEnabled: false,
    ttsRate: 0.5,
    mode: 'both',
  };

  const LOCAL = (window.LOCAL_CONFIG && typeof window.LOCAL_CONFIG === 'object') ? window.LOCAL_CONFIG : {};

  let settings = { ...DEFAULTS, ...(LOCAL.settings || {}) };
  if (LOCAL.apiKey) settings.apiKey = LOCAL.apiKey;

  const $ = (id) => document.getElementById(id);
  const Overlay = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LiveOverlayPlugin) || null;

  let overlayOn = false;
  let capturing = false;
  let analyzing = false;
  let inlineTimer = null;
  let lastOcrText = '';
  let lastSignature = '';
  let lastDisplayedLine = '';
  let lastAsrText = '';
  let lastFaces = [];
  let audioChunks = [];
  let audioLevel = 0;
  let micOn = false;
  let asrTimer = null;
  let lastAnalysisAt = 0;
  let frameHandler = null;

  /** ตัดบรรทัดที่เป็น "เสียงสะท้อน" ของซับที่เราวาดเองออกจากผล OCR
      (กันลูป: PiP ทับจอ → OCR เห็นซับไทยของเรา → แปลซ้ำไม่จบ) */
  function stripEcho(text, prev) {
    if (!prev) return text;
    const p = normText(prev);
    if (!p) return text;
    return String(text).split('\n').filter((line) => {
      const l = normText(line);
      if (!l) return false;
      if (l.includes(p) || p.includes(l)) return false;
      const set = new Set(l);
      let shared = 0;
      for (const ch of p) if (set.has(ch)) shared++;
      return shared / Math.max(p.length, 1) < 0.75;
    }).join('\n').trim();
  }

  function normText(s) {
    return String(s || '').replace(/\s+/g, '').toLowerCase();
  }

  /** ลายเซ็นของสถานะปัจจุบัน ใช้ตัดสินว่ามีอะไรเปลี่ยนจริงไหม (ประหยัด token) */
  function cueSignature(faces) {
    return (faces || []).map((f) =>
      [f.eyeOpen, f.browEyeGap, f.mouthOpen, f.mouthWide]
        .map((v) => (typeof v === 'number' ? v.toFixed(2) : '0')).join(',')
    ).join('|');
  }

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = { ...settings, ...JSON.parse(raw) };
    } catch (e) {}
    Memory.load();
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function applySettingsToUI() {
    $('apiKey').value = settings.apiKey || '';
    $('baseUrl').value = settings.baseUrl;
    $('model').value = settings.model;
    $('ocrEnabled').checked = !!settings.ocrEnabled;
    $('facesEnabled').checked = !!settings.facesEnabled;
    $('asrSource').value = settings.asrSource || 'off';
    $('asrEverySec').value = settings.asrEverySec || 5;
    $('btnMic').textContent = micOn ? 'หยุดไมโครโฟน' : 'เปิดไมโครโฟน';
    $('btnMic').classList.toggle('is-on', micOn);
    $('intervalSec').value = settings.intervalSec;
    $('maxWidth').value = settings.maxWidth;
    $('register').value = settings.register;
    $('addressTerm').value = settings.addressTerm || '';
    $('keepTone').checked = !!settings.keepTone;
    $('persona').value = settings.persona;
    $('ttsEnabled').checked = !!settings.ttsEnabled;
    $('ttsRate').value = settings.ttsRate;
    setMode(settings.mode || 'both');
    AI.apply({ baseUrl: settings.baseUrl, key: settings.apiKey, model: settings.model });
  }

  function bindSettings() {
    const map = {
      apiKey: 'apiKey', baseUrl: 'baseUrl', model: 'model',
      ocrEnabled: 'ocrEnabled', facesEnabled: 'facesEnabled',
      asrSource: 'asrSource', asrEverySec: 'asrEverySec',
      intervalSec: 'intervalSec', maxWidth: 'maxWidth',
      register: 'register', addressTerm: 'addressTerm', keepTone: 'keepTone',
      persona: 'persona', ttsEnabled: 'ttsEnabled', ttsRate: 'ttsRate',
    };
    for (const [id, key] of Object.entries(map)) {
      const el = $(id);
      if (!el) continue;
      const evt = el.type === 'checkbox' ? 'change' : (el.tagName === 'SELECT' ? 'change' : 'input');
      el.addEventListener(evt, () => {
        settings[key] = el.type === 'checkbox' ? el.checked : el.value;
        if (key === 'intervalSec') settings.intervalSec = Math.max(2, Number(el.value) || 4);
        if (key === 'maxWidth') settings.maxWidth = Math.max(320, Number(el.value) || 900);
        if (key === 'baseUrl' || key === 'model') AI.apply({ baseUrl: settings.baseUrl, model: settings.model });
        saveSettings();
      });
    }

    $('btnTestApi').addEventListener('click', async () => {
      const out = $('apiTestResult');
      out.textContent = 'กำลังทดสอบ…';
      try {
        const res = await AI.test();
        out.textContent = 'ผ่าน: ' + String(res).slice(0, 40);
        log('ทดสอบ API ผ่าน', 'ok');
      } catch (e) {
        out.textContent = 'ไม่ผ่าน: ' + e.message.slice(0, 80);
        log('ทดสอบ API ไม่ผ่าน: ' + e.message, 'err');
      }
    });

    $('btnClearMemory').addEventListener('click', () => {
      Memory.clear();
      renderCast();
      log('ล้างความจำตัวละครแล้ว', 'warn');
    });

    $('btnReset').addEventListener('click', () => {
      localStorage.removeItem(SETTINGS_KEY);
      Memory.clear();
      location.reload();
    });

    $('btnExport').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(Memory.state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'thai-overlay-memory.json';
      a.click();
    });
  }

  // ---------------------------------------------------------------- UI

  function setStatus(text, kind = '') {
    $('statusText').textContent = text;
    const dot = $('statusDot');
    dot.className = 'dot' + (kind ? ' is-' + kind : '');
  }

  function log(msg, kind = '') {
    const el = $('log');
    const t = new Date().toLocaleTimeString('th-TH', { hour12: false });
    const line = document.createElement('div');
    if (kind) line.className = kind;
    line.textContent = `[${t}] ${msg}`;
    el.appendChild(line);
    while (el.childElementCount > 120) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  function setMode(mode) {
    settings.mode = mode;
    document.querySelectorAll('.chip[data-mode]').forEach((c) => {
      c.classList.toggle('is-active', c.dataset.mode === mode);
    });
    saveSettings();
  }

  function showSubtitle(line, meta = {}, speak = false) {
    $('subSpeaker').textContent = meta.speaker || '';
    $('subText').textContent = line || '(ยังไม่มีข้อความ)';
    const badges = [];
    if (meta.emotion) badges.push(`<span class="badge emotion">${escapeHtml(meta.emotion)}</span>`);
    if (meta.register) badges.push(`<span class="badge register">${escapeHtml(meta.register)}</span>`);
    if (meta.role) badges.push(`<span class="badge">${escapeHtml(meta.role)}</span>`);
    $('subMeta').innerHTML = badges.join('');

    // ส่งไปแสดงบน PiP ด้วย
    const ov = Overlay();
    if (ov && overlayOn) {
      const metaText = [meta.speaker, meta.emotion].filter(Boolean).join(' · ');
      try { ov.setSubtitle({ text: line || '', meta: metaText, accent: '#f5c451' }); } catch (e) {}
    }
    if (speak && settings.ttsEnabled && line) {
      const ov2 = Overlay();
      if (ov2) { try { ov2.speak({ text: line, rate: Number(settings.ttsRate) }); } catch (e) {} }
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderCast() {
    const list = Memory.characterList();
    const box = $('castList');
    if (!list.length) { box.innerHTML = '<p class="muted">ยังไม่มีข้อมูล</p>'; }
    else {
      box.innerHTML = list.map((c) => `
        <div class="cast">
          <div class="cast-top">
            <span class="cast-name">${escapeHtml(c.name)}</span>
            <span class="cast-role">${escapeHtml(c.role || '')}</span>
          </div>
          <div class="cast-meta">
            ${c.ageHint ? `<span class="badge">${escapeHtml(c.ageHint)}</span>` : ''}
            ${c.emotion ? `<span class="badge emotion">${escapeHtml(c.emotion)}</span>` : ''}
            ${c.register ? `<span class="badge register">${escapeHtml(c.register)}</span>` : ''}
          </div>
          ${(c.lines || []).length ? `<div class="cast-lines">${c.lines.slice(-3).map(escapeHtml).join('<br>')}</div>` : ''}
        </div>`).join('');
    }

    const tl = $('timeline');
    const items = Memory.state.timeline.slice(-20).reverse();
    tl.innerHTML = items.length
      ? items.map((t) => `<div class="timeline-item"><b>${escapeHtml(t.speaker || '')}</b> ${escapeHtml(t.text)}</div>`).join('')
      : '<p class="muted">ยังไม่มีข้อมูล</p>';
  }

  // ---------------------------------------------------------------- วิเคราะห์

  function describeCues(faces) {
    if (!faces || !faces.length) return '';
    return faces.map((f, i) => {
      const bits = [];
      if (f.eyeOpen < 0.075) bits.push('ตาหรี่/หนับ');
      if (f.browEyeGap < 0.10) bits.push('คิ้วลง');
      if (f.mouthOpen > 0.13) bits.push('ปากเปิดกว้าง');
      if (f.mouthWide > 0.42 && f.mouthOpen < 0.09) bits.push('กำลังยิ้ม');
      return `คนที่ ${i + 1}: ${bits.join(', ') || 'นิ่ง'}${f.hint ? ' (' + f.hint + ')' : ''}`;
    }).join(' / ');
  }

  async function analyzeFrame(dataUrl, faces) {
    if (!settings.apiKey) { setStatus('ยังไม่ได้ใส่ API key', 'error'); return; }
    let ocrText = '';
    if (settings.ocrEnabled) {
      try {
        ocrText = await AI.ocr(dataUrl);
      } catch (e) {
        log('OCR ไม่สำเร็จ: ' + e.message.slice(0, 90), 'err');
      }
    }

    // ตัดซับที่เราวาดเองออก (กันลูปจาก PiP ที่ทับจอ)
    const cleaned = stripEcho(ocrText, lastDisplayedLine);
    const sig = cleaned + '::' + cueSignature(faces);
    if (cleaned === lastOcrText && sig === lastSignature) {
      log('ไม่มีอะไรเปลี่ยน — ข้ามรอบนี้', 'warn');
      return;
    }
    lastOcrText = cleaned;
    lastSignature = sig;

    await runTranslation({ ocrText: cleaned, asrText: '', faces });
  }

  /** เสียง → ข้อความ (ASR) แล้วเข้าสู่ขั้นตอนแปลเหมือนกัน */
  async function transcribeAudio() {
    if (analyzing || !settings.apiKey) return;
    const chunks = audioChunks.splice(0, audioChunks.length);
    if (!chunks.length) return;

    analyzing = true;
    const started = Date.now();
    try {
      const bytes = AI.concatWavChunks(chunks);
      if (!bytes) return;
      // แปลง Uint8Array -> base64
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      const wavBase64 = btoa(binary);

      const text = await AI.asr(wavBase64);
      if (!text) { log('ASR ได้คำว่าง', 'warn'); return; }
      if (text === lastAsrText) return;
      lastAsrText = text;
      log(`ASR (${Math.round((Date.now() - started) / 100) / 10}s): ${text.slice(0, 70)}`);
      await runTranslation({ ocrText: '', asrText: text, faces: lastFaces });
    } catch (e) {
      log('ASR ไม่สำเร็จ: ' + e.message.slice(0, 120), 'err');
    } finally {
      analyzing = false;
    }
  }

  /** ขั้นตอนแปล + จำบริบท (ใช้ร่วมกันทั้งเส้นทาง OCR และ ASR) */
  async function runTranslation({ ocrText = '', asrText = '', faces = [] }) {
    if (analyzing && !asrText) return;
    if (!settings.apiKey) { setStatus('ยังไม่ได้ใส่ API key', 'error'); return; }
    if (!ocrText && !asrText) return;
    analyzing = true;
    lastFaces = faces && faces.length ? faces : lastFaces;
    const started = Date.now();
    try {
      const prompt = Prompts.buildTranslatePrompt({
        ocrText,
        asrText,
        cues: (lastFaces || []).map((f) => ({
          eyeOpen: f.eyeOpen, browEyeGap: f.browEyeGap, mouthOpen: f.mouthOpen,
          mouthWide: f.mouthWide, faceTurn: f.faceTurn, hint: f.hint,
        })),
        characters: Memory.state.characters,
        recentLines: Memory.state.recentLines,
        register: settings.register,
        keepTone: settings.keepTone,
        mode: settings.mode,
        persona: settings.persona,
        addressTerm: settings.addressTerm,
      });

      const res = await AI.chatJSON(
        [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        { temperature: 0.55, max_tokens: 420 }
      );

      const line = Prompts.cleanLine(res.line || '', 180);
      const commentary = Prompts.cleanLine(res.commentary || '', 180);
      const speaker = (res.speaker || '').trim();

      // --- จำบริบทตัวละคร ---
      if (speaker && speaker !== 'ไม่ทราบ') {
        Memory.upsertCharacter(speaker, {
          role: res.role, ageHint: res.ageHint, emotion: res.emotion,
          register: res.register, line: line || commentary,
        });
      }
      if (res.memory) {
        Memory.note(res.memory, speaker);
        Memory.setSceneSummary(res.memory);
      }
      if (line) { Memory.addLine(line); Memory.note(line, speaker); }
      Memory.save();

      const shown = settings.mode === 'commentator' ? (commentary || line) : line || commentary;
      if (shown) lastDisplayedLine = shown;
      const meta = {
        speaker,
        emotion: res.emotion,
        register: res.register,
        role: res.role,
      };
      showSubtitle(shown, meta, true);

      const cuesText = describeCues(faces);
      log(
        `${Math.round((Date.now() - started) / 100) / 10}s · ${ocrText ? 'OCR ' + ocrText.slice(0, 40).replace(/\n/g, ' ') : 'ไม่มีข้อความ'}` +
        `${cuesText ? ' · ' + cuesText.slice(0, 60) : ''}` +
        `${shown ? ' → ' + shown.slice(0, 40) : ''}`
      );
      renderCast();
    } catch (e) {
      log('วิเคราะห์ไม่สำเร็จ: ' + e.message.slice(0, 140), 'err');
      setStatus('วิเคราะห์ไม่สำเร็จ', 'error');
    } finally {
      analyzing = false;
    }
  }

  // ---------------------------------------------------------------- จับภาพ

  function startCapture() {
    const ov = Overlay();
    if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }

    ov.startCapture({
      intervalMs: Math.max(1000, settings.intervalSec * 1000),
      maxWidth: Number(settings.maxWidth) || 900,
      rotation: 'auto',
      emitFaces: !!settings.facesEnabled,
    }).then(() => {
      capturing = true;
      $('btnCapture').textContent = 'หยุดจับหน้าจอ';
      $('btnCapture').classList.add('is-on');
      setStatus('กำลังจับหน้าจอ', 'live');
      log('เริ่มจับหน้าจอแล้ว', 'ok');
    }).catch((e) => {
      log('เริ่มจับหน้าจอไม่สำเร็จ: ' + (e.message || e), 'err');
      setStatus('จับหน้าจอไม่สำเร็จ', 'error');
    });

    if (frameHandler) frameHandler.remove();
    frameHandler = ov.addListener('frame', (ev) => {
      const d = ev || {};
      if (!d.jpeg) return;
      lastAnalysisAt = Date.now();
      const dataUrl = 'data:image/jpeg;base64,' + d.jpeg;
      analyzeFrame(dataUrl, d.faces || []);
    });
  }

  function stopCapture() {
    const ov = Overlay();
    if (frameHandler) { frameHandler.remove(); frameHandler = null; }
    if (ov) ov.stopCapture().catch(() => {});
    capturing = false;
    $('btnCapture').textContent = 'จับหน้าจอ';
    $('btnCapture').classList.remove('is-on');
    setStatus(overlayOn ? 'Overlay เปิดอยู่' : 'พร้อม');
    log('หยุดจับหน้าจอ');
  }

  // ---------------------------------------------------------------- โหมดคลิปในแอป

  let inlineCanvas = null;

  function startInlineLoop() {
    stopInlineLoop();
    inlineCanvas = document.createElement('canvas');
    const ctx = inlineCanvas.getContext('2d');
    const video = $('video');

    inlineTimer = setInterval(async () => {
      if (video.paused || !video.videoWidth) return;
      const scale = Math.min(1, (Number(settings.maxWidth) || 900) / video.videoWidth);
      inlineCanvas.width = Math.max(2, Math.round(video.videoWidth * scale));
      inlineCanvas.height = Math.max(2, Math.round(video.videoHeight * scale));
      ctx.drawImage(video, 0, 0, inlineCanvas.width, inlineCanvas.height);

      let dataUrl;
      try {
        dataUrl = inlineCanvas.toDataURL('image/jpeg', 0.62);
      } catch (e) {
        log('อ่านเฟรมจากวิดีโอไม่ได้ (CORS) — ใช้ไฟล์ในเครื่องแทน', 'warn');
        stopInlineLoop();
        return;
      }

      let faces = [];
      if (settings.facesEnabled) {
        const ov = Overlay();
        if (ov) {
          try {
            const res = await ov.analyzeFaces({ base64: dataUrl });
            faces = res.faces || [];
          } catch (e) {}
        }
      }
      analyzeFrame(dataUrl, faces);
    }, Math.max(2000, (Number(settings.intervalSec) || 4) * 1000));
  }

  function stopInlineLoop() {
    if (inlineTimer) clearInterval(inlineTimer);
    inlineTimer = null;
  }

  function bindVideo() {
    const video = $('video');

    const enterFullscreen = () => {
      document.body.classList.add('video-mode');
      const ov = Overlay();
      if (ov) { try { ov.setKeepAwake({ enabled: true }); } catch (e) {} }
    };
    const exitFullscreen = () => {
      document.body.classList.remove('video-mode');
      const ov = Overlay();
      if (ov) { try { ov.setKeepAwake({ enabled: false }); } catch (e) {} }
    };
    video.addEventListener('click', () => {
      if (document.body.classList.contains('video-mode')) exitFullscreen();
      else enterFullscreen();
    });

    $('btnLoadUrl').addEventListener('click', () => {
      const url = $('videoUrl').value.trim();
      if (!url) return;
      video.src = url;
      video.play().then(() => {
        startInlineLoop();
        enterFullscreen();
        setStatus('กำลังเล่นคลิปในแอป (แตะวิดีโอเพื่อออก)', 'live');
      }).catch((e) => log('เล่นคลิปไม่ได้: ' + e.message, 'err'));
    });

    $('videoFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      video.src = URL.createObjectURL(file);
      video.muted = false;
      video.play().then(() => {
        startInlineLoop();
        enterFullscreen();
        setStatus('กำลังเล่นไฟล์ในแอป (แตะวิดีโอเพื่อออก)', 'live');
      }).catch(() => {});
    });
  }

  // ---------------------------------------------------------------- เสียง → ASR

  function updateLevelMeter() {
    const el = $('audioLevel');
    if (!el) return;
    const pct = Math.round(Math.min(Math.max(audioLevel, 0), 1) * 100);
    const bars = '█'.repeat(Math.round(pct / 10)).padEnd(10, '·');
    el.textContent = `ระดับเสียง: ${bars} ${pct}%`;
  }

  function setupAudioListener() {
    const ov = Overlay();
    if (!ov) return;
    ov.addListener('audio', (ev) => {
      const d = ev || {};
      const want = settings.asrSource;
      if (want === 'off') return;
      if (d.source && d.source !== want) return;
      audioLevel = d.level || 0;
      updateLevelMeter();
      if (d.wav) {
        audioChunks.push(d.wav);
        if (audioChunks.length > 24) audioChunks.splice(0, audioChunks.length - 24);
      }
    });
  }

  function setupAsrTimer() {
    if (asrTimer) clearInterval(asrTimer);
    asrTimer = setInterval(() => {
      if (settings.asrSource === 'off') return;
      if (!audioChunks.length) return;
      transcribeAudio();
    }, Math.max(2000, (Number(settings.asrEverySec) || 5) * 1000));
  }

  async function toggleMic() {
    const ov = Overlay();
    if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }
    try {
      if (micOn) {
        await ov.stopMic();
        micOn = false;
        log('ปิดไมโครโฟน');
      } else {
        await ov.startMic();
        micOn = true;
        log('เปิดไมโครโฟนแล้ว', 'ok');
      }
      $('btnMic').textContent = micOn ? 'หยุดไมโครโฟน' : 'เปิดไมโครโฟน';
      $('btnMic').classList.toggle('is-on', micOn);
    } catch (e) {
      log('ไมโครโฟนไม่สำเร็จ: ' + (e.message || e), 'err');
    }
  }

  function bindWebMode() {
    $('btnOpenWeb').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }
      const url = $('webUrl').value.trim();
      if (!url) { log('ใส่ URL ก่อน', 'warn'); return; }
      try {
        await ov.openWeb({ url });
        log('เปิดเว็บในแอป: ' + url, 'ok');
        setStatus('เปิดเว็บในแอปแล้ว (ซับทับเต็มจอ)', 'live');
        // เปิดโหมดเว็บแล้วเริ่มจับหน้าจออัตโนมัติ เพื่อให้ OCR อ่านเนื้อหาได้
        if ($('webAutoCapture').checked && !capturing) {
          startCapture();
        }
      } catch (e) {
        log('เปิดเว็บไม่สำเร็จ: ' + (e.message || e), 'err');
      }
    });

    $('btnCloseWeb').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) return;
      try {
        await ov.closeWeb();
        log('ปิดหน้าเว็บแล้ว');
        setStatus(capturing ? 'กำลังจับหน้าจอ' : 'พร้อม');
      } catch (e) {}
    });
  }

  function bindOpenApp() {
    const run = async (url) => {
      const ov = Overlay();
      if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }
      if (!overlayOn) {
        log('แนะนำให้เปิด Overlay ก่อน เพื่อให้ซับลอยทับแอปอื่น', 'warn');
      }
      try {
        await ov.openApp({ url });
        log('เปิด: ' + url, 'ok');
        setStatus('สลับไปแอปอื่นแล้ว (PiP ลอยอยู่)', 'live');
      } catch (e) {
        log('เปิดไม่ได้: ' + (e.message || e), 'err');
      }
    };

    $('btnOpenApp').addEventListener('click', () => {
      const url = $('appUrl').value.trim();
      if (url) run(url);
      else log('ใส่ URL หรือ scheme ก่อน', 'warn');
    });

    document.querySelectorAll('#appPresets .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        $('appUrl').value = chip.dataset.scheme;
        run(chip.dataset.scheme);
      });
    });
  }

  function bindMirror() {
    $('btnMirror').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }
      try {
        const res = await ov.mirrorStart({ port: 8787 });
        const url = res.url || `http://${res.ip}:${res.port}`;
        $('mirrorUrl').textContent = url;
        try { await navigator.clipboard.writeText(url); } catch (e) {}
        log('จอที่สองพร้อมใช้: ' + url + ' (คัดลอกแล้ว — เปิดในเบราว์เซอร์ของจอที่สอง)', 'ok');
        setStatus('จอที่สองเปิดอยู่: ' + url, 'live');
        if (!capturing) startCapture();
      } catch (e) {
        log('เปิดจอที่สองไม่สำเร็จ: ' + (e.message || e), 'err');
      }
    });

    $('btnMirrorStop').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) return;
      try {
        await ov.mirrorStop();
        $('mirrorUrl').textContent = '';
        log('ปิดจอที่สองแล้ว');
      } catch (e) {}
    });
  }

  function bindLocalGame() {
    $('btnServe').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }
      try {
        const res = await ov.serveStart({ port: 8787, root: 'documents' });
        $('serveStatus').textContent = 'เซิร์ฟเวอร์พร้อม: ' + res.url + ' (โฟลเดอร์: ' + (res.root || '-') + ')';
        log('เปิดเซิร์ฟเวอร์ในเครื่องแล้ว: ' + res.url, 'ok');
      } catch (e) {
        log('เปิดเซิร์ฟเวอร์ไม่สำเร็จ: ' + (e.message || e), 'err');
      }
    });

    $('btnOpenGame').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }
      const path = $('gamePath').value.trim() || 'index.html';
      try {
        await ov.openGame({ path });
        log('เปิดเกมในแอป: ' + path, 'ok');
        setStatus('กำลังเล่นเกมในแอป (ซับทับเต็มจอ)', 'live');
      } catch (e) {
        log('เปิดเกมไม่สำเร็จ: ' + (e.message || e), 'err');
      }
    });
  }

  // ---------------------------------------------------------------- boot

  function bindUI() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
        document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + tab.dataset.tab));
      });
    });

    document.querySelectorAll('.chip[data-mode]').forEach((chip) => {
      chip.addEventListener('click', () => setMode(chip.dataset.mode));
    });

    $('btnQuickSettings').addEventListener('click', () => {
      document.querySelector('.tab[data-tab="settings"]').click();
    });

    $('btnOverlay').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) { log('ไม่พบ native plugin (ต้อง build บน iOS)', 'err'); return; }
      if (overlayOn) {
        ov.stopOverlay();
        overlayOn = false;
        $('btnOverlay').textContent = 'เปิด Overlay (PiP)';
        $('btnOverlay').classList.remove('is-on');
        setStatus(capturing ? 'กำลังจับหน้าจอ' : 'พร้อม');
        log('ปิด Overlay');
        return;
      }
      try {
        await ov.startOverlay();
        overlayOn = true;
        $('btnOverlay').textContent = 'ปิด Overlay';
        $('btnOverlay').classList.add('is-on');
        setStatus('Overlay เปิดอยู่ (ลอยเหนือแอปอื่นได้)', 'live');
        log('เปิด Overlay แล้ว — สลับไปเล่นเกมได้', 'ok');
      } catch (e) {
        log('เปิด Overlay ไม่สำเร็จ: ' + (e.message || e), 'err');
      }
    });

    $('btnCapture').addEventListener('click', () => {
      if (capturing) stopCapture(); else startCapture();
    });

    $('btnMic').addEventListener('click', toggleMic);

    $('btnOverlayHide').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) return;
      try {
        await ov.overlayHide();
        log('ซ่อนซับแล้ว — เล่นเกมเต็มจอได้', 'ok');
        $('btnOverlayHide').classList.add('is-on');
      } catch (e) { log('ซ่อนไม่สำเร็จ: ' + (e.message || e), 'err'); }
    });

    $('btnOverlayShow').addEventListener('click', async () => {
      const ov = Overlay();
      if (!ov) return;
      try {
        await ov.overlayShow();
        log('แสดงซับแล้ว');
        $('btnOverlayHide').classList.remove('is-on');
      } catch (e) { log('เปิดไม่สำเร็จ: ' + (e.message || e), 'err'); }
    });

    $('btnTts').addEventListener('click', () => {
      settings.ttsEnabled = !settings.ttsEnabled;
      saveSettings();
      $('btnTts').textContent = 'อ่านซับออกเสียง: ' + (settings.ttsEnabled ? 'เปิด' : 'ปิด');
      $('btnTts').classList.toggle('is-on', settings.ttsEnabled);
    });
  }

  function boot() {
    loadSettings();
    applySettingsToUI();
    bindSettings();
    bindUI();
    bindVideo();
    bindWebMode();
    bindOpenApp();
    bindMirror();
    bindLocalGame();
    renderCast();
    setupAudioListener();
    setupAsrTimer();
    updateLevelMeter();

    if (!settings.apiKey) {
      setStatus('ยังไม่ได้ใส่ API key — ไปที่แท็บตั้งค่า', 'error');
    } else {
      setStatus('พร้อม');
    }
    log('แอปเริ่มทำงาน', 'ok');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
