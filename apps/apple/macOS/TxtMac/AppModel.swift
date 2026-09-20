import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers
import TxtCore

/// Application state (spec §4.6, §5, §6, §10).
///
/// Owns the gate/unlocked state machine, the passkey + VaultKey flow, the sync
/// engine and the media attachment pipeline. The sync actor cannot read
/// `@Published` state, so the committed document and the IME safe point are
/// mirrored into `SharedEditorState` under a lock (spec §10.1).
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
    @Published var isImporterPresented = false
    @Published var isRecoveryPresented = false
    @Published var isPasskeySheetPresented = false
    @Published private(set) var pendingRecoveryKey = ""
    @Published private(set) var attachProgress: [String: Double] = [:]

    let allowedContentTypes: [UTType] = [
        .image, .movie, .video, .audio, .mpeg4Movie, .quickTimeMovie, .mp3, .wav, .aiff,
    ]

    private let api: ApiClient
    private let bridge = CryptoBridge()
    private let passkeys = PasskeyClient()
    private let draftStore = DraftStore()
    private let origin: URL
    private let rpId: String
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

    init(origin: URL = URL(string: "https://txt.2-38.com")!, rpId: String = "txt.2-38.com") {
        self.origin = origin
        self.rpId = rpId
        self.api = ApiClient(origin: origin, tokenProvider: { SessionTokenStore.load() })
    }

    // MARK: - Lifecycle

    func onAppear() async {
        observeWorkspace()
        await boot()
    }

    private func observeWorkspace() {
        let center = NotificationCenter.default
        center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.becameActive() }
        }
        center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.resignedActive() }
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
        diag("boot:start")
        do {
            let session = try await api.session()
            diag("boot:session-scope=\(session.scope)")
            accountId = session.accountId
            if session.scope == "pending" {
                phase = .gate(.completingRegistration)
                return
            }
            if let stored = VaultKeyStore.load(accountId: session.accountId) {
                diag("boot:kept-key-found")
                keepsKeyOnDevice = true
                await startSession(vaultKey: stored, accountId: session.accountId)
                return
            }
            diag("boot:gate-needs-unlock")
            phase = .gate(.needsUnlock(reason: "暗号化された内容を開くため、パスキーを確認します。"))
        } catch let error as TxtError {
            diag("boot:error=\(Self.describe(error))")
            if case .api(401, _, _) = error {
                phase = .gate(.firstVisit)
            } else {
                phase = .gate(.error(Self.describe(error)))
            }
        } catch {
            diag("boot:error=\(error.localizedDescription)")
            phase = .gate(.error(error.localizedDescription))
        }
    }

    /// Writes a one-line trace to stderr when diagnostics are enabled.
    ///
    /// The app cannot be driven over SSH (no window-server connection, no
    /// Accessibility permissions), so this trace is how the boot flow is
    /// verified on a machine without an interactive session.
    private func diag(_ message: String) {
        guard ProcessInfo.processInfo.environment["TXT_DIAGNOSTICS"] != nil else { return }
        FileHandle.standardError.write(Data("TXT_DIAG \(message)\n".utf8))
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
        case .gate(.error(let message)): "\(message)。データは変更していません。"
        case .editing: ""
        }
    }

    var gatePrimaryLabel: String {
        switch phase {
        case .gate(.needsUnlock), .gate(.completingRegistration): "パスキーで開く"
        default: "パスキーを作成して始める"
        }
    }

    var gateBusy: Bool {
        if case .loading = phase { return true }
        return false
    }

    var gateShowsRecovery: Bool {
        switch phase {
        case .gate(.needsUnlock), .gate(.completingRegistration), .gate(.error): true
        default: false
        }
    }

    var gateShowsRegister: Bool {
        switch phase {
        case .gate(.needsUnlock), .gate(.error): true
        default: false
        }
    }

    var gateSymbol: String {
        switch phase {
        case .gate(.error): "exclamationmark.triangle"
        case .gate(.needsUnlock), .gate(.completingRegistration): "lock"
        default: "text.page"
        }
    }

    var isUnlocked: Bool { vaultKey != nil }

    func performGatePrimary() {
        Task {
            switch phase {
            case .gate(.firstVisit), .gate(.error):
                await register()
            default:
                await unlock()
            }
        }
    }

    func registerNewAccount() {
        Task { await register() }
    }

    // MARK: - Registration (spec §5.3)

    private func register() async {
        phase = .loading
        do {
            let options = try await api.registerOptions()
            let ceremony = try await passkeys.createCredential(options: options.options, rpId: rpId)
            guard let prfOutput = ceremony.prfOutput else { throw PasskeyClient.PasskeyError.noPrf }

            let vaultKey = TxtCrypto.randomBytes(TxtCrypto.keyBytes)
            let wrapSalt = TxtCrypto.randomBytes(TxtCrypto.keyBytes)
            let kek = try TxtCrypto.deriveKek(
                prfOutput: prfOutput,
                wrapSalt: wrapSalt,
                accountId: options.accountId,
                credentialId: ceremony.credentialIdRaw
            )
            let aad = try TxtCrypto.vaultKeyAad(
                formatVersion: UInt64(DocumentLimits.formatVersion),
                keyVersion: UInt64(DocumentLimits.keyVersion),
                accountId: options.accountId,
                credentialId: ceremony.credentialIdRaw
            )
            let (nonce, wrapped) = try TxtCrypto.wrapVaultKey(vaultKey: vaultKey, kek: kek, aad: aad)

            let seed = TxtCrypto.randomBytes(TxtCrypto.keyBytes)
            let recoveryAuth = try TxtCrypto.deriveRecoveryAuth(seed: seed, accountId: options.accountId)
            let recoveryKek = try TxtCrypto.deriveRecoveryKek(seed: seed, accountId: options.accountId)
            let recoveryAadBytes = try TxtCrypto.recoveryAad(
                accountId: options.accountId,
                recoveryVersion: 1,
                keyVersion: UInt64(DocumentLimits.keyVersion)
            )
            let (recoveryNonce, recoveryWrapped) = try TxtCrypto.wrapVaultKey(
                vaultKey: vaultKey,
                kek: recoveryKek,
                aad: recoveryAadBytes
            )
            let recoveryKeyText = try TxtCrypto.formatRecoveryKey(accountId: options.accountId, seed: seed)
            let authHash = TxtCrypto.sha256(recoveryAuth)

            let documentId = UUID().uuidString.lowercased()
            let bootstrapId = UUID().uuidString.lowercased()
            let empty = DocumentModel.empty()
            let snapshotKey = try TxtCrypto.deriveDocumentKey(
                vaultKey: vaultKey,
                mutationId: bootstrapId,
                accountId: options.accountId,
                documentId: documentId,
                keyVersion: UInt64(DocumentLimits.keyVersion)
            )
            let docAad = try TxtCrypto.documentAad(
                formatVersion: UInt64(DocumentLimits.formatVersion),
                keyVersion: UInt64(DocumentLimits.keyVersion),
                accountId: options.accountId,
                documentId: documentId,
                mutationId: bootstrapId,
                encryptedRevision: 0
            )
            let docNonce = TxtCrypto.randomBytes(TxtCrypto.nonceBytes)
            let docCipher = try TxtCrypto.aesGcmEncrypt(
                key: snapshotKey,
                nonce: docNonce,
                plaintext: [UInt8](try DocumentCodec.serialize(empty).utf8),
                aad: docAad
            )

            _ = try await api.bootstrap([
                "bootstrapId": bootstrapId,
                "credentialId": ceremony.credentialId,
                "envelope": [
                    "credentialId": ceremony.credentialId,
                    "formatVersion": DocumentLimits.formatVersion,
                    "keyVersion": DocumentLimits.keyVersion,
                    "wrapSalt32": Base64Url.encode(wrapSalt),
                    "nonce": Base64Url.encode(nonce),
                    "wrappedKey": Base64Url.encode(wrapped),
                ],
                "recovery": [
                    "recoveryVersion": 1,
                    "keyVersion": DocumentLimits.keyVersion,
                    "authHash32": Base64Url.encode(authHash),
                    "nonce": Base64Url.encode(recoveryNonce),
                    "wrappedKey": Base64Url.encode(recoveryWrapped),
                ],
                "document": [
                    "documentId": documentId,
                    "formatVersion": DocumentLimits.formatVersion,
                    "keyVersion": DocumentLimits.keyVersion,
                    "nonce": Base64Url.encode(docNonce),
                    "ciphertext": Base64Url.encode(docCipher),
                ],
            ])

            pendingRecoveryKey = recoveryKeyText
            isPasskeySheetPresented = true
            VaultKeyStore.store(vaultKey: vaultKey, accountId: options.accountId)
            keepsKeyOnDevice = true
            await startSession(vaultKey: vaultKey, accountId: options.accountId)
        } catch {
            phase = .gate(.error(Self.describe(error)))
        }
    }

    func confirmRecoverySaved() {
        pendingRecoveryKey = ""
    }

    // MARK: - Unlock (spec §6.2)

    private func unlock() async {
        phase = .loading
        do {
            let options = try await api.loginOptions()
            let ceremony = try await passkeys.assertCredential(options: options.options, rpId: rpId)
            guard let prfOutput = ceremony.prfOutput else { throw PasskeyClient.PasskeyError.noPrf }
            let keys = try await api.keys(credentialId: ceremony.credentialId)
            guard let envelope = keys.envelopes.first(where: { $0.credentialId == ceremony.credentialId })
                ?? keys.envelopes.first
            else {
                throw TxtError.decoding("このパスキー用の鍵が見つかりません。")
            }
            let kek = try TxtCrypto.deriveKek(
                prfOutput: prfOutput,
                wrapSalt: try Base64Url.decode(envelope.wrapSalt32),
                accountId: accountId ?? "",
                credentialId: ceremony.credentialIdRaw
            )
            let aad = try TxtCrypto.vaultKeyAad(
                formatVersion: UInt64(envelope.formatVersion),
                keyVersion: UInt64(envelope.keyVersion),
                accountId: accountId ?? "",
                credentialId: ceremony.credentialIdRaw
            )
            let vaultKey = try TxtCrypto.unwrapVaultKey(
                kek: kek,
                nonce: try Base64Url.decode(envelope.nonce),
                wrappedKey: try Base64Url.decode(envelope.wrappedKey),
                aad: aad
            )
            if let resolved = accountId {
                VaultKeyStore.store(vaultKey: vaultKey, accountId: resolved)
                keepsKeyOnDevice = true
            }
            await startSession(vaultKey: vaultKey, accountId: accountId ?? "")
        } catch {
            phase = .gate(.error(Self.describe(error)))
        }
    }

    // MARK: - Session

    private func startSession(vaultKey: [UInt8], accountId: String) async {
        do {
            setStatus("読み込み中")
            let first = try await api.document()
            guard let response = first.data else { throw TxtError.decoding("文書を取得できません。") }
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
        switch state {
        case .idle:
            setStatus(nil)
        case .saved:
            setStatus(state.label)
        case .saving, .localOnly, .offline, .conflict, .authExpired, .decryptFailed:
            setStatus(state.label)
        }
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
        let alert = NSAlert()
        alert.messageText = "競合しています"
        alert.informativeText = "この端末の内容と、サーバーに保存されている内容が異なります。"
        alert.addButton(withTitle: "編集して保存")
        alert.addButton(withTitle: "サーバーの内容を使う")
        return alert.runModal() == .alertFirstButtonReturn ? .keepLocal : .useRemote
    }

    // MARK: - Attachments (spec §11.3)

    func attachFiles(_ urls: [URL], at position: Int?) {
        guard isUnlocked else { return }
        Task { await attach(urls, at: position) }
    }

    private func attach(_ urls: [URL], at position: Int?) async {
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
                let index = position ?? max(0, document.blocks.count - 1)
                let next = EditorBridge.insertMediaAtBoundary(document, mediaId: mediaId, position: index)
                documentChanged(next)
            } catch {
                setStatus("添付に失敗しました: \(Self.describe(error))")
            }
        }
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
        if forgetKey, let accountId { _ = VaultKeyStore.delete(accountId: accountId) }
        keepsKeyOnDevice = false
        vaultKey = nil
        shared.document = DocumentModel.empty()
        shared.isComposing = false
        document = DocumentModel.empty()
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
        let alert = NSAlert()
        alert.messageText = "アカウントを削除しますか"
        alert.informativeText = "本文・添付・鍵が削除され、元に戻せません。"
        alert.addButton(withTitle: "削除する")
        alert.addButton(withTitle: "やめる")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
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
                let parsed = try TxtCrypto.parseRecoveryKey(text)
                let auth = try TxtCrypto.deriveRecoveryAuth(seed: parsed.seed, accountId: parsed.accountId)
                _ = try await api.recoveryStart(
                    accountId: parsed.accountId,
                    recoveryAuth: Base64Url.encode(auth)
                )
                let keys = try await api.keys()
                guard let record = keys.recovery else {
                    throw TxtError.decoding("復旧情報が見つかりません。")
                }
                let kek = try TxtCrypto.deriveRecoveryKek(seed: parsed.seed, accountId: parsed.accountId)
                let aad = try TxtCrypto.recoveryAad(
                    accountId: parsed.accountId,
                    recoveryVersion: UInt64(record.recoveryVersion),
                    keyVersion: UInt64(record.keyVersion)
                )
                let vaultKey = try TxtCrypto.unwrapVaultKey(
                    kek: kek,
                    nonce: try Base64Url.decode(record.nonce),
                    wrappedKey: try Base64Url.decode(record.wrappedKey),
                    aad: aad
                )
                VaultKeyStore.store(vaultKey: vaultKey, accountId: parsed.accountId)
                keepsKeyOnDevice = true
                await startSession(vaultKey: vaultKey, accountId: parsed.accountId)
            } catch {
                phase = .gate(.error(Self.describe(error)))
            }
        }
    }

    // MARK: - Helpers

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
