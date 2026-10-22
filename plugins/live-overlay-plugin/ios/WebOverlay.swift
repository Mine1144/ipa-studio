import Foundation
import WebKit
import UIKit

/// ฝังเว็บ (เกมบนเว็บ / สตรีม / เว็บไซต์) ไว้เต็มจอในแอปเรา
/// แล้ววางซับไทยทับทับเนื้อหา — ได้ "ซับเต็มจอ" ที่ iOS ไม่อนุญาตให้ทำกับแอปอื่น
final class WebOverlayController: NSObject, WKNavigationDelegate {

    private weak var host: UIViewController?
    private var webView: WKWebView?
    private var container: UIViewController?
    private var overlay: UIView?
    private var label: UILabel?
    private var closeButton: UIButton?

    var isOpen: Bool { container != nil }

    // MARK: - เปิด/ปิด

    func open(url: URL, host: UIViewController) {
        close()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black

        let vc = UIViewController()
        vc.view.backgroundColor = .black
        vc.modalPresentationStyle = .fullScreen

        // ชั้นทับซับ (โปร่งใส ให้เห็นเนื้อหาเว็บข้างใต้)
        let overlayView = UIView(frame: .zero)
        overlayView.backgroundColor = .clear
        overlayView.isUserInteractionEnabled = false

        let subLabel = UILabel()
        subLabel.text = ""
        subLabel.textColor = .white
        subLabel.font = .systemFont(ofSize: 26, weight: .bold)
        subLabel.numberOfLines = 0
        subLabel.textAlignment = .center
        subLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        subLabel.layer.cornerRadius = 12
        subLabel.layer.masksToBounds = true
        subLabel.isHidden = true

        let close = UIButton(type: .system)
        close.setTitle("✕", for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 18, weight: .bold)
        close.tintColor = .white
        close.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        close.layer.cornerRadius = 18
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        close.isUserInteractionEnabled = true

        vc.view.addSubview(web)
        vc.view.addSubview(overlayView)
        overlayView.addSubview(subLabel)
        vc.view.addSubview(close)

        web.translatesAutoresizingMaskIntoConstraints = false
        overlayView.translatesAutoresizingMaskIntoConstraints = false
        subLabel.translatesAutoresizingMaskIntoConstraints = false
        close.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: vc.view.topAnchor),
            web.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),

            overlayView.topAnchor.constraint(equalTo: vc.view.topAnchor),
            overlayView.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
            overlayView.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            overlayView.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),

            subLabel.leadingAnchor.constraint(equalTo: overlayView.leadingAnchor, constant: 12),
            subLabel.trailingAnchor.constraint(equalTo: overlayView.trailingAnchor, constant: -12),
            subLabel.bottomAnchor.constraint(equalTo: overlayView.safeAreaLayoutGuide.bottomAnchor, constant: -24),

            close.topAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor, constant: 10),
            close.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor, constant: -14),
            close.widthAnchor.constraint(equalToConstant: 36),
            close.heightAnchor.constraint(equalToConstant: 36),
        ])

        self.host = host
        self.webView = web
        self.container = vc
        self.overlay = overlayView
        self.label = subLabel

        host.present(vc, animated: true)
        web.load(URLRequest(url: url))
    }

    func close() {
        guard let vc = container else { return }
        container = nil
        webView = nil
        overlay = nil
        label = nil
        closeButton = nil
        vc.dismiss(animated: true)
    }

    @objc private func closeTapped() {
        close()
    }

    // MARK: - อัปเดตซับ

    func setSubtitle(text: String, meta: String) {
        DispatchQueue.main.async {
            guard let label = self.label else { return }
            let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if clean.isEmpty {
                label.isHidden = true
                label.text = ""
                return
            }
            let attributed = NSMutableAttributedString(
                string: meta.isEmpty ? clean : "\(meta)\n\(clean)",
                attributes: [
                    .font: UIFont.systemFont(ofSize: 26, weight: .bold),
                    .foregroundColor: UIColor.white,
                    .strokeColor: UIColor.black.withAlphaComponent(0.9),
                    .strokeWidth: -3.0,
                    .paragraphStyle: centeredParagraph()
                ]
            )
            label.attributedText = attributed
            label.isHidden = false
        }
    }

    private func centeredParagraph() -> NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.alignment = .center
        p.lineBreakMode = .byWordWrapping
        return p
    }
}
