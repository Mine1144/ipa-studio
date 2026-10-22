import Foundation
import Network
import Darwin

/// เซิร์ฟเวอร์ HTTP จิ๋วในแอป เพื่อ "ส่งจอเกมไปจอที่สอง"
/// - เฟรมล่าสุด (JPEG) + ซับไทย ถูกส่งไปยังอุปกรณ์อื่นใน LAN เพื่อแสดงเต็มจอ
/// - อุปกรณ์ที่สองแค่เปิด http://<ip-ของ-iphone>:port ในเบราว์เซอร์
final class MirrorServer {

    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    private(set) var isRunning = false

    private let lock = NSLock()
    private var latestJPEG: Data?
    private var latestSubtitle: String = ""
    private var latestMeta: String = ""
    /// โฟลเดอร์ที่ให้เสิร์ฟไฟล์ (เกมเว็บที่ฝังมาในแอป หรือไฟล์ใน Documents)
    private var staticRoot: URL?

    // MARK: - เริ่ม/หยุด

    func start(port requested: UInt16 = 8787) throws {
        if listener != nil { return }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let endpointPort = NWEndpoint.Port(rawValue: requested) ?? .any
        let l = try NWListener(using: params, on: endpointPort)

        l.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        l.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.isRunning = true
                self?.port = l.port?.rawValue ?? requested
            case .failed, .cancelled:
                self?.isRunning = false
            default:
                break
            }
        }
        l.start(queue: DispatchQueue(label: "mirror.server.queue"))
        listener = l
    }

    func stop() {
        listener?.cancel()
        listener = nil
        isRunning = false
    }

    // MARK: - อัปเดตข้อมูลที่ส่ง

    func update(jpeg: Data?, subtitle: String, meta: String) {
        lock.lock()
        defer { lock.unlock() }
        if let jpeg = jpeg { latestJPEG = jpeg }
        latestSubtitle = subtitle
        latestMeta = meta
    }

    /// กำหนดโฟลเดอร์ที่ให้เสิร์ฟไฟล์ (เช่น โฟลเดอร์เกมเว็บใน Documents)
    func setStaticRoot(_ url: URL?) {
        lock.lock()
        defer { lock.unlock() }
        staticRoot = url
    }

    /// หาไฟล์ใน staticRoot (กัน path traversal)
    private func fileForPath(_ path: String) -> (Data, String)? {
        lock.lock()
        let root = staticRoot
        lock.unlock()
        guard let root = root else { return nil }

        var rel = path
        if rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "index.html" }
        if rel.contains("..") { return nil }

        let candidate = root.appendingPathComponent(rel).standardizedFileURL
        guard candidate.path.hasPrefix(root.standardizedFileURL.path) else { return nil }
        guard let data = try? Data(contentsOf: candidate) else { return nil }
        return (data, MirrorServer.mimeType(for: candidate.pathExtension))
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "mp3": return "audio/mpeg"
        case "ogg": return "audio/ogg"
        case "wav": return "audio/wav"
        case "opus": return "audio/ogg"
        case "flac": return "audio/flac"
        case "mp4": return "video/mp4"
        case "webm": return "video/webm"
        case "data": return "application/octet-stream"
        default: return "application/octet-stream"
        }
    }

    // MARK: - จัดการคำขอ

    private func handle(_ conn: NWConnection) {
        conn.start(queue: DispatchQueue(label: "mirror.conn"))
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self = self, let data = data,
                  let text = String(data: data, encoding: .utf8) else {
                conn.cancel()
                return
            }
            let path = text.split(separator: " ", maxSplits: 2).count > 1
                ? String(text.split(separator: " ", maxSplits: 2)[1])
                : "/"
            let cleanPath = path.split(separator: "?").first.map(String.init) ?? "/"

            switch cleanPath {
            case "/", "/index.html":
                self.send(conn: conn, body: Data(MirrorServer.page.utf8), mime: "text/html; charset=utf-8")
            case "/frame.jpg":
                self.lock.lock()
                let jpeg = self.latestJPEG
                self.lock.unlock()
                if let jpeg = jpeg {
                    self.send(conn: conn, body: jpeg, mime: "image/jpeg")
                } else {
                    self.send(conn: conn, body: Data(), mime: "text/plain", status: "204 No Content")
                }
            case "/subtitle.json":
                self.lock.lock()
                let payload = "{\"text\":\(MirrorServer.jsonEscape(self.latestSubtitle)),\"meta\":\(MirrorServer.jsonEscape(self.latestMeta))}"
                self.lock.unlock()
                self.send(conn: conn, body: Data(payload.utf8), mime: "application/json; charset=utf-8")
            case "/ip":
                let payload = "{\"ip\":\"\(MirrorServer.localIP())\",\"port\":\(self.port)}"
                self.send(conn: conn, body: Data(payload.utf8), mime: "application/json; charset=utf-8")
            default:
                // ไฟล์เกมเว็บที่ฝังมาในแอป (ถ้ามี)
                if let (data, mime) = self.fileForPath(cleanPath) {
                    self.send(conn: conn, body: data, mime: mime)
                } else {
                    self.send(conn: conn, body: Data("not found".utf8), mime: "text/plain", status: "404 Not Found")
                }
            }
        }
    }

    private func send(conn: NWConnection, body: Data, mime: String, status: String = "200 OK") {
        var header = "HTTP/1.1 \(status)\r\n"
        header += "Content-Type: \(mime)\r\n"
        header += "Content-Length: \(body.count)\r\n"
        header += "Cache-Control: no-store\r\n"
        // ให้ WASM ใช้ SharedArrayBuffer ได้ (Ren'Py web + เกม WASM ต้องการ)
        header += "Cross-Origin-Opener-Policy: same-origin\r\n"
        header += "Cross-Origin-Embedder-Policy: require-corp\r\n"
        header += "Connection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - เครื่องมือ

    private static func jsonEscape(_ s: String) -> String {
        let data = Data(s.utf8)
        var out = "\""
        for b in data {
            let ch = Character(UnicodeScalar(b))
            if ch == "\"" { out += "\\\"" }
            else if ch == "\\" { out += "\\\\" }
            else if b < 0x20 { out += String(format: "\\u%04x", b) }
            else { out.append(ch) }
        }
        return out + "\""
    }

    /// IP ของเครื่องใน LAN (Wi-Fi)
    static func localIP() -> String {
        var address = ""
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&ifaddr) != nil {
            defer { freeifaddrs(ifaddr) }
            var ptr = ifaddr
            while let current = ptr {
                let iface = current.pointee
                let family = iface.ifa_addr.pointee.sa_family
                if family == UInt8(AF_INET) {
                    let name = String(cString: iface.ifa_name)
                    if name == "en0" || name == "en1" {
                        var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                        getnameinfo(iface.ifa_addr, socklen_t(iface.ifa_addr.pointee.sa_len),
                                    &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
                        address = String(cString: hostname)
                        break
                    }
                }
                ptr = current.pointee.ifa_next
            }
        }
        return address.isEmpty ? "127.0.0.1" : address
    }

    /// หน้าเว็บฝั่งจอที่สอง: ภาพจอเกม + ซับไทยเต็มจอ
    static let page = """
    <!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>ไทยซับ — จอที่สอง</title>
    <style>
      *{box-sizing:border-box;margin:0}
      html,body{height:100%;background:#000;overflow:hidden;font-family:-apple-system,"Noto Sans Thai",sans-serif}
      #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
      #shot{max-width:100%;max-height:100%;display:block}
      #sub{position:fixed;left:0;right:0;bottom:0;padding:18px 24px calc(18px + env(safe-area-inset-bottom));
           background:linear-gradient(to top,rgba(0,0,0,.88),rgba(0,0,0,0));text-align:center;
           color:#fff;font-size:clamp(18px,3.2vw,42px);font-weight:700;line-height:1.3;text-shadow:0 2px 10px #000}
      #meta{position:fixed;top:12px;left:16px;color:#f5c451;font-size:clamp(12px,1.4vw,18px);font-weight:700;
           background:rgba(0,0,0,.55);padding:6px 12px;border-radius:999px}
      #hint{position:fixed;top:12px;right:16px;color:#8d97ab;font-size:12px}
    </style></head><body>
    <div id="wrap"><img id="shot" alt=""></div>
    <div id="meta"></div><div id="hint">ไทยซับ · จอที่สอง</div>
    <div id="sub"></div>
    <script>
      const shot = document.getElementById('shot');
      const sub = document.getElementById('sub');
      const meta = document.getElementById('meta');
      let n = 0;
      function tick(){
        const t = Date.now();
        shot.src = '/frame.jpg?t=' + t;
        fetch('/subtitle.json?t=' + t).then(r=>r.json()).then(d=>{
          sub.textContent = d.text || '';
          meta.textContent = d.meta || '';
        }).catch(()=>{});
      }
      tick(); setInterval(tick, 200);
      shot.onerror = () => {};
    </script></body></html>
    """
}
