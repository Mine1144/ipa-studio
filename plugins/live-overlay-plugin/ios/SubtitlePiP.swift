import Foundation
import AVFoundation
import AVKit
import UIKit
import CoreMedia
import CoreVideo

/// วาดคำบรรยายไทยลงใน Picture-in-Picture ของ iOS
/// ใช้ AVSampleBufferDisplayLayer + วาดภาพผ่าน UIGraphicsImageRenderer
/// (PiP ต้องเป็น sample buffer เพราะแอปเราไม่มีไฟล์วิดีโอจริง)
final class SubtitlePiP: NSObject {

    /// canvas 16:9 — เล็กพอให้ข้อความที่วาด "ใหญ่เทียบกับกรอบ" (PiP ย่อภาพตามขนาดหน้าต่าง
    /// ถ้า canvas ใหญ่เกิน ข้อความจะเล็กจนอ่านไม่ออกตอนหน้าต่าง PiP ย่อ)
    static let canvasSize = CGSize(width: 640, height: 360)

    private let displayLayer = AVSampleBufferDisplayLayer()
    private var controller: AVPictureInPictureController?
    private var timer: Timer?

    private var subtitle: String = ""
    private var meta: String = ""
    private var accent: UIColor = .systemYellow

    var isActive: Bool { controller?.isPictureInPictureActive ?? false }
    var isPossible: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

    // MARK: - Lifecycle

    func start() throws {
        guard isPossible else {
            throw NSError(domain: "SubtitlePiP", code: 1, userInfo: [NSLocalizedDescriptionKey: "อุปกรณ์นี้ไม่รองรับ Picture-in-Picture"])
        }
        if controller != nil { return }

        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = UIColor.clear.cgColor
        displayLayer.frame = CGRect(origin: .zero, size: SubtitlePiP.canvasSize)
        attachToWindow()

        let source = AVPictureInPictureController.ContentSource(
            sampleBufferDisplayLayer: displayLayer,
            playbackDelegate: playbackDelegate
        )
        let pip = AVPictureInPictureController(contentSource: source)
        pip.delegate = controllerDelegate
        pip.canStartPictureInPictureAutomaticallyFromInline = true
        controller = pip

        // เปิด audio session แบบ playback เพื่อให้ PiP ทำงานได้
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        try? session.setActive(true)

        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            self?.pushFrame()
        }
        pushFrame()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if controller?.isPictureInPictureActive == true {
            controller?.stopPictureInPicture()
        }
        controller = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    func update(text: String, meta: String, accentHex: String?) {
        if text != subtitle || meta != self.meta {
            subtitle = text
            self.meta = meta
            pushFrame()
        }
        if let hex = accentHex, let c = SubtitlePiP.color(fromHex: hex) {
            accent = c
            pushFrame()
        }
    }

    // MARK: - Rendering

    private func attachToWindow() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if displayLayer.superlayer == nil {
                let window = UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .flatMap { $0.windows }
                    .first { $0.isKeyWindow }
                window?.layer.addSublayer(self.displayLayer)
                self.displayLayer.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
                self.displayLayer.isHidden = false
                self.displayLayer.opacity = 0.01
            }
        }
    }

    private func pushFrame() {
        guard let controller = controller, let buffer = renderBuffer() else { return }
        guard let sampleBuffer = makeSampleBuffer(buffer) else { return }

        if displayLayer.status == .failed {
            displayLayer.flush()
        }
        if displayLayer.isReadyForMoreMediaData {
            displayLayer.enqueue(sampleBuffer)
        }
    }

    /// สร้างพิกเซลบัฟเฟอร์ที่มีคำบรรยายวาดอยู่
    private func renderBuffer() -> CVPixelBuffer? {
        let size = SubtitlePiP.canvasSize
        var pixelBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
        ]
        CVPixelBufferCreate(
            kCFAllocatorDefault,
            Int(size.width),
            Int(size.height),
            kCVPixelFormatType_32ARGB,
            attrs as CFDictionary,
            &pixelBuffer
        )
        guard let buffer = pixelBuffer else { return nil }

        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

        guard let base = CVPixelBufferGetBaseAddress(buffer),
              let ctx = CGContext(
                data: base,
                width: Int(size.width),
                height: Int(size.height),
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
              ) else { return nil }

        ctx.clear(CGRect(origin: .zero, size: size))

        guard let image = makeOverlayImage(size: size) else { return nil }
        let w = size.width
        let h = size.height
        // buffer แถวแรกคือแถวบนสุดของภาพ แต่ CGContext มี origin อยู่ล่าง
        // วางที่ y = -1 เพื่อให้ภาพไปตกที่บนสุดพอดี (คลาดเพี้ยน 1 พิกเซล)
        ctx.draw(image, in: CGRect(x: 0, y: -1, width: w, height: h))
        return buffer
    }

    private func makeOverlayImage(size: CGSize) -> CGImage? {
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { ctx in
            let cg = ctx.cgContext
            cg.setFillColor(UIColor.clear.cgColor)
            cg.fill(CGRect(origin: .zero, size: size))

            let text = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }

            let font = UIFont.systemFont(ofSize: 44, weight: .bold)
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            para.lineBreakMode = .byWordWrapping

            let attributed = NSMutableAttributedString(
                string: text,
                attributes: [
                    .font: font,
                    .foregroundColor: UIColor.white,
                    .paragraphStyle: para,
                    .strokeColor: UIColor.black.withAlphaComponent(0.9),
                    .strokeWidth: -4.0
                ]
            )

            let inset: CGFloat = 18
            let textRect = CGRect(x: inset, y: size.height * 0.42, width: size.width - inset * 2, height: size.height * 0.44)
            attributed.boundingRect(with: textRect.size, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)

            // กล่องพื้นหลัง
            let box = textRect.insetBy(dx: -inset * 0.7, dy: -12)
            let path = UIBezierPath(roundedRect: box, cornerRadius: 16)
            UIColor.black.withAlphaComponent(0.62).setFill()
            path.fill()
            accent.withAlphaComponent(0.9).setStroke()
            path.lineWidth = 3
            path.stroke()

            attributed.draw(with: textRect, options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)

            if !meta.isEmpty {
                let metaFont = UIFont.systemFont(ofSize: 26, weight: .semibold)
                let metaAttrs: [NSAttributedString.Key: Any] = [
                    .font: metaFont,
                    .foregroundColor: accent,
                    .paragraphStyle: para,
                    .strokeColor: UIColor.black.withAlphaComponent(0.9),
                    .strokeWidth: -3.0
                ]
                let metaString = NSAttributedString(string: meta, attributes: metaAttrs)
                let metaRect = CGRect(x: inset, y: max(4, box.minY - 34), width: size.width - inset * 2, height: 32)
                metaString.draw(with: metaRect, options: [.usesLineFragmentOrigin], context: nil)
            }
        }
        return image.cgImage
    }

    private func makeSampleBuffer(_ pixelBuffer: CVPixelBuffer) -> CMSampleBuffer? {
        var formatDescription: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescription
        )
        guard let fd = formatDescription else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 2),
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: fd,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        return sampleBuffer
    }

    // MARK: - Delegates

    private lazy var playbackDelegate = SampleBufferPlaybackDelegate(owner: self)
    private lazy var controllerDelegate = PipControllerDelegate(owner: self)

    fileprivate func handleSetPlaying(_ playing: Bool) {
        // เมื่อ PiP เริ่มเล่น ให้ดันเฟรมต่อเนื่อง
        if playing { pushFrame() }
    }

    fileprivate func handleRestoreUI() {
        NotificationCenter.default.post(name: .liveOverlayRestoreUI, object: nil)
    }

    static func color(fromHex hex: String) -> UIColor? {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6 || value.count == 8, let num = UInt64(value, radix: 16) else { return nil }
        if value.count == 6 {
            return UIColor(
                red: CGFloat((num >> 16) & 0xFF) / 255,
                green: CGFloat((num >> 8) & 0xFF) / 255,
                blue: CGFloat(num & 0xFF) / 255,
                alpha: 1
            )
        }
        return UIColor(
            red: CGFloat((num >> 24) & 0xFF) / 255,
            green: CGFloat((num >> 16) & 0xFF) / 255,
            blue: CGFloat((num >> 8) & 0xFF) / 255,
            alpha: CGFloat(num & 0xFF) / 255
        )
    }
}

extension Notification.Name {
    static let liveOverlayRestoreUI = Notification.Name("liveOverlayRestoreUI")
}

/// ตัวแทน delegate ของ AVPictureInPictureSampleBufferPlaybackDelegate
private final class SampleBufferPlaybackDelegate: NSObject, AVPictureInPictureSampleBufferPlaybackDelegate {
    weak var owner: SubtitlePiP?
    init(owner: SubtitlePiP) { self.owner = owner }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {
        owner?.handleSetPlaying(playing)
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, finishPlaybackWithCompletionHandler completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}

/// delegate ของ PiP ตัวหลัก (ปุ่มปิด/กลับมาแอป)
private final class PipControllerDelegate: NSObject, AVPictureInPictureControllerDelegate {
    weak var owner: SubtitlePiP?
    init(owner: SubtitlePiP) { self.owner = owner }

    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {}

    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {}

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {}

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        owner?.handleRestoreUI()
        completionHandler(true)
    }
}
