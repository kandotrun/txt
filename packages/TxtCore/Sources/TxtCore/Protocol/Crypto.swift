import CryptoKit
import Foundation

/// The shared crypto contract (spec §6.2, §6.3, §7.1, §11.2).
///
/// AES-256-GCM, HKDF-SHA256, SHA-256. 12-byte nonces, 16-byte tags, binary
/// JSON fields as padding-free base64url, and `ciphertext || tag` in a single
/// field with the nonce separate. Every function here must produce the same
/// bytes as `packages/protocol/src/crypto.ts`; the shared known-answer vectors
/// in `Tests/TxtCoreTests` assert exactly that.
public enum TxtCrypto {
    public static let keyBytes = 32
    public static let nonceBytes = 12
    public static let tagBytes = 16
    public static let chunkPlainBytes = 1_048_576
    public static let chunkCipherBytes = chunkPlainBytes + tagBytes

    /// Fixed public PRF input, identical across deploys (spec §6.2).
    public static let prfInputV1 = SHA256.hash(data: Data("txt.2-38.com/prf-input/v1".utf8))

    public static func sha256(_ bytes: [UInt8]) -> [UInt8] {
        [UInt8](SHA256.hash(data: Data(bytes)))
    }

    public static func randomBytes(_ count: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: count)
        for index in out.indices { out[index] = UInt8.random(in: 0...255) }
        return out
    }

    // MARK: - HKDF

    private static func hkdf(
        inputKeyMaterial: [UInt8],
        salt: [UInt8],
        info: [UInt8],
        length: Int
    ) -> [UInt8] {
        let ikm = SymmetricKey(data: Data(inputKeyMaterial))
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: Data(salt),
            info: Data(info),
            outputByteCount: length
        )
        return derived.withUnsafeBytes { Array($0) }
    }

    // MARK: - AES-256-GCM (ciphertext || tag)

    public static func aesGcmEncrypt(
        key: [UInt8],
        nonce: [UInt8],
        plaintext: [UInt8],
        aad: [UInt8]
    ) throws -> [UInt8] {
        let symmetricKey = SymmetricKey(data: Data(key))
        let box = try AES.GCM.seal(
            Data(plaintext),
            using: symmetricKey,
            nonce: try AES.GCM.Nonce(data: Data(nonce)),
            authenticating: Data(aad)
        )
        return [UInt8](box.ciphertext) + [UInt8](box.tag)
    }

    public static func aesGcmDecrypt(
        key: [UInt8],
        nonce: [UInt8],
        ciphertextAndTag: [UInt8],
        aad: [UInt8]
    ) throws -> [UInt8] {
        guard ciphertextAndTag.count >= tagBytes else {
            throw TxtError.crypto("ciphertext shorter than one tag")
        }
        let ciphertext = ciphertextAndTag.prefix(ciphertextAndTag.count - tagBytes)
        let tag = ciphertextAndTag.suffix(tagBytes)
        let box = try AES.GCM.SealedBox(
            nonce: try AES.GCM.Nonce(data: Data(nonce)),
            ciphertext: Data(ciphertext),
            tag: Data(tag)
        )
        let plaintext = try AES.GCM.open(
            box,
            using: SymmetricKey(data: Data(key)),
            authenticating: Data(aad)
        )
        return [UInt8](plaintext)
    }

    // MARK: - §6.2 passkey PRF -> KEK -> wrapped VaultKey

    /// KEK = HKDF-SHA256(prfOutput, wrapSalt32, Encode("txt/v1/passkey-wrap", accountId, credentialId), 32)
    public static func deriveKek(
        prfOutput: [UInt8],
        wrapSalt: [UInt8],
        accountId: String,
        credentialId: [UInt8]
    ) throws -> [UInt8] {
        guard wrapSalt.count == keyBytes else {
            throw TxtError.crypto("wrapSalt must be 32 bytes")
        }
        return hkdf(
            inputKeyMaterial: prfOutput,
            salt: wrapSalt,
            info: Encode.fields([
                .string("txt/v1/passkey-wrap"),
                .bytes(try uuidToBytes(accountId)),
                .bytes(credentialId),
            ]),
            length: keyBytes
        )
    }

    /// wrapAAD = Encode("txt/v1/vault-key", formatVersion, keyVersion, accountId, credentialId)
    public static func vaultKeyAad(
        formatVersion: UInt64,
        keyVersion: UInt64,
        accountId: String,
        credentialId: [UInt8]
    ) throws -> [UInt8] {
        Encode.fields([
            .string("txt/v1/vault-key"),
            .uint(formatVersion),
            .uint(keyVersion),
            .bytes(try uuidToBytes(accountId)),
            .bytes(credentialId),
        ])
    }

    public struct WrappedKey: Sendable, Equatable {
        public var wrapSalt32: String
        public var nonce: String
        public var wrappedKey: String
    }

    public static func wrapVaultKey(
        vaultKey: [UInt8],
        kek: [UInt8],
        aad: [UInt8]
    ) throws -> (nonce: [UInt8], wrappedKey: [UInt8]) {
        guard vaultKey.count == keyBytes else {
            throw TxtError.crypto("VaultKey must be 32 bytes")
        }
        let nonce = randomBytes(nonceBytes)
        let wrapped = try aesGcmEncrypt(key: kek, nonce: nonce, plaintext: vaultKey, aad: aad)
        return (nonce, wrapped)
    }

    public static func unwrapVaultKey(
        kek: [UInt8],
        nonce: [UInt8],
        wrappedKey: [UInt8],
        aad: [UInt8]
    ) throws -> [UInt8] {
        let key = try aesGcmDecrypt(key: kek, nonce: nonce, ciphertextAndTag: wrappedKey, aad: aad)
        guard key.count == keyBytes else {
            throw TxtError.crypto("unwrapped VaultKey not 32 bytes")
        }
        return key
    }

    // MARK: - §7.1 recovery key

    /// RecoveryAuth = HKDF-SHA256(seed, accountId16, "txt/v1/recovery-auth", 32)
    public static func deriveRecoveryAuth(seed: [UInt8], accountId: String) throws -> [UInt8] {
        hkdf(
            inputKeyMaterial: seed,
            salt: try uuidToBytes(accountId),
            info: Array("txt/v1/recovery-auth".utf8),
            length: keyBytes
        )
    }

    /// RecoveryKEK = HKDF-SHA256(seed, accountId16, "txt/v1/recovery-wrap", 32)
    public static func deriveRecoveryKek(seed: [UInt8], accountId: String) throws -> [UInt8] {
        hkdf(
            inputKeyMaterial: seed,
            salt: try uuidToBytes(accountId),
            info: Array("txt/v1/recovery-wrap".utf8),
            length: keyBytes
        )
    }

    /// recoveryAAD = Encode("txt/v1/recovery-vault", accountId, recoveryVersion, keyVersion)
    public static func recoveryAad(
        accountId: String,
        recoveryVersion: UInt64,
        keyVersion: UInt64
    ) throws -> [UInt8] {
        Encode.fields([
            .string("txt/v1/recovery-vault"),
            .bytes(try uuidToBytes(accountId)),
            .uint(recoveryVersion),
            .uint(keyVersion),
        ])
    }

    /// `TXT1.<accountId b64url>.<seed b64url>.<checksum>` (spec §7.1).
    public static func formatRecoveryKey(accountId: String, seed: [UInt8]) throws -> String {
        let body = "TXT1.\(Base64Url.encode(try uuidToBytes(accountId))).\(Base64Url.encode(seed))"
        let checksum = Array(sha256(Array(body.utf8)).prefix(4))
        return "\(body).\(Base64Url.encode(checksum))"
    }

    public struct ParsedRecoveryKey: Sendable, Equatable {
        public var accountId: String
        public var seed: [UInt8]
    }

    public static func parseRecoveryKey(_ text: String) throws -> ParsedRecoveryKey {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".")
        guard parts.count == 4 else {
            throw TxtError.crypto("recovery key: expected 4 segments")
        }
        guard parts[0] == "TXT1" else {
            throw TxtError.crypto("recovery key: bad prefix")
        }
        let accountB64 = String(parts[1])
        let seedB64 = String(parts[2])
        let checksumB64 = String(parts[3])
        let body = "TXT1.\(accountB64).\(seedB64)"
        let expected = Array(sha256(Array(body.utf8)).prefix(4))
        let actual = try Base64Url.decode(checksumB64)
        guard actual.count == 4 else {
            throw TxtError.crypto("recovery key: bad checksum length")
        }
        guard actual == expected else {
            throw TxtError.crypto("recovery key: checksum mismatch")
        }
        let accountBytes = try Base64Url.decode(accountB64)
        guard accountBytes.count == 16 else {
            throw TxtError.crypto("recovery key: bad account id")
        }
        let seed = try Base64Url.decode(seedB64)
        guard seed.count == keyBytes else {
            throw TxtError.crypto("recovery key: bad seed length")
        }
        return ParsedRecoveryKey(accountId: try bytesToUuid(accountBytes), seed: seed)
    }

    // MARK: - §6.3 document key + AAD

    /// snapshotKey = HKDF-SHA256(VaultKey, mutationId16, Encode("txt/v1/document-key", accountId, documentId, keyVersion), 32)
    public static func deriveDocumentKey(
        vaultKey: [UInt8],
        mutationId: String,
        accountId: String,
        documentId: String,
        keyVersion: UInt64
    ) throws -> [UInt8] {
        hkdf(
            inputKeyMaterial: vaultKey,
            salt: try uuidToBytes(mutationId),
            info: Encode.fields([
                .string("txt/v1/document-key"),
                .bytes(try uuidToBytes(accountId)),
                .bytes(try uuidToBytes(documentId)),
                .uint(keyVersion),
            ]),
            length: keyBytes
        )
    }

    /// documentAAD = Encode("txt/v1/document", formatVersion, keyVersion, accountId, documentId, mutationId, encryptedRevision)
    public static func documentAad(
        formatVersion: UInt64,
        keyVersion: UInt64,
        accountId: String,
        documentId: String,
        mutationId: String,
        encryptedRevision: UInt64
    ) throws -> [UInt8] {
        Encode.fields([
            .string("txt/v1/document"),
            .uint(formatVersion),
            .uint(keyVersion),
            .bytes(try uuidToBytes(accountId)),
            .bytes(try uuidToBytes(documentId)),
            .bytes(try uuidToBytes(mutationId)),
            .uint(encryptedRevision),
        ])
    }

    // MARK: - Local-only records (draft / local record)

    public static func deriveDraftKey(
        vaultKey: [UInt8],
        draftId: String,
        accountId: String,
        documentId: String,
        keyVersion: UInt64
    ) throws -> [UInt8] {
        hkdf(
            inputKeyMaterial: vaultKey,
            salt: try uuidToBytes(draftId),
            info: Encode.fields([
                .string("txt/v1/draft-key"),
                .bytes(try uuidToBytes(accountId)),
                .bytes(try uuidToBytes(documentId)),
                .uint(keyVersion),
            ]),
            length: keyBytes
        )
    }

    public static func draftAad(
        accountId: String,
        documentId: String,
        sceneId: String,
        draftVersion: UInt64
    ) throws -> [UInt8] {
        Encode.fields([
            .string("txt/v1/draft"),
            .bytes(try uuidToBytes(accountId)),
            .bytes(try uuidToBytes(documentId)),
            .string(sceneId),
            .uint(draftVersion),
        ])
    }

    public static func deriveLocalRecordKey(
        vaultKey: [UInt8],
        recordId: String,
        accountId: String,
        keyVersion: UInt64
    ) throws -> [UInt8] {
        hkdf(
            inputKeyMaterial: vaultKey,
            salt: try uuidToBytes(recordId),
            info: Encode.fields([
                .string("txt/v1/local-record-key"),
                .bytes(try uuidToBytes(accountId)),
                .uint(keyVersion),
            ]),
            length: keyBytes
        )
    }

    public static func localRecordAad(
        accountId: String,
        recordId: String,
        recordVersion: UInt64
    ) throws -> [UInt8] {
        Encode.fields([
            .string("txt/v1/local-record"),
            .bytes(try uuidToBytes(accountId)),
            .string(recordId),
            .uint(recordVersion),
        ])
    }

    // MARK: - §11.2 media chunk container

    public static func mediaChunkNonce(noncePrefix: [UInt8], index: UInt32) throws -> [UInt8] {
        guard noncePrefix.count == 8 else {
            throw TxtError.crypto("noncePrefix must be 8 bytes")
        }
        return noncePrefix + Encode.bigEndianUInt32(index)
    }

    public static func mediaChunkAad(
        cryptoFormat: UInt64,
        accountId: String,
        documentId: String,
        mediaId: String,
        index: UInt64,
        totalPlainBytes: UInt64,
        chunkPlainBytes: UInt64
    ) throws -> [UInt8] {
        Encode.fields([
            .string("txt/v1/media-chunk"),
            .uint(cryptoFormat),
            .bytes(try uuidToBytes(accountId)),
            .bytes(try uuidToBytes(documentId)),
            .bytes(try uuidToBytes(mediaId)),
            .uint(index),
            .uint(totalPlainBytes),
            .uint(chunkPlainBytes),
        ])
    }
}
