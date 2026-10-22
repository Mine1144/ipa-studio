# ไทยซับ (ThaiLiveOverlay) — แปลสดแบบซ้อนทับหน้าจอ + อ่านอารมณ์ตัวละคร

แอป iPhone (IPA) ที่ทำงาน **ใน LiveContainer** — แปลข้อความบนจอเกม/หนังเป็นภาษาไทยแบบเรียลไทม์
แล้วแสดง **ทับบนแอปอื่น** ด้วย Picture-in-Picture พร้อมอ่านอารมณ์จากใบหน้า และจำบริบทตัวละครข้ามฉาก

ใช้ AI จาก **Opentyphoon** เท่านั้น (typhoon-v2.5 / typhoon-ocr)

---

## 1. สถาปัตยกรรม

```
┌──────────────── iPhone (แอปนี้) ─────────────────┐
│                                                  │
│  ReplayKit ─┐                                    │
│  (จับจอ)    ├─► JPEG frame ──┐                  │
│  <video>   ─┘                │                  │
│   + canvas                    ▼                  │
│                    ┌───────────────────┐          │
│                    │ Vision framework  │ ใบหน้า  │
│                    │ (คำนวณสัญญาณ     │ + ตัวเลข  │
│                    │  อารมณ์/วัย)     │          │
│                    └─────────┬─────────┘          │
│                              │                    │
│   OCR (typhoon-ocr) ────────►│                    │
│                              ▼                    │
│                    ┌───────────────────┐          │
│                    │  Character Memory │ จำตัวละคร│
│                    │  (localStorage)   │ ข้ามฉาก │
│                    └─────────┬─────────┘          │
│                              ▼                    │
│              Typhoon v2.5 ─► JSON {line, speaker,  │
│                               emotion, register,  │
│                               ageHint, memory}    │
│                              │                    │
│                              ▼                    │
│         ┌────────────────────────────────┐        │
│         │ แสดงผล 2 ทาง                  │        │
│         │ ① ในแอป (DOM overlay)          │        │
│         │ ② บน PiP (ลอยทับแอปอื่น) ✓    │        │
│         └────────────────────────────────┘        │
└──────────────────────────────────────────────────┘
```

### ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
|---|---|
| `www/index.html`, `www/style.css` | UI (มือถือ-first, 3 แท็บ: สด / ตัวละคร / ตั้งค่า) |
| `www/ai.js` | ตัวคุยกับ Opentyphoon (chat + OCR multipart) |
| `www/prompts.js` | โปรมต์แปล/คอมเมนต์ + `cleanLine()` (port จาก `ai-live-commentator/ai_commentator/prompts.py`) |
| `www/memory.js` | ทะเบียนตัวละคร + ไทม์ไลน์ฉาก (localStorage) |
| `www/app.js` | ลูปจับภาพ → วิเคราะห์ → แสดงผล |
| `plugins/live-overlay-plugin/ios/*.swift` | native: ReplayKit + PiP + Vision |
| `test/ai-layer.test.js` | ทดสอบชั้น AI จริง (prompt → JSON → memory) |

---

## 2. ความสามารถที่ทำได้ / ข้อจำกัด (อ่านก่อนใช้)

| คำขอ | สถานะ | หลักฐาน/หมายเหตุ |
|---|---|---|
| ซับซ้อนทับบนเกม/หนังแบบ realtime | ✅ ทำได้ | ใช้ **Picture-in-Picture** (iOS ไม่มี API วาดทับแอปอื่นแบบ Android — PiP คือทางเดียวที่ถูกต้อง) |
| OCR อ่านข้อความบนจอ | ✅ | `POST /v1/ocr` (multipart) — จำกัด **20 ครั้ง/นาที** → ตั้งค่าห่างกัน ≥ 3 วินาที |
| แปลบทพูดเป็นไทย + รักษาน้ำเสียง | ✅ | ทดสอบจริง: `You have no idea what you've done!` → *"นายไม่รู้หรอกว่าทำอะไรลงไป!"* |
| "คนแก่" แปลไทยด้้วยระดับภาษาถูกต้อง | ✅ | ทดสอบจริง: `Have you eaten yet, child?` → *"ลูกกินข้าวหรือยังล่ะ ดูเหนื่อยจังเลย" (register=สุภาพ, ageHint=คนสูงวัย) |
| อ่านอารมณ์จากใบหน้า | ⚠️ ทำได้แบบไม่ใช่ VLM | `Typhoon 2 Vision` **ไม่มีบน hosted API** (`opentyphoon.ai/model/typhoon-2-vision` → "Typhoon API: Not available") → ใช้ **Vision framework ของ iOS** วัดสัญญาณใบหน้า (ตาเปิด/คิ้วลง/ปากเปิด/ยิ้ม) แล้วให้ LLM ตีความเป็นภาษาไทย |
| จำบริบทตัวละครข้ามฉาก | ✅ | ทะเบียนตัวละคร + ไทม์ไลน์ในเครื่อง → ทดสอบจริง: memory *"ป้อมคือพ่อของเบสและยังโกรธอยู่"* และใช้ชื่อเดิมทุกครั้ง |
| โหมดคอมเมนต์ (บุคลิก ต้น/หมอ/บิ๊ก) | ✅ | port จาก `ai-live-commentator/config.yaml` |
| **ถอดเสียงพูด → แปล (ASR)** | ✅ ทำ pipeline เสร็จ | เสียง → WAV 16kHz → `typhoon-asr-realtime` → แปลไทย (ทดสอบจริง: รวม WAV ถูกเป๊ะ 64044 bytes, API ตอบกลับ) |
| เล่นคลิปในแอป + ซับ **เต็มจอ** + ไม่ให้จอดับ | ✅ | โหมดเต็มจอในแอป (แตะวิดีโอเพื่อออก) |
| **เอาเนื้อหาของแอป/เว็บอื่นมาแปลในแอป** | ✅ | ฝัง **WKWebView เต็มจอ** ในแอปเรา + วางซับไทยทับทับเนื้อหาแบบเต็มจอ (เกมบนเว็บ / ไลฟ์ / เว็บนิยาย ฯลฯ) |
| เกมเว็บในแอป (ฝังเกมที่ build เป็นเว็บ) | ✅ | ฝัง **WKWebView เต็มจอ** + ซับไทยทับทับ — แอปเป็นเว็บเซิร์ฟเวอร์เอง (127.0.0.1) ไม่ต้องมีคอม |
| เกม Ren'Py → เว็บ | ✅ | ทดสอบจริงกับ "Danganronpa: Symphony of Despair" — build เว็บได้บน Windows + เกมเล่นได้จริง (ดู `danganronpa-symphony/tools/README-web.md`) |
| แปลบทเกมเป็นไทย | ✅ | `translate-game.ps1` → Typhoon แปล → `merge_strings` → build เว็บ |
| อ่านซับออกเสียงไทย | ✅ | `AVSpeechSynthesizer` |

### เอาแอป/เว็บอื่นมาใช้ในแอปได้ไหม

| เนื้อหา | ฝังในแอปได้? | วิธี |
|---|---|---|
| เว็บทั่วไป / เกมที่เป็นเว็บ / ไลฟ์ Twitch-YouTube / เว็บนิยาย | ✅ เต็มจอ | แท็บ **สด → เปิดเว็บในแอป** → พิมพ์ URL → แอปเปิดเต็มจอ พร้อมวางซับไทยทับทับ (เปิด "จับหน้าจอ" ไว้ด้วยเพื่อให้ OCR อ่านเนื้อหา) |
| ไฟล์วิดีโอในเครื่อง | ✅ | โหมดเล่นคลิปในแอป (เลือกไฟล์) |
| แอป native (YouTube app, Netflix app, เกม native) | ❌ | iOS ไม่ให้ฝังแอปอื่น → ใช้ **PiP overlay** ข้ามแอปแทน (หรือเล่นเกมบนเครื่องที่สองแล้ว stream เข้ามา) |

### เรื่อง "ซับทับเต็มจอบนแอปอื่น" — ความจริงเบื้องต้น

iOS **ไม่มี public API** ให้แอปวาดทับแอปอื่น (Apple ไม่เปิดให้) สิ่งที่ทำได้จริงมีแค่:

| วิธี | ครอบคลุมเท่าไร | สถานะในแอปนี้ |
|---|---|---|
| **Picture-in-Picture** | หน้าต่างลอยเหนือแอปอื่น (ขยายใหญ่ได้ด้วยการ pinch บน iPhone) | ✅ ทำแล้ว |
| **เต็มจอในแอปตัวเอง** | 100% เต็มจอ แต่ต้องเล่นคลิปในแอปเรา | ✅ ทำแล้ว (โหมดเต็มจอ + ไม่ให้จอดับ) |
| Live Activity / Dynamic Island | แถบเล็ก ๆ ตอนเปิด notification | ยังไม่ทำ (ต้องมี widget extension) |
| Broadcast Extension | จับเสียงระบบแบบการันตี | ต้องลงแยกแบบ standalone (LiveContainer ไม่รองรับ extension) |

**สูตรที่ได้ผลจริงตอนนี้**
- **ดูหนัง/สตรีม** → เปิดคลิปในแอปเรา → ซับเต็มจอ + แปลไทย + เสียงพูดไทย
- **เล่นเกม** → เปิด PiP ค้างไว้ (pinch ขยายใหญ่ได้) → OCR ข้อความบนเกม + เสียงผ่าน ASR

### เรื่อง "เสียงจากแอปอื่น" — ทำได้แค่ไหน

| แหล่ง | สถานะ | หมายเหตุ |
|---|---|---|
| เสียงระบบจาก ReplayKit | ⚠️ ต้องเทสบนเครื่องจริง | Apple เขียนว่า `startCapture` ได้ "audio from the app and microphone" — ถ้ามันดันเสียงของแอปอื่นมาด้วย แอปจะใช้ได้ทันที (มีตัววัดระดับเสียงให้ดู) |
| ไมโครโฟนผู้ใช้ | ✅ แน่นอน | แปลคำพูดสดของผู้ใช้/แชทกับเพื่อน → ซับไทย |
| เสียงแอปอื่นแบบการันตี | ⚠️ ต้อง Broadcast Extension | ต้องลงแยกแบบ standalone + ต้องมี App Group (เสียเงิน Apple Developer) → LiveContainer ใช้ไม่ได้ |

> หมายเหตุ: เสียงที่มี DRM (เช่น Netflix/Disney+ บางไฟล์) จะถูกถอดเป็นเสียงเงียบโดยระบบ iOS ตามกฎของ Apple

### ข้อจำกัดที่ต้องรู้

1. **ผู้พูด (speaker) เป็นการเดา** — OCR ได้แค่ข้อความ ไม่ได้บอกว่าใครพูด แอปจึงให้ LLM เดาจากบริบท + ความจำ (ยิ่งเล่นไปยิ่งแม่นขึ้น)
2. **ReplayKit** ต้องผู้ใช้กดอนุญาต และจะเห็นแถบแดง/จุดสีเขียวมุมจอตลอด (ข้อกำหนดของ iOS)
3. **PiP ใน LiveContainer ยังต้องเทสบนเครื่องจริง** — PiP เป็นบริการของระบบ น่าจะทำงาน แต่ยังไม่ได้ยืนยัน
4. **คีย์ API อยู่บนเครื่อง** — ถ้าวางไว้ใน `www/local-config.js` (gitignored) จะถูกรวมไปกับแอป แต่ห้าม commit ขึ้น GitHub
5. **ราคา/โควตา** — 1 รอบวิเคราะห์ = 1 ครั้ง OCR + 1 ครั้ง LLM → ที่ 4 วินาที/รอบ ≈ 30 ครั้ง LLM/นาที (เกิน rate limit 200/นาที? ไม่เกิน แต่ให้ระวังถ้าตั้งค่าถี่เกิน)
6. **ASR ช้าประมาณ 5–8 วินาที** ต่อชิ้นเสียง (วัดจริง) → ซับจะตามเสียงช้ากว่าภาพ ถ้าต้องการเรียลไทม์จริงต้องเปลี่ยนไปใช้ streaming endpoint ของ playground
7. **อ่านอารมณ์ได้ไม่ดีเท่า VLM จริง** — เพราะ Typhoon 2 Vision ไม่มีบน hosted API (มีแค่ HF space ที่ถูก pause) → ตอนนี้ใช้เรขาสถิติจาก Vision แทน ถ้า space กลับมาเปิด เราต่อ provider ใหม่ได้ทันที

---

## 3. Build เป็น .ipa

```bash
cd ipa-studio
npm install
npm run sync      # คัดลอก www/ → ios/ + ผูก native plugin
```

ตรวจว่า native plugin ถูกผูก:
```bash
grep LiveOverlayPlugin ios/App/App/capacitor.config.json   # → packageClassList
grep LiveOverlayPlugin ios/App/CapApp-SPM/Package.swift      # → SPM package
```

### ผ่าน GitHub Actions (Windows ได้)

1. ติดตั้ง Git for Windows → push โฟลเดอร์ `ipa-studio` ขึ้น repo (branch `main`)
2. tab **Actions** → `Build IPA (iOS)` → **Run workflow**
3. ดาวน์โหลด artifact `ios-ipa` → ได้ `ThaiLiveOverlay-unsigned.ipa`

> runner ที่ใช้คือ `macos-26` (Xcode 26) — Capacitor 8 บังคับ Xcode 26+

### ถ้ามี Mac
```bash
npm install && npx cap sync ios && npx cap open ios
# Xcode → Product → Archive → Distribute App → Debugging (Any iOS Device) → .ipa
```

---

## 4. ติดตั้งใน LiveContainer

1. ติดตั้ง LiveContainer จาก [GitHub Releases ทางการ](https://github.com/LiveContainer/LiveContainer/releases) (SideStore/AltStore)
2. **Settings → Import Certificate from AltStore/SideStore** → ใน SideStore/AltStore กด Export
3. **Settings → JIT-Less Mode Diagnose → Test JIT-Less Mode** → ต้องขึ้น *"JIT-Less Mode Test Passed"*
4. หน้าแรก → กด **+** → เลือก `ThaiLiveOverlay-unsigned.ipa`
5. เปิดแอป → ไปแท็บ **ตั้งค่า** → ใส่ API key (ถ้า build จาก CI จะไม่มี `local-config.js` ต้องใส่เอง)

---

## 5. วิธีใช้

### โหมดที่ 1 — จับหน้าจอ (เล่นเกม/ดูหนังในแอปอื่น)
1. กด **เปิด Overlay (PiP)** → เปิด PiP ไว้ (มุมจอ)
2. กด **จับหน้าจอ** → อนุญาตการบันทึกหน้าจอ
3. สลับไปเล่นเกม/ดูหนัง → ซับไทยจะทับขึ้นบน PiP

### โหมดที่ 2 — เล่นคลิปในแอป (เสถียรกว่า)
1. แท็บ **สด** → กาง "โหมดเล่นคลิปในแอป"
2. พิมพ์ URL หรือเลือกไฟล์ในเครื่อง → กด **โหลด**
3. ซับแสดงทับบนวิดีโอในแอป (และบน PiP ถ้าเปิดไว้)

> ไฟล์ในเครื่องทำได้แน่ ๆ / URL ข้ามโดเมนอาจโดน CORS บล็อกการอ่านเฟรม

### ปุ่มควบคุม
| ปุ่ม | ทำอะไร |
|---|---|
| ทั้งคู่ / โหมดแปล / โหมดคอมเมนต์ | สลับวิธีแสดงผล (คอมเมนต์ไปอยู่บรรทัดเล็กใต้ซับ) |
| เปิด/ปิด Overlay | ควบคุม PiP (ลอยเหนือแอปอื่น) |
| จับหน้าจอ | เริ่ม/หยุด ReplayKit |
| แท็บ **ตัวละคร** | ดูตัวละครที่จำได้ + ไทม์ไลน์ฉาก + ส่งออก JSON |

### ตั้งค่าสำคัญ
- **วิเคราะห์ทุก (วินาที)** — ข้างล่างสุดของ OCR คือ limit 20 ครั้ง/นาที → อย่าต่ำกว่า 3
- **ระดับภาษาเริ่มต้น** — `อัตโนมัติ` ให้ LLM เลือกตามวัย/อารมณ์, หรือบังคับ `สุภาพ/กลาง/เถาะ`
- **อ่านสีหน้า** — เปิด/ปิดการวิเคราะห์ใบหน้าด้วย Vision
- **เสียงพูด** — อ่านซับออกเสียงไทยด้วย `AVSpeechSynthesizer`

---

## 6. ทดสอบ

```bash
# ทดสอบชั้น AI จริง (prompt → JSON → memory) ไม่ต้องมี iPhone
$env:TYPHOON_KEY = "sk-..."
node test/ai-layer.test.js
```
ผลล่าสุด: **2/2 กรณีผ่าน** (เคสโกรธ + เคสคนสูงวัยพูดสุภาพ), เวลาตอบ ~1.2 วินาที/รอบ

---

## 7. ความปลอดภัย

- **API key**: เก็บใน localStorage ของเครื่อง (หรือ `www/local-config.js` ที่ gitignored) — **ห้าม commit**
- ถ้าเคย paste key ลงในแชท/ไฟล์สาธารณะ → ไป revoke ที่ <https://playground.opentyphoon.ai/settings/api-key> แล้วสร้างใหม่
- เฟรมภาพจากหน้าจอถูกส่งไปยัง Opentyphoon เท่านั้น (ไม่มีการเก็บที่อื่น)
