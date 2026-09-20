import SwiftUI
import TxtCore
import UIKit

/// The iOS editing screen (spec §4.3).
///
/// Standard toolbar (`paperclip`, `ellipsis`), no title, keyboard appears only
/// when the body is tapped. Media plays inline with the standard player; the
/// sync status only shows while it matters.
struct EditingView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        EditorTextView(
            document: model.document,
            mediaProvider: { model.mediaInfo($0) },
            onDocumentChange: { model.documentChanged($0) },
            onComposingChange: { model.composingChanged($0) },
            onFilesDropped: { model.attachFiles($0) }
        )
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    // The caret is captured before the picker takes over, so the
                    // attachment lands where the user was typing (spec §11.3).
                    model.pendingInsertionIndex = nil
                    model.isPickerPresented = true
                } label: {
                    Label("添付", systemImage: "paperclip")
                }
                .disabled(!model.isUnlocked)

                Menu {
                    Button("この端末に鍵を保持") { model.keepKeyOnDevice() }
                        .disabled(!model.isUnlocked || model.keepsKeyOnDevice)
                    Button("今すぐロック") { model.lockNow() }
                        .disabled(!model.isUnlocked)
                    Divider()
                    Button("パスキーを追加") { model.addPasskey() }
                    Button("復旧キーを再発行") { model.rotateRecoveryKey() }
                    Divider()
                    Button("ログアウト") { model.logOut() }
                    Button("アカウントを削除", role: .destructive) { model.deleteAccount() }
                } label: {
                    Label("その他", systemImage: "ellipsis")
                }
            }
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: 6) {
                if !model.attachProgress.isEmpty {
                    VStack(spacing: 4) {
                        ForEach(Array(model.attachProgress.keys), id: \.self) { key in
                            HStack(spacing: 8) {
                                Text(key).font(.caption).lineLimit(1)
                                ProgressView(value: model.attachProgress[key] ?? 0)
                                    .frame(width: 120)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                }
                if let status = model.statusText {
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.thinMaterial, in: Capsule())
                }
            }
            .padding(.bottom, 12)
        }
        .sheet(isPresented: $model.isPickerPresented) {
            MediaPicker { urls in
                model.attachFiles(urls)
            }
        }
        .alert("競合しています", isPresented: Binding(
            get: { model.pendingConflict != nil },
            set: { if !$0 { model.pendingConflict = nil } }
        )) {
            Button("編集して保存") { model.resolveConflict(.keepLocal) }
            Button("サーバーの内容を使う") { model.resolveConflict(.useRemote) }
        } message: {
            Text("この端末の内容と、サーバーに保存されている内容が異なります。")
        }
    }
}

/// The gate screens (spec §4.6).
struct GateView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: gateSymbol)
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text(model.gateTitle)
                .font(.title2)
                .multilineTextAlignment(.center)
            Text(model.gateBody)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            VStack(spacing: 12) {
                Button(model.gatePrimaryLabel) {
                    model.performGatePrimary()
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.gateBusy)
                if model.gateShowsRecovery {
                    Button("復旧キーで開く") { model.isRecoveryPresented = true }
                }
                if model.gateShowsRegister {
                    Button("はじめて使う") { model.registerNewAccount() }
                }
            }
            if model.gateBusy {
                ProgressView()
            }
            Spacer()
        }
        .sheet(isPresented: $model.isRecoveryPresented) {
            RecoverySheet()
        }
        .sheet(isPresented: $model.isRecoveryKeySheetPresented) {
            RecoveryKeySheet()
        }
    }

    private var gateSymbol: String {
        switch model.phase {
        case .gate(.error): "exclamationmark.triangle"
        case .gate(.needsUnlock), .gate(.completingRegistration): "lock"
        default: "text.page"
        }
    }
}

/// Recovery key entry (spec §7.1). The seed never leaves the device.
struct RecoverySheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("復旧キー") {
                    TextEditor(text: $text)
                        .font(.monospaced(.body)())
                        .frame(minHeight: 100)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Section {
                    Text("TXT1. で始まるキーを貼り付けてください。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("復旧キーで開く")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("開く") {
                        model.recover(with: text)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

/// Shows the recovery key once after registration (spec §5.3).
struct RecoveryKeySheet: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("このキーは、パスキーを使えなくなったときに内容を開くための唯一の方法です。パスワード管理アプリなど、安全な場所に保存してください。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                ScrollView {
                    Text(model.pendingRecoveryKey)
                        .font(.monospaced(.body)())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 100)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                Button("コピー") {
                    UIPasteboard.general.string = model.pendingRecoveryKey
                }
                Spacer()
            }
            .padding(20)
            .navigationTitle("復旧キーを保存してください")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存しました") { model.confirmRecoverySaved() }
                }
            }
        }
        .interactiveDismissDisabled()
    }
}
