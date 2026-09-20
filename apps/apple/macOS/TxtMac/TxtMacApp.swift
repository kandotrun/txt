import AppKit
import SwiftUI

/// macOS application entry point (spec §4.4).
@main
struct TxtMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("テキスト", id: "main") {
            RootView()
                .environmentObject(model)
                .task { await model.onAppear() }
        }
        .defaultSize(width: 900, height: 680)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .saveItem) {
                Button("今すぐ保存") {
                    Task { await model.saveNow() }
                }
                .keyboardShortcut("s", modifiers: .command)
            }
        }

        Settings {
            SettingsView()
                .environmentObject(model)
        }
    }
}

/// Activation policy and window diagnostics.
///
/// Launching from a shell or an SSH session leaves AppKit in the background
/// with no connection to the window server, so the window never appears. The
/// delegate forces a regular activation policy and, when the `TXT_DIAGNOSTICS`
/// environment variable is set, reports window state to stderr so the GUI can
/// be verified without Accessibility permissions.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        guard ProcessInfo.processInfo.environment["TXT_DIAGNOSTICS"] != nil else { return }
        // Report after the first run-loop turn so the scene has been created
        // and the boot task has had a chance to finish.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            let windows = NSApp.windows
            FileHandle.standardError.write(Data(
                "TXT_DIAG windows=\(windows.count) visible=\(windows.filter(\.isVisible).count)\n".utf8
            ))
            for window in windows {
                let visible = window.isVisible ? "visible" : "hidden"
                FileHandle.standardError.write(Data(
                    "TXT_DIAG window \"\(window.title)\" \(visible) frame=\(window.frame)\n".utf8
                ))
                // Dump the rendered text so the gate/editor state is verifiable
                // without Accessibility permissions (unavailable over SSH).
                if let content = window.contentView {
                    let texts = Self.collectText(from: content)
                    FileHandle.standardError.write(Data(
                        "TXT_DIAG text=\(texts.joined(separator: " | "))\n".utf8
                    ))
                }
            }
            if let key = NSApp.keyWindow {
                FileHandle.standardError.write(Data("TXT_DIAG keyWindow=\(key.title)\n".utf8))
            } else {
                FileHandle.standardError.write(Data("TXT_DIAG keyWindow=none\n".utf8))
            }
        }
    }

    /// Walks the AppKit view tree and collects visible text.
    private static func collectText(from view: NSView) -> [String] {
        var out: [String] = []
        if let textField = view as? NSTextField, !textField.stringValue.isEmpty {
            out.append(textField.stringValue)
        }
        if let button = view as? NSButton, !button.title.isEmpty {
            out.append("[\(button.title)]")
        }
        if let textView = view as? NSTextView, !textView.string.isEmpty {
            out.append("editor:\(textView.string.prefix(40))")
        }
        for subview in view.subviews {
            out.append(contentsOf: collectText(from: subview))
        }
        return out
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

/// Chooses between the gate and the editing surface (spec §4.6).
struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.phase {
            case .editing:
                ContentView()
            default:
                GateView()
            }
        }
        .frame(minWidth: 400, minHeight: 320)
        .accessibilityLabel("テキスト")
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Form {
            Section("セキュリティ") {
                Toggle(
                    "この端末ではパスキーなしで開く",
                    isOn: Binding(
                        get: { model.keepsKeyOnDevice },
                        set: { model.setKeepKeyOnDevice($0) }
                    )
                )
                Text("解除した鍵をこの端末のKeychainに保持し、次回の起動でパスキーを省略します。明示ロックとログアウトで削除されます。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("同期") {
                Text("保存は入力の確定後すぐに始まり、他の端末には数秒で反映されます。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let status = model.statusText {
                    Text(status)
                        .font(.footnote)
                }
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
