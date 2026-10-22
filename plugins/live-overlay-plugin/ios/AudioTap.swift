import Foundation
import AVFoundation
import CoreMedia

/// ดักเสียง (จาก ReplayKit หรือไมโครโฟน) → แปลงเป็น PCM 16kHz mono 16-bit → ตัดเป็น WAV 1 วินาที
/// ส่งกลับผ่าน callback เพื่อเอาไปยิง Typhoon ASR
final class AudioTap {

    /// (wav data, ระดับความดัง 0...1)
    var onChunk: ((Data, Float) -> Void)?

    private let targetSampleRate: Double = 16000
    private let chunkFrames = 16000            // 1 วินาที
    private var pending: [Int16] = []
    private var converter: AVAudioConverter?
    private var converterInputRate: Double = -1
    private var converterInputChannels: AVAudioChannelCount = 0

    private var engine: AVAudioEngine?
    private var micActive = false

    var isMicActive: Bool { micActive }

    // MARK: - ReplayKit (เสียงที่ระบบ/แอปที่กำลังอัดส่งมา)

    func handleReplayKit(sampleBuffer: CMSampleBuffer) {
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else { return }

        let channels = AVAudioChannelCount(asbd.pointee.mChannelsPerFrame)
        let frames = Int(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0, channels > 0, let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        CMBlockBufferAssureBlockMemory(dataBuffer)

        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        var dataPointerOffset: UInt32 = 0
        let status = CMBlockBufferGetDataPointer(
            dataBuffer,
            atOffset: 0,
            lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer,
            dataPointerFrameOffsetOut: &dataPointerOffset
        )
        guard status == kCMBlockBufferNoErr, let ptr = dataPointer, lengthAtOffset > 0 else { return }

        let sampleRate = asbd.pointee.mSampleRate
        let isFloat = (asbd.pointee.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bytesPerSample = Int(asbd.pointee.mBitsPerChannel) / 8
        guard bytesPerSample > 0 else { return }

        // สร้างบัฟเฟอร์แบบ non-interleaved (AVAudioPCMBuffer ไม่มี channel data สำหรับ interleaved)
        let targetFormat: AVAudioFormat
        if isFloat {
            targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: channels, interleaved: false)!
        } else {
            targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: channels, interleaved: false)!
        }
        guard let pcm = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        pcm.frameLength = AVAudioFrameCount(frames)

        let available = lengthAtOffset / bytesPerSample
        let sampleCount = min(frames * Int(channels), available)

        if isFloat {
            guard let dst = pcm.floatChannelData else { return }
            let src = ptr.assumingMemoryBound(to: Float.self)
            for i in 0..<sampleCount {
                let ch = i % Int(channels)
                dst[ch][i / Int(channels)] = src[i]
            }
        } else {
            guard let dst = pcm.int16ChannelData else { return }
            let src = ptr.assumingMemoryBound(to: Int16.self)
            for i in 0..<sampleCount {
                let ch = i % Int(channels)
                dst[ch][i / Int(channels)] = src[i]
            }
        }
        process(pcm: pcm)
    }

    // MARK: - ไมโครโฟน (แน่นอนว่าได้ ใช้เป็นทางหลักได้)

    func startMic() throws {
        if micActive { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "AudioTap", code: 2, userInfo: [NSLocalizedDescriptionKey: "ไม่พบไมโครโฟน"])
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.process(pcm: buffer)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
        micActive = true
    }

    func stopMic() {
        guard let engine = engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        micActive = false
    }

    // MARK: - แปลง + ตัดเป็นชิ้น 1 วินาที

    private func process(pcm: AVAudioPCMBuffer) {
        guard let out = convert(pcm: pcm) else { return }
        guard let channel = out.int16ChannelData?[0] else { return }
        let count = Int(out.frameLength)
        guard count > 0 else { return }

        pending.reserveCapacity(pending.count + count)
        for i in 0..<count { pending.append(channel[i]) }

        while pending.count >= chunkFrames {
            let slice = Array(pending.prefix(chunkFrames))
            pending.removeFirst(chunkFrames)
            let wav = AudioTap.makeWAV(samples: slice, sampleRate: Int(targetSampleRate))
            let level = AudioTap.rms(slice)
            onChunk?(wav, level)
        }
    }

    private func convert(pcm: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let inFormat = pcm.format
        guard let outFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ) else { return nil }

        if converter == nil
            || converterInputRate != inFormat.sampleRate
            || converterInputChannels != inFormat.channelCount {
            converter = AVAudioConverter(from: inFormat, to: outFormat)
            converterInputRate = inFormat.sampleRate
            converterInputChannels = inFormat.channelCount
        }
        guard let conv = converter else { return nil }

        let ratio = targetSampleRate / inFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 2048
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return nil }

        var provided = false
        var error: NSError?
        conv.convert(to: out, error: &error) { _, outStatus in
            if provided {
                outStatus.pointee = .noDataNow
                return nil
            }
            provided = true
            outStatus.pointee = .haveData
            return pcm
        }
        if error != nil { return nil }
        return out
    }

    // MARK: - ช่วยเหลือ

    private static func rms(_ samples: [Int16]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Double = 0
        for s in samples {
            let v = Double(s) / 32768.0
            sum += v * v
        }
        let value = sqrt(sum / Double(samples.count))
        return Float(min(max(value * 4, 0), 1))
    }

    /// ห่อ PCM เป็นไฟล์ WAV (RIFF)
    static func makeWAV(samples: [Int16], sampleRate: Int) -> Data {
        let bytesPerSample = 2
        let dataSize = samples.count * bytesPerSample
        var data = Data(capacity: 44 + dataSize)

        func appendASCII(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func appendU32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func appendU16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }

        appendASCII("RIFF")
        appendU32(UInt32(36 + dataSize))
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendU32(16)
        appendU16(1)                       // PCM
        appendU16(1)                       // mono
        appendU32(UInt32(sampleRate))
        appendU32(UInt32(sampleRate * bytesPerSample))
        appendU16(UInt16(bytesPerSample))
        appendU16(16)                      // bits per sample
        appendASCII("data")
        appendU32(UInt32(dataSize))

        samples.withUnsafeBufferPointer { buf in
            guard let base = buf.baseAddress else { return }
            for i in 0..<samples.count {
                var little = base[i].littleEndian
                withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
            }
        }
        return data
    }
}
