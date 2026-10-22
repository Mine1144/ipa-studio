import Foundation
import UIKit
import Vision
import CoreGraphics

/// ผลการวิเคราะห์ใบหน้า 1 คน (ใช้กับ Vision framework ของ Apple)
struct FaceCue: Codable {
    var index: Int = 0
    var box: [Double] = []          // [x, y, w, h] สัดส่วนกับภาพ
    var eyeOpen: Double = 0         // ยิ่งเล็ก = หลับตาหนัก/โกรธ
    var browEyeGap: Double = 0      // ยิ่งเล็ก = คิ้วลงเข้าใกล้ตา (โกรธ)
    var mouthOpen: Double = 0       // ยิ่งมาก = ตะโกน/แปลกใจ
    var mouthWide: Double = 0       // ยิ่งมาก = ยิ้ม
    var faceTurn: Double = 0        // ค่ามุมหันหน้า (-1 = หันซ้าย, 1 = หันขวา)
    var hint: String = ""           // คำเดาเบื้องต้นจากตัวเลข (ไม่ใช่คำตัดสิน)
}

enum FaceAnalyzer {

    /// วิเคราะห์ใบหน้าทั้งหมดในภาพ
    static func analyze(cgImage: CGImage) -> [FaceCue] {
        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return []
        }
        guard let observations = request.results else { return [] }

        var cues: [FaceCue] = []
        for (i, obs) in observations.enumerated() {
            var cue = FaceCue()
            cue.index = i
            let b = obs.boundingBox
            cue.box = [Double(b.origin.x), Double(b.origin.y), Double(b.width), Double(b.height)]
            cue.faceTurn = Double(obs.yaw ?? 0)

            guard let lm = obs.landmarks else { continue }
            let faceH = max(b.height, 0.0001)

            // --- ความเปิดตา (ไม่ขึ้นกับทิศของแกน y) ---
            if let eye = lm.leftEye, eye.normalizedPoints.count >= 6 {
                let upper = eye.normalizedPoints[0]
                let lower = eye.normalizedPoints[eye.normalizedPoints.count / 2]
                cue.eyeOpen = Double(distance(upper, lower)) / Double(faceH)
            }

            // --- ระยะคิ้วถึงตา (คิ้วลง = ระยะสั้นลง) ---
            if let brow = lm.leftEyebrow, let eye = lm.leftEye,
               let browPoint = brow.normalizedPoints.first, let eyePoint = eye.normalizedPoints.first {
                cue.browEyeGap = Double(distance(browPoint, eyePoint)) / Double(faceH)
            }

            // --- ความเปิดปาก / ความกว้างปาก ---
            if let mouth = lm.outerLips, mouth.normalizedPoints.count >= 6 {
                let upper = mouth.normalizedPoints[1]
                let lower = mouth.normalizedPoints[mouth.normalizedPoints.count - 2]
                cue.mouthOpen = Double(distance(upper, lower)) / Double(faceH)
                let left = mouth.normalizedPoints[0]
                let right = mouth.normalizedPoints[mouth.normalizedPoints.count - 1]
                cue.mouthWide = Double(distance(left, right)) / Double(faceH)
            }

            cue.hint = hint(for: cue)
            cues.append(cue)
        }
        return cues
    }

    /// คำเดาเบื้องต้นจากตัวเลข (ให้ LLM เป็นคนตัดสินใจต่อ)
    private static func hint(for cue: FaceCue) -> String {
        var tags: [String] = []

        let eyesNarrow = cue.eyeOpen > 0 && cue.eyeOpen < 0.075
        let eyesWide = cue.eyeOpen >= 0.11
        let browsLow = cue.browEyeGap > 0 && cue.browEyeGap < 0.10
        let mouthShout = cue.mouthOpen > 0.13
        let smiling = cue.mouthWide > 0.42 && cue.mouthOpen < 0.09

        if browsLow && (eyesNarrow || mouthShout) { tags.append("อาจกำลังโกรธ/หงุด") }
        if eyesWide && mouthShout { tags.append("อาจกำลังตะโกน/ตกใจ") }
        if smiling { tags.append("อาจกำลังยิ้ม") }
        if eyesNarrow && !browsLow { tags.append("อาจเหนื่อยหรือท้องเสีย") }
        if tags.isEmpty { tags.append("นิ่ง/อ่านไม่ออก") }
        return tags.joined(separator: ", ")
    }

    private static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = a.x - b.x
        let dy = a.y - b.y
        return sqrt(dx * dx + dy * dy)
    }
}
