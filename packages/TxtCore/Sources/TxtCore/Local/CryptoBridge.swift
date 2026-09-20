import Foundation

/// Crypto boundary (spec §6.3, §9.8).
///
/// Heavy crypto runs off the UI thread: AES-GCM over a 1MiB document and every
/// media chunk must never block typing. On Apple platforms this is a detached
/// actor rather than a Web Worker, but the contract is identical — the VaultKey
/// stays inside the bridge and callers only ever see ciphertext or plaintext.
public actor CryptoBridge {
    private var vaultKey: [UInt8]?
    private var accountId: String?
    private var documentId: String?
    private var keyVersion: Int?

    public init() {}

    /// Unlocks the bridge for one account/document (spec §6.4).
    public func unlock(vaultKey: [UInt8], accountId: String, documentId: String, keyVersion: Int) {
        self.vaultKey = vaultKey
        self.accountId = accountId
        self.documentId = documentId
        self.keyVersion = keyVersion
    }

    /// Drops the in-memory key; nothing else can decrypt afterwards.
    public func lock() {
        vaultKey = nil
        accountId = nil
        documentId = nil
        keyVersion = nil
    }

    public var isUnlocked: Bool { vaultKey != nil }

    private func requireSession() throws -> (vaultKey: [UInt8], accountId: String, documentId: String, keyVersion: Int) {
        guard let vaultKey, let accountId, let documentId, let keyVersion else {
            throw TxtError.locked
        }
        return (vaultKey, accountId, documentId, keyVersion)
    }

    public struct EncryptedDocument: Sendable {
        public var nonce: String
        public var ciphertext: String
    }

    /// Encrypts the document JSON with a per-save key and AAD (spec §6.3).
    public func encryptDocument(
        document plaintext: [UInt8],
        mutationId: String,
        encryptedRevision: Int,
        formatVersion: Int,
        keyVersion: Int
    ) throws -> EncryptedDocument {
        let session = try requireSession()
        let snapshotKey = try TxtCrypto.deriveDocumentKey(
            vaultKey: session.vaultKey,
            mutationId: mutationId,
            accountId: session.accountId,
            documentId: session.documentId,
            keyVersion: UInt64(session.keyVersion)
        )
        let aad = try TxtCrypto.documentAad(
            formatVersion: UInt64(formatVersion),
            keyVersion: UInt64(keyVersion),
            accountId: session.accountId,
            documentId: session.documentId,
            mutationId: mutationId,
            encryptedRevision: UInt64(encryptedRevision)
        )
        let nonce = TxtCrypto.randomBytes(TxtCrypto.nonceBytes)
        let ciphertext = try TxtCrypto.aesGcmEncrypt(
            key: snapshotKey, nonce: nonce, plaintext: plaintext, aad: aad
        )
        return EncryptedDocument(nonce: Base64Url.encode(nonce), ciphertext: Base64Url.encode(ciphertext))
    }

    /// Decrypts a stored document. Returns the raw JSON bytes; the caller
    /// validates and repairs so both clients share one code path.
    public func decryptDocument(
        nonce: String,
        ciphertext: String,
        mutationId: String,
        encryptedRevision: Int,
        formatVersion: Int,
        keyVersion: Int
    ) throws -> [UInt8] {
        let session = try requireSession()
        let snapshotKey = try TxtCrypto.deriveDocumentKey(
            vaultKey: session.vaultKey,
            mutationId: mutationId,
            accountId: session.accountId,
            documentId: session.documentId,
            keyVersion: UInt64(session.keyVersion)
        )
        let aad = try TxtCrypto.documentAad(
            formatVersion: UInt64(formatVersion),
            keyVersion: UInt64(keyVersion),
            accountId: session.accountId,
            documentId: session.documentId,
            mutationId: mutationId,
            encryptedRevision: UInt64(encryptedRevision)
        )
        return try TxtCrypto.aesGcmDecrypt(
            key: snapshotKey,
            nonce: try Base64Url.decode(nonce),
            ciphertextAndTag: try Base64Url.decode(ciphertext),
            aad: aad
        )
    }

    // MARK: - Media chunks (§11.2)

    /// Encrypts one 1MiB chunk with the file key and the shared AAD.
    public func encryptChunk(
        plaintext: [UInt8],
        fileKey: [UInt8],
        noncePrefix: [UInt8],
        cryptoFormat: Int,
        totalPlainBytes: Int,
        index: Int,
        mediaId: String
    ) throws -> [UInt8] {
        let session = try requireSession()
        let aad = try TxtCrypto.mediaChunkAad(
            cryptoFormat: UInt64(cryptoFormat),
            accountId: session.accountId,
            documentId: session.documentId,
            mediaId: mediaId,
            index: UInt64(index),
            totalPlainBytes: UInt64(totalPlainBytes),
            chunkPlainBytes: UInt64(plaintext.count)
        )
        let nonce = try TxtCrypto.mediaChunkNonce(noncePrefix: noncePrefix, index: UInt32(index))
        return try TxtCrypto.aesGcmEncrypt(key: fileKey, nonce: nonce, plaintext: plaintext, aad: aad)
    }

    /// The media ID is part of the chunk AAD, so it travels with the bridge
    /// rather than being passed by every caller (spec §11.2).
    public var currentMediaId: String?

    public func setChunkContext(mediaId: String?) {
        currentMediaId = mediaId
    }

    /// Decrypts one ciphertext chunk for playback or export (spec §11.7).
    public func decryptChunk(
        ciphertext: [UInt8],
        fileKey: [UInt8],
        noncePrefix: [UInt8],
        cryptoFormat: Int,
        totalPlainBytes: Int,
        chunkPlainBytes: Int,
        index: Int,
        mediaId: String
    ) throws -> [UInt8] {
        let session = try requireSession()
        let aad = try TxtCrypto.mediaChunkAad(
            cryptoFormat: UInt64(cryptoFormat),
            accountId: session.accountId,
            documentId: session.documentId,
            mediaId: mediaId,
            index: UInt64(index),
            totalPlainBytes: UInt64(totalPlainBytes),
            chunkPlainBytes: UInt64(chunkPlainBytes)
        )
        let nonce = try TxtCrypto.mediaChunkNonce(noncePrefix: noncePrefix, index: UInt32(index))
        return try TxtCrypto.aesGcmDecrypt(key: fileKey, nonce: nonce, ciphertextAndTag: ciphertext, aad: aad)
    }

    // MARK: - Local records (draft, user handle)

    public func encryptLocalRecord(
        plaintext: [UInt8],
        recordId: String,
        purpose: LocalRecordPurpose
    ) throws -> (nonce: String, ciphertext: String) {
        let session = try requireSession()
        let key: [UInt8]
        let aad: [UInt8]
        switch purpose {
        case .draft:
            key = try TxtCrypto.deriveDraftKey(
                vaultKey: session.vaultKey,
                draftId: recordId,
                accountId: session.accountId,
                documentId: session.documentId,
                keyVersion: UInt64(session.keyVersion)
            )
            aad = try TxtCrypto.draftAad(
                accountId: session.accountId,
                documentId: session.documentId,
                sceneId: recordId,
                draftVersion: 1
            )
        case .localRecord:
            key = try TxtCrypto.deriveLocalRecordKey(
                vaultKey: session.vaultKey,
                recordId: recordId,
                accountId: session.accountId,
                keyVersion: UInt64(session.keyVersion)
            )
            aad = try TxtCrypto.localRecordAad(
                accountId: session.accountId,
                recordId: recordId,
                recordVersion: 1
            )
        }
        let nonce = TxtCrypto.randomBytes(TxtCrypto.nonceBytes)
        let ciphertext = try TxtCrypto.aesGcmEncrypt(key: key, nonce: nonce, plaintext: plaintext, aad: aad)
        return (Base64Url.encode(nonce), Base64Url.encode(ciphertext))
    }

    public func decryptLocalRecord(
        nonce: String,
        ciphertext: String,
        recordId: String,
        purpose: LocalRecordPurpose
    ) throws -> [UInt8] {
        let session = try requireSession()
        let key: [UInt8]
        let aad: [UInt8]
        switch purpose {
        case .draft:
            key = try TxtCrypto.deriveDraftKey(
                vaultKey: session.vaultKey,
                draftId: recordId,
                accountId: session.accountId,
                documentId: session.documentId,
                keyVersion: UInt64(session.keyVersion)
            )
            aad = try TxtCrypto.draftAad(
                accountId: session.accountId,
                documentId: session.documentId,
                sceneId: recordId,
                draftVersion: 1
            )
        case .localRecord:
            key = try TxtCrypto.deriveLocalRecordKey(
                vaultKey: session.vaultKey,
                recordId: recordId,
                accountId: session.accountId,
                keyVersion: UInt64(session.keyVersion)
            )
            aad = try TxtCrypto.localRecordAad(
                accountId: session.accountId,
                recordId: recordId,
                recordVersion: 1
            )
        }
        return try TxtCrypto.aesGcmDecrypt(
            key: key,
            nonce: try Base64Url.decode(nonce),
            ciphertextAndTag: try Base64Url.decode(ciphertext),
            aad: aad
        )
    }
}

public enum LocalRecordPurpose: Sendable {
    case draft
    case localRecord
}
