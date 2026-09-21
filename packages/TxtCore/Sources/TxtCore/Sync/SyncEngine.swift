import Foundation

/// Sync timings (spec §10.2).
///
/// The Web app tuned these down for a seamless feel (300ms debounce / 2s
/// ceiling / 2.5s poll); native uses the same numbers so the two clients feel
/// identical and the Worker sees comparable traffic.
public enum SyncTimings {
    public static let debounceMs = 300
    public static let maxWaitMs = 2_000
    public static let activePollMs = 2_500
    public static let idlePollMs = 15_000
    public static let idleAfterMs = 60_000
    public static let maxBackoffMs = 30_000
    public static let savedIndicatorMs = 2_000
}

public enum SyncState: Sendable, Equatable {
    case idle
    case saving
    case saved
    case localOnly
    case offline
    case conflict
    case authExpired
    case decryptFailed

    /// User-facing text (spec §4.6). Kept here so both platforms stay identical.
    public var label: String {
        switch self {
        case .idle: ""
        case .saving: "保存中"
        case .saved: "同期済み"
        case .localOnly: "端末に保存済み・未同期"
        case .offline: "端末に保存済み・未同期"
        case .conflict: "競合を確認してください"
        case .authExpired: "再ログインが必要です"
        case .decryptFailed: "内容を開けません。データは変更していません。"
        }
    }
}

public struct ConflictDetails: Sendable {
    public var local: DocumentModel
    public var remote: DocumentModel
    public var remoteEtag: String
    public var remoteRevision: Int
}

public enum ConflictDecision: Sendable {
    case keepLocal
    case useRemote
    case pending
}

/// Sync engine (spec §10).
///
/// Mirrors the Web engine's responsibilities: debounced saves of a committed
/// snapshot, conditional GETs with a short poll, 412 recovery by comparing the
/// normalized model, bounded retry with backoff, and a local encrypted draft.
/// It is an actor so the network/async work never touches the UI thread.
public actor SyncEngine {
    public struct Callbacks: Sendable {
        public var getDocument: @Sendable () -> DocumentModel
        public var applyRemote: @Sendable (DocumentModel, Bool) -> Void
        public var onState: @Sendable (SyncState) -> Void
        public var onConflict: @Sendable (ConflictDetails) async -> ConflictDecision
        public var isSafePoint: @Sendable () -> Bool

        public init(
            getDocument: @escaping @Sendable () -> DocumentModel,
            applyRemote: @escaping @Sendable (DocumentModel, Bool) -> Void,
            onState: @escaping @Sendable (SyncState) -> Void,
            onConflict: @escaping @Sendable (ConflictDetails) async -> ConflictDecision,
            isSafePoint: @escaping @Sendable () -> Bool
        ) {
            self.getDocument = getDocument
            self.applyRemote = applyRemote
            self.onState = onState
            self.onConflict = onConflict
            self.isSafePoint = isSafePoint
        }
    }

    private let bridge: CryptoBridge
    private var api: ApiClient
    private let callbacks: Callbacks
    private let accountId: String
    private let documentId: String
    private let keyVersion: Int
    private let vaultKey: [UInt8]
    private let draftStore: DraftStore?

    private var baseEtag: String?
    private var baseRevision: Int
    private var editGeneration = 0
    private var committedGeneration = 0
    private var persistedGeneration = -1
    private var inFlight: (generation: Int, mutationId: String)?
    private var dirty = false
    private var stopped = false
    private var syncing = false
    private var backoffMs = 1_000
    private var lastInteraction = Date()
    private var debounceTask: Task<Void, Never>?
    private var maxWaitTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?

    public struct Options: Sendable {
        public var bridge: CryptoBridge
        public var api: ApiClient
        public var callbacks: Callbacks
        public var accountId: String
        public var documentId: String
        public var keyVersion: Int
        public var vaultKey: [UInt8]
        public var baseEtag: String?
        public var baseRevision: Int
        public var draftStore: DraftStore?

        public init(
            bridge: CryptoBridge,
            api: ApiClient,
            callbacks: Callbacks,
            accountId: String,
            documentId: String,
            keyVersion: Int,
            vaultKey: [UInt8],
            baseEtag: String?,
            baseRevision: Int,
            draftStore: DraftStore?
        ) {
            self.bridge = bridge
            self.api = api
            self.callbacks = callbacks
            self.accountId = accountId
            self.documentId = documentId
            self.keyVersion = keyVersion
            self.vaultKey = vaultKey
            self.baseEtag = baseEtag
            self.baseRevision = baseRevision
            self.draftStore = draftStore
        }
    }

    public init(options: Options) {
        self.bridge = options.bridge
        self.api = options.api
        self.callbacks = options.callbacks
        self.accountId = options.accountId
        self.documentId = options.documentId
        self.keyVersion = options.keyVersion
        self.vaultKey = options.vaultKey
        self.baseEtag = options.baseEtag
        self.baseRevision = options.baseRevision
        self.draftStore = options.draftStore
    }

    // MARK: - Lifecycle

    public func start() {
        stopped = false
        schedulePoll()
    }

    public func stop() {
        stopped = true
        debounceTask?.cancel()
        maxWaitTask?.cancel()
        pollTask?.cancel()
        retryTask?.cancel()
    }

    /// Saves immediately when the editor is at a safe point (⌘S, spec §4.4).
    public func saveNow() async {
        guard callbacks.isSafePoint() else { return }
        await flush()
    }

    // MARK: - Change notification

    /// A committed local change (called from the editor's Coordinator).
    public func noteCommittedChange() {
        editGeneration += 1
        committedGeneration = editGeneration
        dirty = true
        lastInteraction = Date()
        callbacks.onState(.localOnly)
        scheduleSave()
        Task { await self.persistDraft() }
    }

    /// An uncommitted change during IME composition — never synced (spec §9.6).
    public func noteComposingChange() {
        editGeneration += 1
    }

    public var hasPendingLocalChanges: Bool { dirty }
    public var currentGeneration: Int { editGeneration }

    // MARK: - Saving

    private func scheduleSave() {
        debounceTask?.cancel()
        let delay = UInt64(SyncTimings.debounceMs) * 1_000_000
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
        if maxWaitTask == nil {
            let maxDelay = UInt64(SyncTimings.maxWaitMs) * 1_000_000
            maxWaitTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: maxDelay)
                guard !Task.isCancelled else { return }
                await self?.clearMaxWait()
                await self?.flush()
            }
        }
    }

    private func clearMaxWait() {
        maxWaitTask = nil
    }

    private func flush() async {
        if stopped || syncing { return }
        if !dirty { return }
        if !callbacks.isSafePoint() { return }
        if let inFlight, inFlight.generation == committedGeneration { return }
        syncing = true
        defer { syncing = false }
        await pushOnce()
    }

    private func pushOnce() async {
        let generation = committedGeneration
        let document = callbacks.getDocument().pruningUnreferencedMedia()
        let issues = DocumentCodec.validate(document)
        guard issues.isEmpty else {
            // Never upload a model another client would refuse to open (§8).
            callbacks.onState(.localOnly)
            return
        }
        let mutationId: String
        if let inFlight, inFlight.generation == generation {
            mutationId = inFlight.mutationId
        } else {
            mutationId = UUID().uuidString.lowercased()
        }
        let encryptedRevision = baseRevision + 1

        if baseEtag == nil {
            await refreshRemote(force: true)
            if baseEtag == nil {
                callbacks.onState(.offline)
                scheduleRetry()
                return
            }
        }

        callbacks.onState(.saving)
        do {
            let payload = try await buildPayload(
                document: document,
                mutationId: mutationId,
                encryptedRevision: encryptedRevision
            )
            inFlight = (generation, mutationId)
            guard let etag = baseEtag else {
                callbacks.onState(.offline)
                scheduleRetry()
                return
            }
            let result = try await api.putDocument(payload, etag: etag)
            baseEtag = result.etag
            baseRevision = result.revision
            persistedGeneration = generation
            backoffMs = 1_000
            if committedGeneration != generation {
                callbacks.onState(.saving)
                scheduleSave()
            } else {
                dirty = false
                await clearSyncedDraft()
                callbacks.onState(.saved)
                let savedGeneration = generation
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(SyncTimings.savedIndicatorMs) * 1_000_000)
                    await self?.settleIndicator(savedGeneration)
                }
            }
        } catch let error as TxtError {
            await handleSaveError(error, generation: generation)
        } catch {
            callbacks.onState(.offline)
            scheduleRetry()
        }
    }

    private func settleIndicator(_ generation: Int) {
        if !dirty && persistedGeneration == generation {
            callbacks.onState(.idle)
        }
    }

    private func buildPayload(
        document: DocumentModel,
        mutationId: String,
        encryptedRevision: Int
    ) async throws -> ApiClient.DocumentPayload {
        let json = try DocumentCodec.serialize(document)
        guard json.utf8.count <= DocumentLimits.maxDocumentJsonBytes else {
            throw TxtError.validation(["document JSON exceeds 1MiB"])
        }
        let plaintext = [UInt8](json.utf8)
        let encrypted = try await bridge.encryptDocument(
            document: plaintext,
            mutationId: mutationId,
            encryptedRevision: encryptedRevision,
            formatVersion: DocumentLimits.formatVersion,
            keyVersion: keyVersion
        )
        return ApiClient.DocumentPayload(
            mutationId: mutationId,
            formatVersion: DocumentLimits.formatVersion,
            keyVersion: keyVersion,
            encryptedRevision: encryptedRevision,
            nonce: encrypted.nonce,
            ciphertext: encrypted.ciphertext,
            referencedMediaIds: document.referencedMediaIds
        )
    }

    private func handleSaveError(_ error: TxtError, generation: Int) async {
        switch error {
        case .api(let status, _, _):
            switch status {
            case 401:
                callbacks.onState(.authExpired)
                return
            case 412:
                await resolvePrecondition(generation: generation)
                return
            case 409:
                inFlight = nil
                backoffMs = 1_000
                scheduleRetry()
                return
            case 422:
                callbacks.onState(.localOnly)
                return
            case 429:
                backoffMs = max(backoffMs, 5_000)
                scheduleRetry()
                return
            default:
                break
            }
        case .validation:
            callbacks.onState(.localOnly)
            return
        default:
            break
        }
        callbacks.onState(.offline)
        scheduleRetry()
    }

    private func scheduleRetry() {
        if retryTask != nil { return }
        let jitter = Double.random(in: 0.85...1.15)
        let delay = UInt64(min(Double(backoffMs) * jitter, Double(SyncTimings.maxBackoffMs))) * 1_000_000
        backoffMs = min(backoffMs * 2, SyncTimings.maxBackoffMs)
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            await self?.clearRetry()
            await self?.flush()
        }
    }

    private func clearRetry() {
        retryTask = nil
    }

    /// 412 recovery (spec §10.4): compare the normalized models, then either
    /// converge silently or ask the user.
    private func resolvePrecondition(generation: Int) async {
        inFlight = nil
        let envelope: ApiClient.DocumentEnvelope
        do {
            envelope = try await api.document()
        } catch {
            scheduleRetry()
            return
        }
        guard let remote = envelope.data, !envelope.notModified else {
            scheduleRetry()
            return
        }
        let remoteDocument: DocumentModel
        do {
            remoteDocument = try await decrypt(remote)
        } catch {
            callbacks.onState(.decryptFailed)
            return
        }
        let local = callbacks.getDocument()
        if normalizedEqual(local, remoteDocument) {
            baseEtag = envelope.etag
            baseRevision = remote.revision
            persistedGeneration = generation
            dirty = false
            callbacks.onState(.saved)
            return
        }
        callbacks.onState(.conflict)
        let decision = await callbacks.onConflict(ConflictDetails(
            local: local,
            remote: remoteDocument,
            remoteEtag: envelope.etag ?? "",
            remoteRevision: remote.revision
        ))
        switch decision {
        case .useRemote:
            baseEtag = envelope.etag
            baseRevision = remote.revision
            persistedGeneration = generation
            dirty = false
            callbacks.applyRemote(remoteDocument, true)
            callbacks.onState(.saved)
        case .keepLocal:
            baseEtag = envelope.etag
            baseRevision = remote.revision
            inFlight = nil
            scheduleSave()
        case .pending:
            // The UI will answer later; hold the fetched version so the
            // decision can be applied without another round trip (spec §10.4).
            pendingConflict = ConflictDetails(
                local: local,
                remote: remoteDocument,
                remoteEtag: envelope.etag ?? "",
                remoteRevision: remote.revision
            )
            pendingConflictDocument = remoteDocument
        }
    }

    /// Conflict the UI deferred to the user (spec §10.4).
    private var pendingConflict: ConflictDetails?
    private var pendingConflictDocument: DocumentModel?

    /// Applies a deferred conflict decision chosen in the UI.
    public func resolvePendingConflict(_ decision: ConflictDecision) async {
        guard let resolved = pendingConflict, let remote = pendingConflictDocument else { return }
        pendingConflict = nil
        pendingConflictDocument = nil
        switch decision {
        case .useRemote:
            baseEtag = resolved.remoteEtag
            baseRevision = resolved.remoteRevision
            persistedGeneration = committedGeneration
            dirty = false
            callbacks.applyRemote(remote, true)
            callbacks.onState(.saved)
        case .keepLocal:
            baseEtag = resolved.remoteEtag
            baseRevision = resolved.remoteRevision
            inFlight = nil
            await flush()
        case .pending:
            pendingConflict = resolved
            pendingConflictDocument = remote
        }
    }

    // MARK: - Fetching

    private func schedulePoll() {
        pollTask?.cancel()
        if stopped { return }
        let idleFor = Date().timeIntervalSince(lastInteraction) * 1000
        let interval = idleFor > Double(SyncTimings.idleAfterMs)
            ? SyncTimings.idlePollMs
            : SyncTimings.activePollMs
        pollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000)
            guard !Task.isCancelled else { return }
            await self?.refreshRemote(force: false)
            await self?.schedulePoll()
        }
    }

    /// Called on focus/foreground (spec §10.2).
    public func noteInteraction() {
        lastInteraction = Date()
    }

    public func refreshNow() async {
        lastInteraction = Date()
        await refreshRemote(force: false)
        schedulePoll()
    }

    private func refreshRemote(force: Bool) async {
        if stopped { return }
        if !force && dirty && !callbacks.isSafePoint() { return }
        do {
            let result = try await api.document(etag: baseEtag)
            guard !result.notModified, let data = result.data else { return }
            let remoteDocument = try await decrypt(data)
            if dirty {
                if normalizedEqual(callbacks.getDocument(), remoteDocument) {
                    persistedGeneration = committedGeneration
                    dirty = false
                    baseEtag = result.etag
                    baseRevision = data.revision
                    callbacks.onState(.saved)
                }
                // The remote moved while local edits were pending. Rebasing
                // onto it here would let this (possibly stale) local copy
                // silently overwrite newer remote content — a lost update.
                // Keep the old base instead: the next save fails closed with
                // 412 and goes through the explicit conflict dialog (spec §10.4).
                return
            }
            baseEtag = result.etag
            baseRevision = data.revision
            callbacks.applyRemote(remoteDocument, false)
        } catch let error as TxtError {
            if case .api(401, _, _) = error {
                callbacks.onState(.authExpired)
            }
            // Network hiccups keep the polling cadence (spec §10.6).
        } catch {
            // Same: no tight retry loop.
        }
    }

    private func decrypt(_ response: ApiClient.DocumentResponse) async throws -> DocumentModel {
        let plaintext = try await bridge.decryptDocument(
            nonce: response.nonce,
            ciphertext: response.ciphertext,
            mutationId: response.mutationId,
            encryptedRevision: response.encryptedRevision,
            formatVersion: response.formatVersion,
            keyVersion: response.keyVersion
        )
        let parsed = try DocumentCodec.parse(plaintext)
        // A stored document whose only defect is unreferenced media entries is
        // opened after dropping them, then re-saved so every client recovers
        // (spec §8). Any other damage still fails closed.
        if let repair = DocumentRepairer.repair(parsed) {
            if !repair.dropped.isEmpty {
                Task { await self.resaveAfterRepair() }
            }
            return repair.document
        }
        return parsed
    }

    private func resaveAfterRepair() async {
        if !dirty {
            dirty = true
            committedGeneration = editGeneration
        }
        await flush()
    }

    // MARK: - Local draft

    private func persistDraft() async {
        guard let draftStore else { return }
        do {
            let document = callbacks.getDocument()
            let json = try DocumentCodec.serialize(document)
            try await draftStore.save(
                vaultKey: vaultKey,
                accountId: accountId,
                documentId: documentId,
                keyVersion: keyVersion,
                plaintext: json,
                baseEtag: baseEtag,
                mutationId: inFlight?.mutationId,
                provisional: !callbacks.isSafePoint()
            )
        } catch {
            // Best effort only (spec §10.6).
        }
    }

    private func clearSyncedDraft() async {
        guard let draftStore else { return }
        try? await draftStore.clear(accountId: accountId, documentId: documentId)
    }
}

/// Structural comparison of the normalized model (spec §10.4).
public func normalizedEqual(_ a: DocumentModel, _ b: DocumentModel) -> Bool {
    guard a.blocks.count == b.blocks.count else { return false }
    for (left, right) in zip(a.blocks, b.blocks) {
        switch (left, right) {
        case (.text(let l), .text(let r)):
            if l.text != r.text { return false }
        case (.media(let l), .media(let r)):
            if l.mediaId != r.mediaId { return false }
        default:
            return false
        }
    }
    return a.media.keys.sorted() == b.media.keys.sorted()
}
