import Foundation

/// Account flows shared by the macOS and iOS apps (spec §5, §6, §7).
///
/// Both platforms run the same sequence — passkey ceremony, KEK derivation,
/// VaultKey wrap/unwrap, bootstrap, recovery — so the steps live here and the
/// apps only supply the ceremony (which needs platform UI) and the key stores.
/// The DTO shapes are exactly the ones the Worker verifies; nothing here sends
/// PRF output or any key material.
public enum AccountFlow {
    /// What a completed registration needs to hand back to the app.
    public struct RegistrationOutcome: Sendable {
        public var vaultKey: [UInt8]
        public var accountId: String
        public var documentId: String
        public var keyVersion: Int
        public var recoveryKeyText: String
    }

    public struct UnlockedVault: Sendable {
        public var vaultKey: [UInt8]
        public var accountId: String
        public var documentId: String
        public var keyVersion: Int
    }

    /// Registration (spec §5.3): passkey, PRF, VaultKey wrap, recovery key, and
    /// the atomic bootstrap. The session stays `pending` until bootstrap, which
    /// is what makes the whole account creation all-or-nothing.
    public static func register(
        api: ApiClient,
        ceremonies: PasskeyCeremonies,
        rpId: String
    ) async throws -> RegistrationOutcome {
        let options = try await api.registerOptions()
        let created = try await ceremonies.createCredential(options: options.options, rpId: rpId)
        guard let prfOutput = created.prfOutput else {
            throw TxtError.crypto("この環境では、このパスキーで暗号化された内容を開けません。")
        }

        // Verify the attestation before anything is wrapped, so a rejected
        // credential cannot leave a half-written account behind.
        let verify = try await api.registerVerify(created.dto)
        if let token = verify.token { await ceremonies.storeSessionToken(token) }

        let vaultKey = TxtCrypto.randomBytes(TxtCrypto.keyBytes)
        let wrapSalt = TxtCrypto.randomBytes(TxtCrypto.keyBytes)
        let kek = try TxtCrypto.deriveKek(
            prfOutput: prfOutput,
            wrapSalt: wrapSalt,
            accountId: options.accountId,
            credentialId: created.credentialIdRaw
        )
        let wrapAad = try TxtCrypto.vaultKeyAad(
            formatVersion: UInt64(DocumentLimits.formatVersion),
            keyVersion: UInt64(DocumentLimits.keyVersion),
            accountId: options.accountId,
            credentialId: created.credentialIdRaw
        )
        let (wrapNonce, wrappedKey) = try TxtCrypto.wrapVaultKey(
            vaultKey: vaultKey, kek: kek, aad: wrapAad
        )

        let seed = TxtCrypto.randomBytes(TxtCrypto.keyBytes)
        let recoveryAuth = try TxtCrypto.deriveRecoveryAuth(seed: seed, accountId: options.accountId)
        let recoveryKek = try TxtCrypto.deriveRecoveryKek(seed: seed, accountId: options.accountId)
        let recoveryAadBytes = try TxtCrypto.recoveryAad(
            accountId: options.accountId,
            recoveryVersion: 1,
            keyVersion: UInt64(DocumentLimits.keyVersion)
        )
        let (recoveryNonce, recoveryWrapped) = try TxtCrypto.wrapVaultKey(
            vaultKey: vaultKey, kek: recoveryKek, aad: recoveryAadBytes
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
            "credentialId": created.credentialId,
            "envelope": [
                "credentialId": created.credentialId,
                "formatVersion": DocumentLimits.formatVersion,
                "keyVersion": DocumentLimits.keyVersion,
                "wrapSalt32": Base64Url.encode(wrapSalt),
                "nonce": Base64Url.encode(wrapNonce),
                "wrappedKey": Base64Url.encode(wrappedKey),
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

        return RegistrationOutcome(
            vaultKey: vaultKey,
            accountId: options.accountId,
            documentId: documentId,
            keyVersion: DocumentLimits.keyVersion,
            recoveryKeyText: recoveryKeyText
        )
    }

    /// Login and unwrap (spec §6.2). The credential is asserted first so its
    /// PRF output can unwrap the stored envelope; a successful authentication
    /// without a usable PRF leaves the vault locked (spec §7).
    public static func loginAndUnlock(
        api: ApiClient,
        ceremonies: PasskeyCeremonies,
        rpId: String
    ) async throws -> UnlockedVault {
        let options = try await api.loginOptions()
        let assertion = try await ceremonies.assertCredential(options: options.options, rpId: rpId)
        let verify = try await api.loginVerify(assertion.dto)
        if let token = verify.token { await ceremonies.storeSessionToken(token) }
        return try await unwrapWithAssertion(
            api: api,
            accountId: verify.accountId,
            credentialId: verify.credentialId,
            credentialIdRaw: assertion.credentialIdRaw,
            prfOutput: assertion.prfOutput
        )
    }

    /// Unlocks with a fresh assertion for the account that already has a
    /// session (used when the device-kept key is gone).
    public static func unlockExisting(
        api: ApiClient,
        ceremonies: PasskeyCeremonies,
        rpId: String,
        accountId: String
    ) async throws -> UnlockedVault {
        let options = try await api.loginOptions()
        let assertion = try await ceremonies.assertCredential(options: options.options, rpId: rpId)
        return try await unwrapWithAssertion(
            api: api,
            accountId: accountId,
            credentialId: assertion.credentialId,
            credentialIdRaw: assertion.credentialIdRaw,
            prfOutput: assertion.prfOutput
        )
    }

    /// Shared unwrap: envelope lookup, KEK derivation, VaultKey unwrap.
    private static func unwrapWithAssertion(
        api: ApiClient,
        accountId: String,
        credentialId: String,
        credentialIdRaw: [UInt8],
        prfOutput: [UInt8]?
    ) async throws -> UnlockedVault {
        guard let prfOutput else {
            throw TxtError.crypto("この環境では、このパスキーで暗号化された内容を開けません。")
        }
        let keys = try await api.keys(credentialId: credentialId)
        guard let envelope = keys.envelopes.first(where: { $0.credentialId == credentialId })
            ?? keys.envelopes.first
        else {
            throw TxtError.decoding("このパスキー用の鍵が見つかりません。")
        }
        let kek = try TxtCrypto.deriveKek(
            prfOutput: prfOutput,
            wrapSalt: try Base64Url.decode(envelope.wrapSalt32),
            accountId: accountId,
            credentialId: credentialIdRaw
        )
        let aad = try TxtCrypto.vaultKeyAad(
            formatVersion: UInt64(envelope.formatVersion),
            keyVersion: UInt64(envelope.keyVersion),
            accountId: accountId,
            credentialId: credentialIdRaw
        )
        let vaultKey = try TxtCrypto.unwrapVaultKey(
            kek: kek,
            nonce: try Base64Url.decode(envelope.nonce),
            wrappedKey: try Base64Url.decode(envelope.wrappedKey),
            aad: aad
        )
        let document = try await api.document()
        guard let response = document.data else {
            throw TxtError.decoding("文書を取得できません。")
        }
        return UnlockedVault(
            vaultKey: vaultKey,
            accountId: accountId,
            documentId: response.documentId,
            keyVersion: envelope.keyVersion
        )
    }

    /// Recovery (spec §7.2): only the derived RecoveryAuth is sent; the seed
    /// never leaves the device. The VaultKey is unwrapped locally.
    public static func recover(
        api: ApiClient,
        recoveryKeyText: String
    ) async throws -> UnlockedVault {
        let parsed = try TxtCrypto.parseRecoveryKey(recoveryKeyText)
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
        let document = try await api.document()
        guard let response = document.data else {
            throw TxtError.decoding("文書を取得できません。")
        }
        return UnlockedVault(
            vaultKey: vaultKey,
            accountId: parsed.accountId,
            documentId: response.documentId,
            keyVersion: record.keyVersion
        )
    }
}

/// The ceremony surface each platform provides (passkeys need platform UI).
public protocol PasskeyCeremonies: Sendable {
    func createCredential(
        options: ApiClient.RegisterOptions.Options,
        rpId: String
    ) async throws -> PasskeyRegistration
    func assertCredential(
        options: ApiClient.LoginOptions.Options,
        rpId: String
    ) async throws -> PasskeyAssertion
    /// Persists the Bearer token issued for a native session (spec §5.4).
    func storeSessionToken(_ token: String) async
}

/// Registration credential, sanitized to the fields the Worker verifies
/// (spec §6.2). PRF results are deliberately absent.
public struct PasskeyRegistrationDTO: Sendable, Encodable {
    public struct Response: Sendable, Encodable {
        public var clientDataJSON: String
        public var attestationObject: String
    }
    public var id: String
    public var rawId: String
    public var type: String
    public var response: Response
    /// Always empty: PRF results never travel to the server.
    public var clientExtensionResults: [String: String]

    public init(id: String, rawId: String, clientDataJSON: String, attestationObject: String) {
        self.id = id
        self.rawId = rawId
        self.type = "public-key"
        self.response = Response(clientDataJSON: clientDataJSON, attestationObject: attestationObject)
        self.clientExtensionResults = [:]
    }
}

/// Assertion credential, sanitized to the fields the Worker verifies.
public struct PasskeyAssertionDTO: Sendable, Encodable {
    public struct Response: Sendable, Encodable {
        public var clientDataJSON: String
        public var authenticatorData: String
        public var signature: String
        public var userHandle: String?
    }
    public var id: String
    public var rawId: String
    public var type: String
    public var response: Response
    public var clientExtensionResults: [String: String]

    public init(
        id: String,
        rawId: String,
        clientDataJSON: String,
        authenticatorData: String,
        signature: String,
        userHandle: String?
    ) {
        self.id = id
        self.rawId = rawId
        self.type = "public-key"
        self.response = Response(
            clientDataJSON: clientDataJSON,
            authenticatorData: authenticatorData,
            signature: signature,
            userHandle: userHandle
        )
        self.clientExtensionResults = [:]
    }
}

public struct PasskeyRegistration: Sendable {
    /// Server DTO with only the verification fields.
    public var dto: PasskeyRegistrationDTO
    public var credentialId: String
    public var credentialIdRaw: [UInt8]
    public var prfOutput: [UInt8]?

    public init(dto: PasskeyRegistrationDTO, credentialId: String, credentialIdRaw: [UInt8], prfOutput: [UInt8]?) {
        self.dto = dto
        self.credentialId = credentialId
        self.credentialIdRaw = credentialIdRaw
        self.prfOutput = prfOutput
    }
}

public struct PasskeyAssertion: Sendable {
    public var dto: PasskeyAssertionDTO
    public var credentialId: String
    public var credentialIdRaw: [UInt8]
    public var prfOutput: [UInt8]?

    public init(dto: PasskeyAssertionDTO, credentialId: String, credentialIdRaw: [UInt8], prfOutput: [UInt8]?) {
        self.dto = dto
        self.credentialId = credentialId
        self.credentialIdRaw = credentialIdRaw
        self.prfOutput = prfOutput
    }
}
