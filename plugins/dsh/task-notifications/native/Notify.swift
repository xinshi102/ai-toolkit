import AppKit
import UserNotifications

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let center = UNUserNotificationCenter.current()
var args = Array(CommandLine.arguments.dropFirst())
var action = args.first ?? "--status"
let preferenceURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh/notifications/settings.json")
let preferenceData = try? Data(contentsOf: preferenceURL)
let preferences = preferenceData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
let channel = preferences["channel"] as? String ?? "desktop"
// Compatibility for the already-running host: its old --notify calls use the new desktop channel.
if channel == "desktop" && (action == "--notify" || action == "--test") {
    if action == "--test" { args = ["--toast", "DeepSeek 通知测试", "桌面右下角提醒，切换软件后仍可看到。"] }
    action = "--toast"
}

func finish(_ values: [String: Any], code: Int32 = 0) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

func statusName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
}

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
let delegate = Delegate()
center.delegate = delegate

if action == "--status" {
    center.getNotificationSettings { settings in
        finish(["authorization": statusName(settings.authorizationStatus),
                "channel": channel,
                "alertStyle": settings.alertStyle.rawValue,
                "sound": settings.soundSetting.rawValue,
                "bundle": Bundle.main.bundleIdentifier ?? "unknown"])
    }
} else if action == "--delivered" {
    center.getDeliveredNotifications { notifications in
        finish(["count": notifications.count, "titles": notifications.map { $0.request.content.title }])
    }
} else if action == "--request" {
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error = error { finish(["error": error.localizedDescription], code: 1) }
        finish(["granted": granted])
    }
} else if action == "--settings" {
    DispatchQueue.main.async {
        let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
        finish(["opened": NSWorkspace.shared.open(url)])
    }
} else if action == "--toast" {
    let screen = NSScreen.main ?? NSScreen.screens.first!
    let rect = screen.visibleFrame
    let panel = NSPanel(contentRect: NSRect(x: rect.maxX - 390, y: rect.minY + 22, width: 366, height: 136),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    let background = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 366, height: 136))
    background.material = .hudWindow
    background.blendingMode = .behindWindow
    background.state = .active
    background.wantsLayer = true
    background.layer?.cornerRadius = 16
    let title = NSTextField(labelWithString: args.count > 1 ? String(args[1].prefix(100)) : "DeepSeek")
    title.font = .boldSystemFont(ofSize: 15)
    title.frame = NSRect(x: 20, y: 94, width: 300, height: 22)
    let body = NSTextField(wrappingLabelWithString: args.count > 2 ? String(args[2].prefix(300)) : "返回 DeepSeek 查看结果。")
    body.font = .systemFont(ofSize: 13)
    body.textColor = .secondaryLabelColor
    body.frame = NSRect(x: 20, y: 53, width: 320, height: 36)
    final class Actions: NSObject {
        @objc func closeToast() { finish(["shown": true, "channel": "desktop"]) }
        @objc func openDeepSeek() {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/DeepSeek Harness.app"))
            finish(["shown": true, "channel": "desktop"])
        }
    }
    let actions = Actions()
    let openButton = NSButton(title: "查看 DeepSeek", target: actions, action: #selector(Actions.openDeepSeek))
    openButton.bezelStyle = .rounded
    openButton.frame = NSRect(x: 20, y: 15, width: 130, height: 28)
    let closeButton = NSButton(title: "关闭", target: actions, action: #selector(Actions.closeToast))
    closeButton.bezelStyle = .rounded
    closeButton.frame = NSRect(x: 280, y: 15, width: 65, height: 28)
    [title, body, openButton, closeButton].forEach { background.addSubview($0) }
    panel.contentView = background
    panel.orderFrontRegardless()
    DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
        panel.orderOut(nil)
        withExtendedLifetime(actions) { finish(["shown": true, "channel": "desktop"]) }
    }
} else if action == "--notify" || action == "--test" {
    center.getNotificationSettings { settings in
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            finish(["error": "Notification permission is not enabled", "authorization": statusName(settings.authorizationStatus)], code: 2)
        }
        let content = UNMutableNotificationContent()
        content.title = action == "--test" ? "DeepSeek 通知测试" : (args.count > 1 ? String(args[1].prefix(100)) : "DeepSeek")
        content.body = action == "--test" ? "任务完成或需要你处理时，将在这里提醒。" : (args.count > 2 ? String(args[2].prefix(300)) : "任务状态发生变化。")
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(request) { error in
            if let error = error { finish(["error": error.localizedDescription], code: 1) }
            // Queue admission is distinct from a visibly presented banner.
            Thread.sleep(forTimeInterval: 1)
            finish(["queued": true])
        }
    }
} else {
    finish(["error": "Use --status, --request, --settings, --test or --notify title body"], code: 2)
}
app.run()
