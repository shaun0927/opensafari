import UIKit
import WebKit

/// Minimal view controller that hosts a native button and a WKWebView.
///
/// - The "Load" button triggers an HTML load in the embedded WebView.
/// - The WKWebView is marked `isInspectable = true` so ios-webkit-debug-proxy
///   can discover it and opensafari can bridge into it via `app_webview_connect`.
/// - Every interactive element has an `accessibilityIdentifier` so the
///   accessibility bridge can target it headlessly.
/// - The status label uses `accessibilityValue` for the dynamic state so the
///   AX bridge can read it (accessibilityLabel is fixed for query stability).
class ViewController: UIViewController, WKNavigationDelegate {
    private let statusLabel = UILabel()
    private let loadButton = UIButton(type: .system)
    private let webView: WKWebView = {
        let config = WKWebViewConfiguration()
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.isInspectable = true
        return wv
    }()

    private static let fixtureHTML = """
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>WebView Fixture</title></head>
    <body>
    <h1 id="heading">WebView Loaded</h1>
    <p id="info">This page is served inside a native WKWebView fixture.</p>
    <button id="web-btn" onclick="document.getElementById('info').textContent='clicked'">Click Me</button>
    </body>
    </html>
    """

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white

        statusLabel.text = "Status: idle"
        statusLabel.accessibilityIdentifier = "status_label"
        statusLabel.accessibilityValue = "idle"
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)

        loadButton.setTitle("Load", for: .normal)
        loadButton.titleLabel?.font = .systemFont(ofSize: 18, weight: .medium)
        loadButton.accessibilityIdentifier = "load_btn"
        loadButton.accessibilityLabel = "Load"
        loadButton.translatesAutoresizingMaskIntoConstraints = false
        loadButton.addTarget(self, action: #selector(loadTapped), for: .touchUpInside)
        view.addSubview(loadButton)

        webView.accessibilityIdentifier = "main_webview"
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),

            loadButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 16),
            loadButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            loadButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 120),
            loadButton.heightAnchor.constraint(equalToConstant: 44),

            webView.topAnchor.constraint(equalTo: loadButton.bottomAnchor, constant: 16),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    @objc private func loadTapped() {
        statusLabel.text = "Status: loading"
        statusLabel.accessibilityValue = "loading"
        // Use file:// baseURL so ios-webkit-debug-proxy classifies the target as
        // a WebView (not a Safari tab) when opensafari calls classifyTarget().
        webView.loadHTMLString(
            Self.fixtureHTML,
            baseURL: URL(string: "file:///webview-fixture/")
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        statusLabel.text = "Status: loaded"
        statusLabel.accessibilityValue = "loaded"
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        statusLabel.text = "Status: error"
        statusLabel.accessibilityValue = "error"
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        statusLabel.text = "Status: error"
        statusLabel.accessibilityValue = "error"
    }
}
