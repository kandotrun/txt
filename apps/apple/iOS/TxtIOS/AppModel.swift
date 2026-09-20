import AVFoundation
import Combine
import SwiftUI
import TxtCore
import UIKit

/// Application state (spec §4.3, §4.6, §5, §6, §10).
///
/// Same state machine as the macOS app — gate, unlock, sync, lock — with iOS
/// specifics: the app is a single scene, media playback uses the decrypted
/// range loader, and backgrounding is observed through `UIApplication`
/// notifications so a relock can be enforced on return.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case gate(Gate)
        case editing
    }

    enum Gate: Equatable {
        case firstVisit
        case needsUnlock(reason: String)
        case completingRegistration
        case error(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var document = DocumentModel.empty()
    @Published private(set) var syncState: SyncState = .idle
    @Published private(set) var statusText: String?
    @Published private(set) var keepsKeyOnDevice = false
    @Published var isPickerPresented = false
    @Published var isRecoveryPresented = false
    @Published var isRecoveryKeySheetPresented = false
    @Published private(set) var pendingRecoveryKey = ""
    @Published private(set) var attachProgress: [String: Double] = [:]

    private let api: ApiClient
    private let bridge = CryptoBridge()
    private let passkeys = PasskeyClient()
    private let draftStore = DraftStore()
    private let players = MediaPlayerRegistry()
    private let rpId = "txt.2-38.com"
    private let shared = SharedEditorState()
    private var sync: SyncEngine?
    private var vaultKey: [UInt8]?
    private var accountId: String?
    private var documentId: String?
    private var keyVersion = DocumentLimits.keyVersion
    private var statusTask: Task<Void, Never>?
    private var lockTask: Task<Void, Never>?
    private var lastActivity = Date()
    private let lockAfterSeconds: TimeInterval = 5 * 60

    init() {
        self.api = ApiClient(
            origin: URL(string: "https://txt.2-38.com")!,
            tokenProvider: { SessionTokenStore.load() }
        )
    }

    // MARK: - Lifecycle

    func onAppear() async {
        observeApplication()
        await boot()
    }

    private func observeApplication() {
        let center = NotificationCenter.default
        center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.becameActive() }
        }
        center.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.resignedActive() }
        }
        // A lock screen or a system lock must protect the plaintext (§6.4).
        center.addObserver(
            forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.lock(reason: "端末がロックされました。", forgetKey: false)
            }
        }
    }

    private func becameActive() async {
        if vaultKey != nil, Date().timeIntervalSince(lastActivity) > lockAfterSeconds {
            lock(reason: "一定時間操作がありませんでした。", forgetKey: false)
            return
        }
        lastActivity = Date()
        await sync?.refreshNow()
        scheduleLockTimer()
    }

    private func resignedActive() {
        lastActivity = Date()
        if let sync {
            Task { await sync.saveNow() }
        }
    }

    private func scheduleLockTimer() {
        lockTask?.cancel()
        lockTask = Task { [weak self] in
            let seconds = self?.lockAfterSeconds ?? 300
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.vaultKey != nil else { return }
                self.lock(reason: "一定時間操作がありませんでした。", forgetKey: false)
            }
        }
    }

    // MARK: - Boot

    private func boot() async {
        do {
            let session = try await api.session()
            accountId = session.accountId
            if session.scope == "pending" {
                phase = .gate(.completingRegistration)
                return
            }
            if let stored = VaultKeyStore.load(accountId: session.accountId) {
                keepsKeyOnDevice = true
                await startSession(vaultKey: stored, accountId: session.accountId)
                return
            }
            phase = .gate(.needsUnlock(reason: "暗号化された内容を開くため、パスキーを確認します。"))
        } catch let error as TxtError {
            if case .api(401, _, _) = error {
                phase = .gate(.firstVisit)
            } else {
                phase = .gate(.error(Self.describe(error)))
            }
        } catch {
            phase = .gate(.error(error.localizedDescription))
        }
    }

    // MARK: - Gate copy (spec §4.6)

    var gateTitle: String {
        switch phase {
        case .loading: "読み込み中"
        case .gate(.firstVisit): "メールアドレスなしで、1枚のテキストを。"
        case .gate(.needsUnlock): "パスキーで開く"
        case .gate(.completingRegistration): "登録を完了してください"
        case .gate(.error): "開けませんでした"
        case .editing: ""
        }
    }

    var gateBody: String {
        switch phase {
        case .loading: ""
        case .gate(.firstVisit):
            "パスキーで暗号化された、あなた専用の1枚です。本文と添付は端末で暗号化され、サーバーには暗号文だけが保存されます。"
        case .gate(.needsUnlock(let reason)): reason
        case .gate(.completingRegistration): "パスキーは作成済みですが、準備が完了していません。"
        case .gate(.error(let message)):
            // Do not double the terminator: mapped errors can already end with
            // one (English system text ends with ".", Japanese with "。").
            "\(Self.terminated(message)) データは変更していません。"
        case .editing: ""
        }
    }

    /// Gate actions come from the shared table in TxtCore (spec §4.6) so both
    /// apps and any future one behave identically. The rules are unit-tested;
    /// see GatePresentationTests.
    private var gateState: GatePresentation.State {
        switch phase {
        case .loading: .loading
        case .gate(.firstVisit): .firstVisit
        case .gate(.needsUnlock): .needsUnlock
        case .gate(.completingRegistration): .completingRegistration
        case .gate(.error): .error
        case .editing: .loading
        }
    }

    var gatePrimaryLabel: String { GatePresentation.actions(for: gateState).primary }

    var gateBusy: Bool {
        if case .loading = phase { return true }
        return false
    }

    var gateShowsRecovery: Bool { GatePresentation.actions(for: gateState).showsRecovery }

    var gateShowsRegister: Bool { GatePresentation.actions(for: gateState).showsRegister }

    var isUnlocked: Bool { vaultKey != nil }

    func performGatePrimary() {
        let actions = GatePresentation.actions(for: gateState)
        guard !actions.primary.isEmpty else { return }
        Task {
            if actions.primaryUnlocks {
                // The primary action never creates an account: a second account
                // is a deliberate choice made through "はじめて使う" (spec §4.6).
                await unlock()
            } else {
                await register()
            }
        }
    }

    /// Explicit "はじめて使う" — the only path that creates a new account.
    func registerNewAccount() {
        Task { await register() }
    }

    // MARK: - Registration (spec §5.3)

    private func register() async {
        phase = .loading
        do {
            let outcome = try await AccountFlow.register(api: api, ceremonies: passkeys, rpId: rpId)
            pendingRecoveryKey = outcome.recoveryKeyText
            isRecoveryKeySheetPresented = true
            VaultKeyStore.store(vaultKey: outcome.vaultKey, accountId: outcome.accountId)
            keepsKeyOnDevice = true
            await startSession(
                vaultKey: outcome.vaultKey,
                accountId: outcome.accountId,
                documentId: outcome.documentId
            )
        } catch {
            phase = .gate(.error(Self.describe(error)))
        }
    }

    func confirmRecoverySaved() {
        pendingRecoveryKey = ""
        isRecoveryKeySheetPresented = false
    }

    // MARK: - Unlock (spec §6.2)

    private func unlock() async {
        phase = .loading
        do {
            let resolved: AccountFlow.UnlockedVault
            if let existing = accountId {
                resolved = try await AccountFlow.unlockExisting(
                    api: api, ceremonies: passkeys, rpId: rpId, accountId: existing
                )
            } else {
                resolved = try await AccountFlow.loginAndUnlock(api: api, ceremonies: passkeys, rpId: rpId)
            }
            VaultKeyStore.store(vaultKey: resolved.vaultKey, accountId: resolved.accountId)
            keepsKeyOnDevice = true
            await startSession(
                vaultKey: resolved.vaultKey,
                accountId: resolved.accountId,
                documentId: resolved.documentId
            )
        } catch {
            phase = .gate(.error(Self.describe(error)))
        }
    }

    // MARK: - Session

    private func startSession(
        vaultKey: [UInt8],
        accountId: String,
        documentId expectedDocumentId: String? = nil
    ) async {
        do {
            setStatus("読み込み中")
            let first = try await api.document()
            guard let response = first.data else { throw TxtError.decoding("文書を取得できません。") }
            if let expectedDocumentId, expectedDocumentId != response.documentId {
                throw TxtError.decoding("サーバーの文書が一致しません。")
            }
            self.accountId = accountId
            self.documentId = response.documentId
            self.keyVersion = response.keyVersion
            self.vaultKey = vaultKey

            await bridge.unlock(
                vaultKey: vaultKey,
                accountId: accountId,
                documentId: response.documentId,
                keyVersion: response.keyVersion
            )
            let plaintext = try await bridge.decryptDocument(
                nonce: response.nonce,
                ciphertext: response.ciphertext,
                mutationId: response.mutationId,
                encryptedRevision: response.encryptedRevision,
                formatVersion: response.formatVersion,
                keyVersion: response.keyVersion
            )
            let parsed = try DocumentCodec.parse(plaintext)
            let repaired = DocumentRepairer.repair(parsed)
            document = repaired?.document ?? parsed
            shared.document = document

            let engine = SyncEngine(options: SyncEngine.Options(
                bridge: bridge,
                api: api,
                callbacks: SyncEngine.Callbacks(
                    getDocument: { [shared] in shared.document },
                    applyRemote: { [weak self] remote, fromAdoption in
                        Task { @MainActor in
                            self?.document = remote
                            self?.shared.document = remote
                            if fromAdoption {
                                self?.setStatus("サーバーの内容を採用しました。")
                            }
                        }
                    },
                    onState: { [weak self] state in
                        Task { @MainActor in self?.applySyncState(state) }
                    },
                    onConflict: { [weak self] details in
                        await MainActor.run { self?.promptConflict(details) ?? .pending }
                    },
                    isSafePoint: { [shared] in shared.isSafePoint }
                ),
                accountId: accountId,
                documentId: response.documentId,
                keyVersion: response.keyVersion,
                vaultKey: vaultKey,
                baseEtag: first.etag,
                baseRevision: response.revision,
                draftStore: draftStore
            ))
            sync = engine
            await engine.start()
            phase = .editing
            setStatus(nil)
            scheduleLockTimer()
        } catch {
            phase = .gate(.error(Self.describe(error)))
        }
    }

    // MARK: - Editing bridge

    func mediaInfo(_ mediaId: String) -> MediaInfo? {
        document.media[mediaId]
    }

    func documentChanged(_ next: DocumentModel) {
        shared.document = next
        document = next
        lastActivity = Date()
        Task { await sync?.noteCommittedChange() }
    }

    func composingChanged(_ composing: Bool) {
        shared.isComposing = composing
        if !composing {
            Task { await sync?.noteCommittedChange() }
        }
    }

    func saveNow() async {
        await sync?.saveNow()
    }

    func setKeepKeyOnDevice(_ enabled: Bool) {
        if enabled {
            keepKeyOnDevice()
        } else {
            if let accountId { _ = VaultKeyStore.delete(accountId: accountId) }
            keepsKeyOnDevice = false
            setStatus("この端末での鍵の保持を解除しました。")
        }
    }

    private func applySyncState(_ state: SyncState) {
        syncState = state
        setStatus(state.label.isEmpty ? nil : state.label)
    }

    private func setStatus(_ text: String?) {
        statusTask?.cancel()
        statusText = text
        guard let text else { return }
        statusTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                if self?.statusText == text { self?.statusText = nil }
            }
        }
    }

    private func promptConflict(_ details: ConflictDetails) -> ConflictDecision {
        // iOS uses a SwiftUI alert; the model exposes the pending conflict and
        // the view drives the decision.
        pendingConflict = details
        return .pending
    }

    /// Conflict awaiting a user decision in the view (spec §10.4).
    @Published var pendingConflict: ConflictDetails?

    func resolveConflict(_ decision: ConflictDecision) {
        pendingConflict = nil
        Task { await sync?.resolvePendingConflict(decision) }
    }

    // MARK: - Attachments (spec §11.3)

    func attachFiles(_ urls: [URL]) {
        guard isUnlocked else { return }
        Task { await attach(urls) }
    }

    private func attach(_ urls: [URL]) async {
        for url in urls {
            let key = url.lastPathComponent
            attachProgress[key] = 0
            defer { attachProgress[key] = nil }
            do {
                let mediaId = try await MediaUploader.upload(
                    url: url,
                    documentId: documentId ?? "",
                    api: api,
                    bridge: bridge,
                    onProgress: { [weak self] fraction in
                        Task { @MainActor in self?.attachProgress[key] = fraction }
                    }
                )
                // A pending attachment lands at the caret when the editor knows
                // it, otherwise at the end (spec §11.3).
                let next = EditorBridge.insertMediaAtBoundary(
                    document,
                    mediaId: mediaId,
                    position: pendingInsertionIndex ?? max(0, document.blocks.count - 1)
                )
                pendingInsertionIndex = nil
                documentChanged(next)
            } catch {
                setStatus("添付に失敗しました: \(Self.describe(error))")
            }
        }
    }

    /// Caret position captured when the attach button is pressed: the picker
    /// takes over the UI, and iOS can reset the selection while it is open.
    var pendingInsertionIndex: Int?

    // MARK: - Media playback

    func player(for mediaId: String) -> AVPlayer? {
        guard let info = document.media[mediaId] else { return nil }
        return players.player(mediaId: mediaId, info: info, api: api, bridge: bridge)
    }

    // MARK: - Key management

    func keepKeyOnDevice() {
        guard let accountId, let vaultKey else { return }
        if VaultKeyStore.store(vaultKey: vaultKey, accountId: accountId) {
            keepsKeyOnDevice = true
            setStatus("この端末に鍵を保持しました。")
        }
    }

    func lockNow() {
        lock(reason: "ロックしました。", forgetKey: true)
    }

    private func lock(reason: String, forgetKey: Bool) {
        if let sync {
            Task {
                await sync.saveNow()
                await sync.stop()
            }
        }
        sync = nil
        Task { await bridge.lock() }
        players.stopAll()
        if forgetKey, let accountId { _ = VaultKeyStore.delete(accountId: accountId) }
        keepsKeyOnDevice = false
        vaultKey = nil
        shared.document = DocumentModel.empty()
        shared.isComposing = false
        document = DocumentModel.empty()
        pendingConflict = nil
        phase = .gate(.needsUnlock(reason: reason))
    }

    func logOut() {
        let accountIdSnapshot = accountId
        Task {
            _ = try? await api.endSession()
            SessionTokenStore.delete()
            if let accountIdSnapshot { _ = VaultKeyStore.delete(accountId: accountIdSnapshot) }
        }
        lock(reason: "ログアウトしました。", forgetKey: true)
    }

    func addPasskey() {
        setStatus("パスキーの追加は現在準備中です。")
    }

    func rotateRecoveryKey() {
        setStatus("復旧キーの再発行は現在準備中です。")
    }

    func deleteAccount() {
        Task {
            do {
                _ = try await api.deleteAccount(operationId: UUID().uuidString.lowercased())
                SessionTokenStore.delete()
                if let accountId { _ = VaultKeyStore.delete(accountId: accountId) }
                lock(reason: "アカウントを削除しました。", forgetKey: true)
            } catch {
                setStatus("削除できませんでした: \(Self.describe(error))")
            }
        }
    }

    func recover(with text: String) {
        setStatus("復旧キーを確認しています……")
        Task {
            do {
                let resolved = try await AccountFlow.recover(api: api, recoveryKeyText: text)
                VaultKeyStore.store(vaultKey: resolved.vaultKey, accountId: resolved.accountId)
                keepsKeyOnDevice = true
                await startSession(
                    vaultKey: resolved.vaultKey,
                    accountId: resolved.accountId,
                    documentId: resolved.documentId
                )
            } catch {
                phase = .gate(.error(Self.describe(error)))
            }
        }
    }

    // MARK: - Helpers

    /// Ensures a sentence ends exactly once.
    static func terminated(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last else { return trimmed }
        if "。．.!?！？".contains(last) { return trimmed }
        return trimmed + "。"
    }

    static func describe(_ error: Error) -> String {
        if let passkey = error as? PasskeyClient.PasskeyError {
            return passkey.errorDescription ?? "パスキー操作に失敗しました。"
        }
        if let upload = error as? MediaUploader.UploadError {
            return upload.errorDescription ?? "添付に失敗しました。"
        }
        if let txt = error as? TxtError {
            switch txt {
            case .api(let status, let code, let message):
                return "通信に失敗しました (\(status) \(code)): \(message)"
            case .locked:
                return "ロックされています。"
            case .validation(let issues):
                return "本文を保存できません: \(issues.joined(separator: "; "))"
            case .decoding(let message), .network(let message), .crypto(let message):
                return message
            case .invalidIdentifier(let message), .invalidBase64Url(let message):
                return message
            case .unsafePoint:
                return "入力の確定を待っています。"
            }
        }
        return error.localizedDescription
    }
}
