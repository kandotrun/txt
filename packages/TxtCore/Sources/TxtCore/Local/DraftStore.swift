import CryptoKit
import Foundation

/// Local encrypted draft (spec §10.6).
///
/// IndexedDB plays no part on native. The draft is an AES-GCM sealed
/// `DocumentModel` JSON blob written to Application Support, encrypted with the
/// draft purpose key derived from the VaultKey. Nothing plaintext ever lands on
/// disk, and the draft is dropped the moment the server confirms the save.
public actor DraftStore {
    private let directory: URL

    public init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            self.directory = base.appendingPathComponent("TxtDrafts", isDirectory: true)
        }
    }

    private func fileURL(accountId: String, documentId: String) -> URL {
        directory.appendingPathComponent("\(accountId)-\(documentId).draft")
    }

    private struct DraftEnvelope: Codable {
        var version: Int
        var accountId: String
        var documentId: String
        var keyVersion: Int
        var recordId: String
        var nonce: String
        var ciphertext: String
        var baseEtag: String?
        var mutationId: String?
        var savedAt: Int
        var provisional: Bool
    }

    public func save(
        vaultKey: [UInt8],
        accountId: String,
        documentId: String,
        keyVersion: Int,
        plaintext: String,
        baseEtag: String?,
        mutationId: String?,
        provisional: Bool
    ) async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let recordId = UUID().uuidString.lowercased()
        let draftKey = try TxtCrypto.deriveDraftKey(
            vaultKey: vaultKey,
            draftId: recordId,
            accountId: accountId,
            documentId: documentId,
            keyVersion: UInt64(keyVersion)
        )
        // The AAD binds the record to the account/document/scene, exactly as the
        // Web draft container does; a swapped file cannot be opened.
        let aad = try TxtCrypto.draftAad(
            accountId: accountId,
            documentId: documentId,
            sceneId: recordId,
            draftVersion: 1
        )
        let nonce = TxtCrypto.randomBytes(TxtCrypto.nonceBytes)
        let ciphertext = try TxtCrypto.aesGcmEncrypt(
            key: draftKey,
            nonce: nonce,
            plaintext: [UInt8](plaintext.utf8),
            aad: aad
        )
        let envelope = DraftEnvelope(
            version: 1,
            accountId: accountId,
            documentId: documentId,
            keyVersion: keyVersion,
            recordId: recordId,
            nonce: Base64Url.encode(nonce),
            ciphertext: Base64Url.encode(ciphertext),
            baseEtag: baseEtag,
            mutationId: mutationId,
            savedAt: Int(Date().timeIntervalSince1970 * 1000),
            provisional: provisional
        )
        let data = try JSONEncoder().encode(envelope)
        try data.write(to: fileURL(accountId: accountId, documentId: documentId), options: .atomic)
    }

    public struct LoadedDraft: Sendable {
        public var documentJson: String
        public var baseEtag: String?
        public var mutationId: String?
        public var savedAt: Int
        public var provisional: Bool
    }

    public func load(
        vaultKey: [UInt8],
        accountId: String,
        documentId: String,
        keyVersion: Int
    ) async throws -> LoadedDraft? {
        let url = fileURL(accountId: accountId, documentId: documentId)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let envelope = try? JSONDecoder().decode(DraftEnvelope.self, from: data) else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        let draftKey = try TxtCrypto.deriveDraftKey(
            vaultKey: vaultKey,
            draftId: envelope.recordId,
            accountId: accountId,
            documentId: documentId,
            keyVersion: UInt64(envelope.keyVersion)
        )
        let aad = try TxtCrypto.draftAad(
            accountId: accountId,
            documentId: documentId,
            sceneId: envelope.recordId,
            draftVersion: 1
        )
        do {
            let plaintext = try TxtCrypto.aesGcmDecrypt(
                key: draftKey,
                nonce: try Base64Url.decode(envelope.nonce),
                ciphertextAndTag: try Base64Url.decode(envelope.ciphertext),
                aad: aad
            )
            guard let json = String(bytes: plaintext, encoding: .utf8) else {
                throw TxtError.decoding("draft is not UTF-8")
            }
            return LoadedDraft(
                documentJson: json,
                baseEtag: envelope.baseEtag,
                mutationId: envelope.mutationId,
                savedAt: envelope.savedAt,
                provisional: envelope.provisional
            )
        } catch {
            // A draft that cannot be decrypted is discarded rather than
            // presented as an empty document (spec §6.3).
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    public func clear(accountId: String, documentId: String) throws {
        try? FileManager.default.removeItem(at: fileURL(accountId: accountId, documentId: documentId))
    }
}

/// VaultKey handling (spec §6.4).
///
/// The VaultKey is stored in the Keychain with `WhenUnlockedThisDeviceOnly` so
/// it never leaves the device and never appears in a backup. It is deleted on
/// explicit lock, logout and account deletion. The keychain item is protected by
/// user presence on read where the OS supports it.
public enum VaultKeyStore {
    private static let service = "com.tsuqrea.txt.vaultkey"

    private static func account(for accountId: String) -> String {
        "vaultkey-\(accountId)"
    }

    @discardableResult
    public static func store(vaultKey: [UInt8], accountId: String) -> Bool {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: accountId),
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = Data(vaultKey)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    public static func load(accountId: String) -> [UInt8]? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: accountId),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return [UInt8](data)
    }

    @discardableResult
    public static func delete(accountId: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: accountId),
        ]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }
}

/// Session token handling (spec §5.4). Tokens live in their own Keychain item,
/// separate from the VaultKey, and are removed on logout.
public enum SessionTokenStore {
    private static let service = "com.tsuqrea.txt.session"

    public static func store(token: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session-token",
        ]
        SecItemDelete(query as CFDictionary)
        var write = query
        write[kSecValueData as String] = Data(token.utf8)
        write[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(write as CFDictionary, nil) == errSecSuccess
    }

    public static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session-token",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public static func delete() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session-token",
        ]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }
}
