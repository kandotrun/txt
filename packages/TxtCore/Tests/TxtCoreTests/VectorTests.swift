import Foundation
import Testing

@testable import TxtCore

/// Known-answer vectors for the shared crypto contract (spec §6.3, §17.3).
///
/// The fixed inputs match `tests/protocol/vectors.test.ts`; the expected values
/// are the ones the TypeScript implementation produced. Both implementations
/// must agree byte for byte — that is the whole point of the shared contract.
struct VectorTests {
    static let accountId = "8cf3a2b1-0000-4000-8000-000000000001"
    static let documentId = "8cf3a2b1-0000-4000-8000-000000000002"
    static let credentialId: [UInt8] = [
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
    ]
    static let mutationId = "8cf3a2b1-0000-4000-8000-000000000003"
    static let draftId = "8cf3a2b1-0000-4000-8000-000000000004"
    static let mediaId = "8cf3a2b1-0000-4000-8000-000000000005"
    static let seed = [UInt8](repeating: 0x42, count: 32)
    static let vaultKey = [UInt8](repeating: 0x17, count: 32)
    static let wrapSalt = [UInt8](repeating: 0x99, count: 32)

    static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Encode

    @Test func encodePrefixesEachFieldWithUInt32Length() {
        #expect(Self.hex(Encode.fields([.string("ab")])) == "000000026162")
        #expect(Self.hex(Encode.fields([.string(""), .string("a")])) == "000000000000000161")
        #expect(Self.hex(Encode.fields([.uint(1)])) == "000000080000000000000001")
        #expect(Self.hex(Encode.fields([.uint(0)])) == "000000080000000000000000")
    }

    @Test func encodeHandlesSafeIntegerRange() {
        #expect(Self.hex(Encode.fields([.uint(9_007_199_254_740_991)])) == "00000008001fffffffffffff")
    }

    @Test func encodeTreatsUuidsAsSixteenBytes() throws {
        let bytes = try uuidToBytes(Self.accountId)
        #expect(bytes.count == 16)
        #expect(Self.hex(bytes) == "8cf3a2b1000040008000000000000001")
        #expect(Self.hex(Encode.fields([.bytes(bytes)])) == "000000108cf3a2b1000040008000000000000001")
    }

    // MARK: - base64url

    @Test func base64UrlRoundTripsWithoutPadding() throws {
        for length in [0, 1, 2, 3, 4, 5, 8, 12, 16, 31, 32, 33, 100] {
            let bytes = (0..<length).map { UInt8(($0 * 37) % 256) }
            let text = Base64Url.encode(bytes)
            #expect(!text.contains("="))
            #expect(!text.contains("+"))
            #expect(!text.contains("/"))
            #expect(try Base64Url.decode(text) == bytes)
        }
    }

    @Test func base64UrlRejectsInvalidCharacters() {
        #expect(throws: TxtError.self) { _ = try Base64Url.decode("a+b") }
        #expect(throws: TxtError.self) { _ = try Base64Url.decode("a=") }
    }

    // MARK: - PRF input

    @Test func prfInputIsTheFixedHash() {
        let expected = TxtCrypto.sha256(Array("txt.2-38.com/prf-input/v1".utf8))
        let digest = [UInt8](TxtCrypto.prfInputV1)
        #expect(Self.hex(digest) == Self.hex(expected))
        #expect(digest.count == 32)
    }

    // MARK: - AES-256-GCM

    @Test func aesGcmUsesCiphertextThenTag() throws {
        let key = [UInt8](repeating: 0x01, count: 32)
        let nonce = [UInt8](repeating: 0x02, count: 12)
        let aad = Array("aad".utf8)
        let plaintext = Array("hello".utf8)
        let ciphertext = try TxtCrypto.aesGcmEncrypt(key: key, nonce: nonce, plaintext: plaintext, aad: aad)
        #expect(ciphertext.count == plaintext.count + 16)
        let roundTrip = try TxtCrypto.aesGcmDecrypt(
            key: key, nonce: nonce, ciphertextAndTag: ciphertext, aad: aad
        )
        #expect(Self.hex(roundTrip) == Self.hex(plaintext))
    }

    @Test func aesGcmRejectsModifiedTagOrAad() throws {
        let key = [UInt8](repeating: 0x01, count: 32)
        let nonce = [UInt8](repeating: 0x02, count: 12)
        let ciphertext = try TxtCrypto.aesGcmEncrypt(
            key: key, nonce: nonce, plaintext: Array("hello".utf8), aad: Array("aad".utf8)
        )
        var tampered = ciphertext
        tampered[0] ^= 0xff
        #expect(throws: (any Error).self) {
            _ = try TxtCrypto.aesGcmDecrypt(key: key, nonce: nonce, ciphertextAndTag: tampered, aad: Array("aad".utf8))
        }
        #expect(throws: (any Error).self) {
            _ = try TxtCrypto.aesGcmDecrypt(key: key, nonce: nonce, ciphertextAndTag: ciphertext, aad: Array("aad2".utf8))
        }
    }

    // MARK: - Known-answer vectors (cross-implementation)

    @Test func kekMatchesTypeScriptReference() throws {
        let prfOutput = [UInt8](repeating: 0x5a, count: 32)
        let kek = try TxtCrypto.deriveKek(
            prfOutput: prfOutput,
            wrapSalt: Self.wrapSalt,
            accountId: Self.accountId,
            credentialId: Self.credentialId
        )
        #expect(
            Self.hex(kek) == "697492aa7f71c49ec181fc325a51cea686ec4e4d55f027303feffab16b09cd0c",
            "KEK must match packages/protocol/src/crypto.ts"
        )
        #expect(kek.count == 32)
    }

    @Test func wrappedVaultKeyRoundTrips() throws {
        let prfOutput = [UInt8](repeating: 0x5a, count: 32)
        let kek = try TxtCrypto.deriveKek(
            prfOutput: prfOutput,
            wrapSalt: Self.wrapSalt,
            accountId: Self.accountId,
            credentialId: Self.credentialId
        )
        let aad = try TxtCrypto.vaultKeyAad(
            formatVersion: 1, keyVersion: 1, accountId: Self.accountId, credentialId: Self.credentialId
        )
        let (nonce, wrapped) = try TxtCrypto.wrapVaultKey(vaultKey: Self.vaultKey, kek: kek, aad: aad)
        #expect(nonce.count == 12)
        #expect(wrapped.count == 48)
        let unwrapped = try TxtCrypto.unwrapVaultKey(kek: kek, nonce: nonce, wrappedKey: wrapped, aad: aad)
        #expect(Self.hex(unwrapped) == Self.hex(Self.vaultKey))
    }

    @Test func documentKeyAndAadMatchReference() throws {
        let key = try TxtCrypto.deriveDocumentKey(
            vaultKey: Self.vaultKey,
            mutationId: Self.mutationId,
            accountId: Self.accountId,
            documentId: Self.documentId,
            keyVersion: 1
        )
        #expect(
            Self.hex(key) == "d4e2dc6ab63ded4bcafd073d39a8fcb8667ad031397a822903acb917b02a67b6",
            "document key must match the TypeScript reference"
        )
        let aad = try TxtCrypto.documentAad(
            formatVersion: 1,
            keyVersion: 1,
            accountId: Self.accountId,
            documentId: Self.documentId,
            mutationId: Self.mutationId,
            encryptedRevision: 18
        )
        #expect(
            Self.hex(aad) == "0000000f7478742f76312f646f63756d656e74000000080000000000000001000000080000000000000001000000108cf3a2b1000040008000000000000001000000108cf3a2b1000040008000000000000002000000108cf3a2b1000040008000000000000003000000080000000000000012",
            "document AAD must match the TypeScript reference"
        )
    }

    @Test func draftAadMatchesReference() throws {
        let aad = try TxtCrypto.draftAad(
            accountId: Self.accountId, documentId: Self.documentId, sceneId: "tab-1", draftVersion: 1
        )
        #expect(
            Self.hex(aad) == "0000000c7478742f76312f6472616674000000108cf3a2b1000040008000000000000001000000108cf3a2b1000040008000000000000002000000057461622d31000000080000000000000001"
        )
    }

    @Test func draftKeyDiffersFromDocumentKey() throws {
        let draftKey = try TxtCrypto.deriveDraftKey(
            vaultKey: Self.vaultKey,
            draftId: Self.draftId,
            accountId: Self.accountId,
            documentId: Self.documentId,
            keyVersion: 1
        )
        let documentKey = try TxtCrypto.deriveDocumentKey(
            vaultKey: Self.vaultKey,
            mutationId: Self.draftId,
            accountId: Self.accountId,
            documentId: Self.documentId,
            keyVersion: 1
        )
        #expect(draftKey != documentKey, "purpose separation must change the derived key")
    }

    @Test func recoveryKeyMatchesReferenceAndRoundTrips() throws {
        let auth = try TxtCrypto.deriveRecoveryAuth(seed: Self.seed, accountId: Self.accountId)
        #expect(Self.hex(auth) == "9eba7b9d1fe0c5078b6e65ca74b2c7259efe40eca91b12727b5fc78948422ba7")
        let kek = try TxtCrypto.deriveRecoveryKek(seed: Self.seed, accountId: Self.accountId)
        #expect(Self.hex(kek) == "04ed913c45fd73efbaa768a3a029cd30d0b32664d6b21d1898da511dcbb97920")

        let text = try TxtCrypto.formatRecoveryKey(accountId: Self.accountId, seed: Self.seed)
        #expect(text.hasPrefix("TXT1."))
        #expect(text.split(separator: ".").count == 4)
        let parsed = try TxtCrypto.parseRecoveryKey(text)
        #expect(parsed.accountId == Self.accountId)
        #expect(Self.hex(parsed.seed) == Self.hex(Self.seed))
    }

    @Test func recoveryKeyDetectsChecksumErrors() throws {
        let text = try TxtCrypto.formatRecoveryKey(accountId: Self.accountId, seed: Self.seed)
        let parts = text.split(separator: ".")
        let broken = "\(parts[0]).\(parts[1]).\(parts[2]).\(Base64Url.encode([UInt8](repeating: 7, count: 4)))"
        #expect(throws: TxtError.self) { _ = try TxtCrypto.parseRecoveryKey(broken) }
        #expect(throws: TxtError.self) { _ = try TxtCrypto.parseRecoveryKey("nope") }
    }

    @Test func mediaChunkNonceAndAadMatchReference() throws {
        let prefix = [UInt8](repeating: 0xaa, count: 8)
        #expect(Self.hex(try TxtCrypto.mediaChunkNonce(noncePrefix: prefix, index: 0)) == "aaaaaaaaaaaaaaaa00000000")
        #expect(Self.hex(try TxtCrypto.mediaChunkNonce(noncePrefix: prefix, index: 3)) == "aaaaaaaaaaaaaaaa00000003")
        let aad = try TxtCrypto.mediaChunkAad(
            cryptoFormat: 1,
            accountId: Self.accountId,
            documentId: Self.documentId,
            mediaId: Self.mediaId,
            index: 0,
            totalPlainBytes: 100,
            chunkPlainBytes: 100
        )
        #expect(
            Self.hex(aad) == "000000127478742f76312f6d656469612d6368756e6b000000080000000000000001000000108cf3a2b1000040008000000000000001000000108cf3a2b1000040008000000000000002000000108cf3a2b1000040008000000000000005000000080000000000000000000000080000000000000064000000080000000000000064"
        )
    }

    @Test func cipherLengthMathMatchesChunkLayout() {
        #expect(TxtCrypto.chunkPlainBytes == 1_048_576)
        #expect(TxtCrypto.chunkCipherBytes == 1_048_592)
        let plain = 536_870_912
        let chunks = Int(ceil(Double(plain) / Double(TxtCrypto.chunkPlainBytes)))
        #expect(chunks == 512)
        #expect(plain + chunks * 16 == 536_879_104)
    }
}
