import AppKit
import SwiftUI
import TxtCore

/// The macOS window (spec §4.4).
///
/// A standard SwiftUI window with the integrated toolbar: `paperclip` and
/// `ellipsis` on the right, no title, no document list. The body is the
/// TextKit editing surface; the window never becomes a WebView or an
/// iPhone-shaped layout.
struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        EditorTextView(
            document: model.document,
            mediaProvider: { model.mediaInfo($0) },
            onDocumentChange: { model.documentChanged($0) },
            onComposingChange: { model.composingChanged($0) },
            onFilesDropped: { urls, _ in model.attachFiles(urls, at: nil) }
        )
        .frame(minWidth: 400, minHeight: 320)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    model.isImporterPresented = true
                } label: {
                    Label("添付", systemImage: "paperclip")
                }
                .help("画像・動画・音声を添付")
                .disabled(!model.isUnlocked)

                Menu {
                    Button("この端末に鍵を保持") { model.keepKeyOnDevice() }
                        .disabled(!model.isUnlocked || model.keepsKeyOnDevice)
                    Button("今すぐロック") { model.lockNow() }
                        .disabled(!model.isUnlocked)
                    Divider()
                    Button("パスキーを追加") { model.addPasskey() }
                        .disabled(!model.isUnlocked)
                    Button("復旧キーを再発行") { model.rotateRecoveryKey() }
                        .disabled(!model.isUnlocked)
                    Divider()
                    Button("ログアウト") { model.logOut() }
                    Button("アカウントを削除", role: .destructive) { model.deleteAccount() }
                } label: {
                    Label("その他", systemImage: "ellipsis")
                }
                .help("その他の操作")
            }
        }
        .overlay(alignment: .bottom) {
            if let status = model.statusText {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 12)
                    .transition(.opacity)
            }
        }
        .fileImporter(
            isPresented: $model.isImporterPresented,
            allowedContentTypes: model.allowedContentTypes,
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                model.attachFiles(urls, at: nil)
            }
        }
    }
}

/// The gate screens (spec §4.6): 未登録, 復旧, ロック中, エラー.
struct GateView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: model.gateSymbol)
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text(model.gateTitle)
                .font(.title2)
                .multilineTextAlignment(.center)
            Text(model.gateBody)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            HStack(spacing: 12) {
                Button(model.gatePrimaryLabel) {
                    model.performGatePrimary()
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.gateBusy)
                if model.gateShowsRecovery {
                    Button("復旧キーで開く") {
                        model.isRecoveryPresented = true
                    }
                }
                if model.gateShowsRegister {
                    Button("はじめて使う") {
                        model.registerNewAccount()
                    }
                }
            }
            if model.gateBusy {
                ProgressView()
                    .controlSize(.small)
            }
            Spacer()
        }
        .padding(32)
        .frame(minWidth: 400, minHeight: 320)
        .sheet(isPresented: $model.isRecoveryPresented) {
            RecoverySheet()
        }
        .sheet(isPresented: $model.isPasskeySheetPresented) {
            PasskeySheet()
        }
    }
}

/// Recovery key entry (spec §7.1). The seed never leaves the device.
struct RecoverySheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("復旧キーで開く")
                .font(.headline)
            Text("TXT1. で始まるキーを貼り付けてください。")
                .font(.callout)
                .foregroundStyle(.secondary)
            TextEditor(text: $text)
                .font(.monospaced(.body)())
                .frame(minHeight: 90)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            HStack {
                Spacer()
                Button("キャンセル") { dismiss() }
                Button("開く") {
                    model.recover(with: text)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

/// Passkey registration for a new account (spec §5.2).
struct PasskeySheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var recoveryText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("復旧キーを保存してください")
                .font(.headline)
            Text(RECOVERY_HELP_JA)
                .font(.callout)
                .foregroundStyle(.secondary)
            ScrollView {
                Text(recoveryText.isEmpty ? model.pendingRecoveryKey : recoveryText)
                    .font(.monospaced(.body)())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 80)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            HStack {
                Button("コピー") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.pendingRecoveryKey, forType: .string)
                }
                Spacer()
                Button("保存しました") {
                    model.confirmRecoverySaved()
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { recoveryText = model.pendingRecoveryKey }
    }
}

/// Japanese wording for the recovery key, matching the Web copy (spec §7.1).
let RECOVERY_HELP_JA = """
このキーは、パスキーを使えなくなったときに内容を開くための唯一の方法です。\
パスワード管理アプリなど、安全な場所に保存してください。\
このキーを持つ人は内容を復号できます。
"""
