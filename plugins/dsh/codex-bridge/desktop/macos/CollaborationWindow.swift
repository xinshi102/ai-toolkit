import AppKit
import WebKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let discoveryURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent("Library/Application Support/com.xinshi.deepseek-codex-window/bridge-server.json")
    private var retryTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1220, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "DeepSeek · Codex · OpenCode 协作窗口"
        window.minSize = NSSize(width: 980, height: 560)
        window.center()
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        loadWindow()
    }

    private func loadWindow() {
        guard let data = try? Data(contentsOf: discoveryURL),
              let server = try? JSONDecoder().decode(BridgeServer.self, from: data),
              server.version == 1,
              (1...65535).contains(server.port),
              ["127.0.0.1", "localhost", "::1"].contains(server.host),
              let url = URL(string: "http://\(server.host):\(server.port)/codex-collab/window") else {
            showWaitingPage()
            return
        }
        retryTimer?.invalidate()
        retryTimer = nil
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    private func showWaitingPage() {
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8"><style>body{font-family:-apple-system;padding:40px;background:#f3f5f8;color:#111827}main{max-width:520px;margin:80px auto;background:white;padding:28px;border-radius:16px;box-shadow:0 12px 35px #0002}button{padding:9px 14px;border:0;border-radius:9px;background:#2563eb;color:white;font-size:14px;cursor:pointer}</style><main><h2>正在等待 DeepSeek Harness</h2><p id="reason">未找到有效的本机协作服务地址。请确认 DSH 桌面端已启动。</p><button onclick="location.reload()">重试连接</button><p>窗口也会每 2 秒自动重试。</p></main>
        """, baseURL: nil)
        if retryTimer == nil {
            retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                self?.loadWindow()
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showWaitingPage()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

private struct BridgeServer: Decodable {
    let version: Int
    let host: String
    let port: Int
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
