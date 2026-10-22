import Foundation
import Capacitor
import AVFoundation
import AVKit
import ReplayKit
import UIKit
import Vision
import CoreImage
import CoreImage.CIFilterBuiltins

@objc(LiveOverlayPlugin)
public class LiveOverlayPlugin: CAPPlugin, CAPBridgedPlugin {

    public var identifier = "LiveOverlayPlugin"
    public var jsName = "LiveOverlayPlugin"
    public var pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startOverlay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopOverlay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "analyzeFaces", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openWeb", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeWeb", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openApp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mirrorStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mirrorStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "serveStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openGame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "overlayHide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "overlayShow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - State

    private let pip = SubtitlePiP()
    private let webOverlay = WebOverlayController()
    private let audioTap = AudioTap()
    private let mirror = MirrorServer()
    private var currentSubtitle: String = ""
    private var currentMeta: String = ""
    private var lastAudioLevel: Float = 0
    private var audioSource = "system"
    private var isCapturing = false
    private var lastEmitTime: CFTimeInterval = 0
    private var emitInterval: CFTimeInterval = 1.0
    private var maxWidth: CGFloat = 900
    private var rotationSetting = "auto"
    private var emitFaces = true

    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let speech = AVSpeechSynthesizer()

    // MARK: - Overlay (Picture-in-Picture)

    @objc func startOverlay(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try self.pip.start()
                call.resolve([
                    "started": true,
                    "supported": self.pip.isPossible
                ])
            } catch {
                call.reject("เปิด Overlay ไม่สำเร็จ: \(error.localizedDescription)")
            }
        }
    }

    /// ซ่อนหน้าต่าง PiP ชั่วคราว (ให้พื้นที่เล่นเกมเต็มจอ) แล้วเปิดกลับได้
    @objc func overlayHide(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pip.stop()
            call.resolve(["hidden": true])
        }
    }

    @objc func overlayShow(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try self.pip.start()
                self.pip.update(text: self.currentSubtitle, meta: self.currentMeta, accentHex: nil)
                call.resolve(["hidden": false])
            } catch {
                call.reject("เปิด Overlay ไม่สำเร็จ: \(error.localizedDescription)")
            }
        }
    }

    @objc func stopOverlay(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pip.stop()
            call.resolve(["stopped": true])
        }
    }

    @objc func setSubtitle(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let meta = call.getString("meta") ?? ""
        let accent = call.getString("accent")
        DispatchQueue.main.async {
            self.pip.update(text: text, meta: meta, accentHex: accent)
            self.currentSubtitle = text
            self.currentMeta = meta
            self.mirror.update(jpeg: nil, subtitle: text, meta: meta)
            // ถ้าเปิดโหมดเว็บอยู่ ให้แสดงซับทับเนื้อหาเต็มจอด้วย
            if self.webOverlay.isOpen {
                self.webOverlay.setSubtitle(text: text, meta: meta)
            }
            call.resolve(["ok": true])
        }
    }

    // MARK: - จอที่สอง (ส่งภาพเกม + ซับไทยไปจออื่นใน LAN)

    @objc func mirrorStart(_ call: CAPPluginCall) {
        let port = UInt16(call.getInt("port") ?? 8787)
        do {
            try mirror.start(port: port)
            let ip = MirrorServer.localIP()
            DispatchQueue.main.async {
                call.resolve([
                    "started": true,
                    "ip": ip,
                    "port": self.mirror.port,
                    "url": "http://\(ip):\(self.mirror.port)"
                ])
            }
        } catch {
            call.reject("เปิดจอที่สองไม่สำเร็จ: \(error.localizedDescription)")
        }
    }

    @objc func mirrorStop(_ call: CAPPluginCall) {
        mirror.stop()
        call.resolve(["stopped": true])
    }

    /// เปิดเว็บเซิร์ฟเวอร์ในเครื่อง เพื่อเสิร์ฟไฟล์เกมเว็บ (Ren'Py web build) ที่วางไว้ใน Files
    @objc func serveStart(_ call: CAPPluginCall) {
        let port = UInt16(call.getInt("port") ?? 8787)
        let rootKind = call.getString("root") ?? "documents"

        let root: URL?
        switch rootKind {
        case "bundle":
            root = Bundle.main.resourceURL
        case "documents":
            root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        default:
            root = URL(fileURLWithPath: rootKind)
        }

        mirror.setStaticRoot(root)
        do {
            try mirror.start(port: port)
            DispatchQueue.main.async {
                call.resolve([
                    "started": true,
                    "port": self.mirror.port,
                    "root": root?.path ?? "",
                    "url": "http://127.0.0.1:\(self.mirror.port)"
                ])
            }
        } catch {
            call.reject("เปิดเซิร์ฟเวอร์ไม่สำเร็จ: \(error.localizedDescription)")
        }
    }

    /// เปิดเกมเว็บที่อยู่ในเครื่อง (ผ่านเซิร์ฟเวอร์ในแอป) ใน WKWebView เต็มจอ + ซับทับ
    @objc func openGame(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? "index.html"
        if !mirror.isRunning {
            mirror.setStaticRoot(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
            try? mirror.start(port: 8787)
        }
        guard mirror.isRunning || mirror.port > 0 else {
            call.reject("เปิดเซิร์ฟเวอร์ไม่สำเร็จ")
            return
        }
        let url = URL(string: "http://127.0.0.1:\(mirror.port)/\(path)")!
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("ไม่พบหน้าต่างแอป")
                return
            }
            self.webOverlay.open(url: url, host: host)
            call.resolve(["opened": true, "url": url.absoluteString])
        }
    }

    // MARK: - โหมดเว็บในแอป (เอาเนื้อหาของแอป/เว็บอื่นมาแปลในแอปเรา)

    @objc func openWeb(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme != nil else {
            call.reject("URL ไม่ถูกต้อง")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("ไม่พบหน้าต่างแอป")
                return
            }
            self.webOverlay.open(url: url, host: host)
            call.resolve(["opened": true, "url": urlString])
        }
    }

    @objc func closeWeb(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.webOverlay.close()
            call.resolve(["closed": true])
        }
    }

    /// เปิดแอปอื่น/เว็บ (สลับออกจากแอปเรา) — PiP overlay ของเรายังลอยอยู่บนแอปนั้น
    @objc func openApp(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"),
              let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme != nil else {
            call.reject("URL ไม่ถูกต้อง")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                if ok {
                    call.resolve(["opened": true, "url": raw])
                } else {
                    call.reject("เปิดไม่ได้ (แอปนั้นอาจไม่ได้ติดตั้ง): \(raw)")
                }
            }
        }
    }

    // MARK: - Screen capture (ReplayKit)

    @objc func startCapture(_ call: CAPPluginCall) {
        if let interval = call.getDouble("intervalMs"), interval > 0 {
            emitInterval = Double(interval) / 1000.0
        }
        if let w = call.getDouble("maxWidth"), w > 0 {
            maxWidth = CGFloat(w)
        }
        rotationSetting = call.getString("rotation") ?? "auto"
        emitFaces = call.getBool("emitFaces") ?? true

        // iOS จะขออนุญาตเองตอนเริ่ม capture ครั้งแรก (ถ้ายังไม่อนุญาตจะได้ error กลับมา)
        DispatchQueue.main.async {
            self.beginCapture(call)
        }
    }

    private func beginCapture(_ call: CAPPluginCall) {
        let recorder = RPScreenRecorder.shared()
        recorder.isMicrophoneEnabled = false
        recorder.isCameraEnabled = false

        // เสียงที่ ReplayKit ส่งมา (ของแอปเรา/ระบบ) → ตัดเป็น WAV 1 วินาที
        audioTap.onChunk = { [weak self] wav, level in
            guard let self = self else { return }
            self.lastAudioLevel = level
            self.notifyListeners("audio", data: [
                "wav": wav.base64EncodedString(),
                "level": Double(level),
                "source": self.audioSource
            ])
        }

        recorder.startCapture(
            handler: { [weak self] (sampleBuffer, bufferType, error) in
                guard let self = self else { return }
                if let error = error {
                    self.notifyListeners("captureError", data: ["message": error.localizedDescription])
                    return
                }
                if bufferType == .video {
                    self.handleFrame(sampleBuffer)
                }
            },
            completionHandler: { error in
                if let error = error {
                    call.reject("เริ่มบันทึกหน้าจอไม่สำเร็จ: \(error.localizedDescription)")
                } else {
                    self.isCapturing = true
                    call.resolve(["started": true])
                }
            }
        )
    }

    @objc func stopCapture(_ call: CAPPluginCall) {
        RPScreenRecorder.shared().stopCapture { _ in
            self.isCapturing = false
            call.resolve(["stopped": true])
        }
    }

    // MARK: - ไมโครโฟน

    @objc func startMic(_ call: CAPPluginCall) {
        audioSource = "mic"
        audioTap.onChunk = { [weak self] wav, level in
            guard let self = self else { return }
            self.lastAudioLevel = level
            self.notifyListeners("audio", data: [
                "wav": wav.base64EncodedString(),
                "level": Double(level),
                "source": "mic"
            ])
        }
        do {
            try audioTap.startMic()
            call.resolve(["started": true])
        } catch {
            call.reject("เปิดไมโครโฟนไม่สำเร็จ: \(error.localizedDescription)")
        }
    }

    @objc func stopMic(_ call: CAPPluginCall) {
        audioTap.stopMic()
        audioSource = "system"
        call.resolve(["stopped": true])
    }

    private func handleFrame(_ sampleBuffer: CMSampleBuffer) {
        let now = CACurrentMediaTime()
        guard now - lastEmitTime >= emitInterval else { return }
        lastEmitTime = now

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let (image, orientation) = normalizedImage(from: pixelBuffer)
        guard let cgImage = image else { return }

        var faces: [FaceCue] = []
        if emitFaces {
            faces = FaceAnalyzer.analyze(cgImage: cgImage)
        }

        guard let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.62) else { return }

        // ส่งเฟรมไปจอที่สอง (ถ้าเปิดไว้)
        mirror.update(jpeg: jpeg, subtitle: currentSubtitle, meta: currentMeta)

        var payload: [String: Any] = [
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "jpeg": jpeg.base64EncodedString(),
            "width": Double(cgImage.width),
            "height": Double(cgImage.height)
        ]
        if emitFaces {
            payload["faces"] = faces.map { face -> [String: Any] in
                [
                    "index": face.index,
                    "box": face.box,
                    "eyeOpen": face.eyeOpen,
                    "browEyeGap": face.browEyeGap,
                    "mouthOpen": face.mouthOpen,
                    "mouthWide": face.mouthWide,
                    "faceTurn": face.faceTurn,
                    "hint": face.hint
                ]
            }
        }
        notifyListeners("frame", data: payload)
    }

    /// หมุนภาพให้ตั้งตรงตามทิศของเครื่อง + ย่อขนาดให้เล็กลงก่อนส่งไป API
    private func normalizedImage(from pixelBuffer: CVPixelBuffer) -> (CGImage?, CGImagePropertyOrientation) {
        var image = CIImage(cvPixelBuffer: pixelBuffer)

        let degrees = resolveRotation(for: pixelBuffer)
        if degrees != 0 {
            let radians = CGFloat(degrees) * .pi / 180.0
            let rotated = image.transformed(by: CGAffineTransform(rotationAngle: radians))
            image = rotated
        }

        let extent = image.extent
        let scale = min(1.0, maxWidth / max(extent.width, 1))
        if scale < 1.0 {
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        let cgImage = ciContext.createCGImage(image, from: image.extent)
        return (cgImage, orientation(for: degrees))
    }

    private func resolveRotation(for pixelBuffer: CVPixelBuffer) -> Int {
        if rotationSetting != "auto" { return Int(rotationSetting) ?? 0 }

        let bufferWidth = CVPixelBufferGetWidth(pixelBuffer)
        let bufferHeight = CVPixelBufferGetHeight(pixelBuffer)
        let screen = UIScreen.main.bounds
        let screenIsPortrait = screen.height > screen.width
        let bufferIsPortrait = bufferHeight > bufferWidth

        if screenIsPortrait && !bufferIsPortrait { return 90 }
        if !screenIsPortrait && bufferIsPortrait { return 270 }
        return 0
    }

    private func orientation(for degrees: Int) -> CGImagePropertyOrientation {
        switch degrees {
        case 90: return .right
        case 180: return .down
        case 270: return .left
        default: return .up
        }
    }

    // MARK: - Face analysis for in-app video mode (base64 image)

    @objc func analyzeFaces(_ call: CAPPluginCall) {
        let raw = call.getString("base64") ?? ""
        let cleaned = raw.replacingOccurrences(of: "data:image/jpeg;base64,", with: "")
        guard let data = Data(base64Encoded: cleaned),
              let image = UIImage(data: data),
              let cgImage = image.cgImage else {
            call.reject("อ่านรูปไม่สำเร็จ")
            return
        }
        let faces = FaceAnalyzer.analyze(cgImage: cgImage)
        call.resolve([
            "faces": faces.map { face -> [String: Any] in
                [
                    "index": face.index,
                    "box": face.box,
                    "eyeOpen": face.eyeOpen,
                    "browEyeGap": face.browEyeGap,
                    "mouthOpen": face.mouthOpen,
                    "mouthWide": face.mouthWide,
                    "faceTurn": face.faceTurn,
                    "hint": face.hint
                ]
            }
        ])
    }

    // MARK: - TTS

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        guard !text.isEmpty else {
            call.resolve(["spoken": false])
            return
        }
        let rate = Float(call.getDouble("rate") ?? 0.5)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "th-TH") ?? AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = rate
        utterance.pitchMultiplier = 1.0
        speech.speak(utterance)
        call.resolve(["spoken": true])
    }

    // MARK: - กันจอดับระหว่างดูคลิป

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
            call.resolve(["keepAwake": enabled])
        }
    }

    // MARK: - Status

    @objc func status(_ call: CAPPluginCall) {
        call.resolve([
            "pipActive": pip.isActive,
            "pipSupported": pip.isPossible,
            "capturing": isCapturing,
            "micActive": audioTap.isMicActive,
            "audioLevel": Double(lastAudioLevel),
            "intervalMs": Int(emitInterval * 1000)
        ])
    }
}
