import Foundation

/// API client (spec §12.2).
///
/// The native app talks to the fixed HTTPS origin with a Keychain Bearer token
/// instead of a cookie (spec §5.4). Every state-changing request carries
/// `X-Txt-Request: 1`, matching the Web behaviour so the Worker's CSRF checks
/// stay uniform.
public struct ApiClient: Sendable {
    public struct DocumentEnvelope: Sendable {
        public var data: DocumentResponse?
        public var etag: String?
        public var notModified: Bool
    }

    public struct DocumentResponse: Sendable, Decodable {
        public var accountId: String
        public var documentId: String
        public var syncEpoch: Int
        public var revision: Int
        public var encryptedRevision: Int
        public var formatVersion: Int
        public var keyVersion: Int
        public var mutationId: String
        public var nonce: String
        public var ciphertext: String
        public var referencedMediaIds: [String]
        public var updatedAt: Int
    }

    public struct SessionInfo: Sendable, Decodable {
        public var accountId: String
        public var displayLabel: String?
        public var accountStatus: String
        public var userHandle: String?
        public var scope: String
        public var clientKind: String
        public var via: String
        public var stepupAt: Int?
        public var expiresAt: Int
        public var idleExpiresAt: Int
    }

    public struct KeyEnvelope: Sendable, Decodable {
        public var credentialId: String
        public var formatVersion: Int
        public var keyVersion: Int
        public var wrapSalt32: String
        public var nonce: String
        public var wrappedKey: String
    }

    public struct KeysResponse: Sendable, Decodable {
        public var envelopes: [KeyEnvelope]
        public var recovery: RecoveryRecord?
    }

    public struct RecoveryRecord: Sendable, Decodable {
        public var recoveryVersion: Int
        public var keyVersion: Int
        public var nonce: String
        public var wrappedKey: String
    }

    public struct PutResult: Sendable, Decodable {
        public var etag: String
        public var revision: Int
        public var mutationId: String
        public var updatedAt: Int
    }

    public struct BootstrapResult: Sendable, Decodable {
        public var ok: Bool
        public var bootstrapId: String
        public var documentId: String
    }

    /// `{"error":{"code","message"}}` (spec §12.2).
    public struct ApiErrorBody: Sendable, Decodable {
        public struct Inner: Sendable, Decodable {
            public var code: String
            public var message: String
        }
        public var error: Inner
    }

    public var origin: URL
    public var tokenProvider: @Sendable () -> String?
    private let session: URLSession

    public init(origin: URL, tokenProvider: @escaping @Sendable () -> String?) {
        self.origin = origin
        self.tokenProvider = tokenProvider
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 600
        // The API never benefits from a URL cache: ciphertext responses carry
        // their own ETag contract and everything is private, no-store.
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
    }

    // MARK: - Transport

    private func requestBody<T: Decodable>(
        _ path: String,
        method: String,
        body: Data,
        headers: [String: String] = [:],
        decode: T.Type
    ) async throws -> T {
        guard let url = URL(string: path, relativeTo: origin) else {
            throw TxtError.network("bad path \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        request.setValue("1", forHTTPHeaderField: "X-Txt-Request")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw TxtError.network("non-HTTP response for \(path)")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw Self.apiError(status: http.statusCode, data: data)
            }
            if T.self == EmptyResponse.self { return EmptyResponse() as! T }
            return try JSONDecoder().decode(T.self, from: data)
        } catch let error as TxtError {
            throw error
        } catch {
            throw TxtError.network("\(path): \(error.localizedDescription)")
        }
    }

    private func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        json: [String: Any]? = nil,
        headers: [String: String] = [:],
        decode: T.Type
    ) async throws -> T {
        let (data, response) = try await perform(path, method: method, json: json, headers: headers)
        if response.statusCode == 304 {
            guard let empty = EmptyResponse() as? T else {
                throw TxtError.network("unexpected 304 for \(path)")
            }
            return empty
        }
        guard (200..<300).contains(response.statusCode) else {
            throw Self.apiError(status: response.statusCode, data: data)
        }
        if T.self == EmptyResponse.self { return EmptyResponse() as! T }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw TxtError.decoding("\(path): \(error)")
        }
    }

    private func perform(
        _ path: String,
        method: String,
        json: [String: Any]?,
        headers: [String: String]
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: origin) else {
            throw TxtError.network("bad path \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        if method != "GET" && method != "HEAD" {
            request.setValue("1", forHTTPHeaderField: "X-Txt-Request")
        }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw TxtError.network("non-HTTP response for \(path)")
            }
            return (data, http)
        } catch let error as TxtError {
            throw error
        } catch {
            throw TxtError.network("\(path): \(error.localizedDescription)")
        }
    }

    static func apiError(status: Int, data: Data) -> TxtError {
        if let body = try? JSONDecoder().decode(ApiErrorBody.self, from: data) {
            return .api(status: status, code: body.error.code, message: body.error.message)
        }
        return .api(status: status, code: "HTTP_ERROR", message: "request failed (\(status))")
    }

    struct EmptyResponse: Decodable {}

    // MARK: - Auth (spec §5.2)

    public struct RegisterOptions: Sendable, Decodable {
        public struct Options: Sendable, Decodable {
            public var challenge: String
            public var rp: RP
            public var user: User
            public var pubKeyCredParams: [PubKeyParam]
            public var excludeCredentials: [ExcludeCredential]?
            public var authenticatorSelection: AuthenticatorSelection?
            public var attestation: String?
            public var extensions: [String: JSONValue]?

            public struct RP: Sendable, Decodable { public var id: String; public var name: String }
            public struct User: Sendable, Decodable { public var id: String; public var name: String; public var displayName: String }
            public struct PubKeyParam: Sendable, Decodable { public var type: String; public var alg: Int }
            public struct ExcludeCredential: Sendable, Decodable { public var id: String; public var type: String }
            public struct AuthenticatorSelection: Sendable, Decodable {
                public var residentKey: String?
                public var userVerification: String?
                public var authenticatorAttachment: String?
            }
        }
        public var accountId: String
        public var options: Options
    }

    public struct LoginOptions: Sendable, Decodable {
        public struct Options: Sendable, Decodable {
            public var challenge: String
            public var rpId: String
            public var allowCredentials: [AllowCredential]?
            public var userVerification: String?
            public var extensions: [String: JSONValue]?

            public struct AllowCredential: Sendable, Decodable { public var id: String; public var type: String }
        }
        public var options: Options
    }

    public struct VerifyResult: Sendable, Decodable {
        public var accountId: String
        public var credentialId: String
        public var scope: String
        /// Present on login (native Bearer token, spec §5.4).
        public var token: String?
        public var expiresAt: Int?
    }

    public func registerOptions() async throws -> RegisterOptions {
        try await request("/api/v1/auth/register/options", method: "POST", json: [:], decode: RegisterOptions.self)
    }

    /// Native sends `clientKind: "native"` so the challenge is bound to the
    /// native client and the session is issued as a Bearer token.
    public func registerVerify(_ response: PasskeyRegistrationDTO) async throws -> VerifyResult {
        let body = try JSONEncoder().encode(["response": response])
        return try await requestBody(
            "/api/v1/auth/register/verify",
            method: "POST",
            body: body,
            decode: VerifyResult.self
        )
    }

    public func loginOptions() async throws -> LoginOptions {
        try await request("/api/v1/auth/login/options", method: "POST", json: [:], decode: LoginOptions.self)
    }

    public func loginVerify(_ response: PasskeyAssertionDTO) async throws -> VerifyResult {
        let body = try JSONEncoder().encode(["response": response])
        return try await requestBody(
            "/api/v1/auth/login/verify",
            method: "POST",
            body: body,
            decode: VerifyResult.self
        )
    }

    public func stepupOptions(credentialId: String? = nil) async throws -> LoginOptions {
        var json: [String: Any] = [:]
        if let credentialId { json["credentialId"] = credentialId }
        return try await request("/api/v1/auth/stepup/options", method: "POST", json: json, decode: LoginOptions.self)
    }

    public func stepupVerify(_ response: [String: Any]) async throws -> [String: JSONValue] {
        struct Result: Decodable {
            var ok: Bool
            var stepupAt: Int
            var credentialId: String
        }
        let result = try await request(
            "/api/v1/auth/stepup/verify",
            method: "POST",
            json: ["response": response],
            decode: Result.self
        )
        return ["ok": .bool(result.ok), "stepupAt": .number(Double(result.stepupAt))]
    }

    public func session() async throws -> SessionInfo {
        try await request("/api/v1/session", decode: SessionInfo.self)
    }

    public func endSession() async throws {
        _ = try await request("/api/v1/session", method: "DELETE", decode: EmptyResponse.self)
    }

    // MARK: - Identity (§5.3, §7)

    public func bootstrap(_ payload: [String: Any]) async throws -> BootstrapResult {
        try await request("/api/v1/bootstrap", method: "POST", json: payload, decode: BootstrapResult.self)
    }

    public func keys(credentialId: String? = nil) async throws -> KeysResponse {
        let path = credentialId.map { "/api/v1/keys?credentialId=\($0)" } ?? "/api/v1/keys"
        return try await request(path, decode: KeysResponse.self)
    }

    public struct CredentialSummary: Sendable, Decodable {
        public var credentialId: String
        public var deviceType: String
        public var backedUp: Bool
        public var status: String
        public var createdAt: Int
        public var lastUsedAt: Int?
    }

    public struct CredentialsResponse: Sendable, Decodable {
        public var credentials: [CredentialSummary]
    }

    public func credentials() async throws -> CredentialsResponse {
        try await request("/api/v1/credentials", decode: CredentialsResponse.self)
    }

    public func credentialAddOptions(userHandle: String) async throws -> RegisterOptions {
        try await request(
            "/api/v1/credentials/options",
            method: "POST",
            json: ["userHandle": userHandle],
            decode: RegisterOptions.self
        )
    }

    public struct CredentialAddResult: Sendable, Decodable {
        public var credentialId: String
        public var status: String
    }

    public func credentialAddVerify(_ response: [String: Any]) async throws -> CredentialAddResult {
        try await request(
            "/api/v1/credentials/verify",
            method: "POST",
            json: ["response": response],
            decode: CredentialAddResult.self
        )
    }

    public func credentialActivate(_ payload: [String: Any]) async throws -> CredentialAddResult {
        try await request(
            "/api/v1/credentials/activate",
            method: "POST",
            json: payload,
            decode: CredentialAddResult.self
        )
    }

    public func revokeCredential(_ credentialId: String) async throws {
        _ = try await request(
            "/api/v1/credentials/\(credentialId)",
            method: "DELETE",
            decode: EmptyResponse.self
        )
    }

    public func recoveryStart(accountId: String, recoveryAuth: String) async throws -> [String: JSONValue] {
        struct Result: Decodable {
            var scope: String
            var recoveryVersion: Int
            var keyVersion: Int
        }
        let result = try await request(
            "/api/v1/recovery/start",
            method: "POST",
            json: ["accountId": accountId, "recoveryAuth": recoveryAuth],
            decode: Result.self
        )
        return [
            "scope": .string(result.scope),
            "recoveryVersion": .number(Double(result.recoveryVersion)),
            "keyVersion": .number(Double(result.keyVersion)),
        ]
    }

    public struct RecoveryCompleteResult: Sendable, Decodable {
        public var ok: Bool
        public var operationId: String
        public var credentialId: String
    }

    public func recoveryComplete(_ payload: [String: Any]) async throws -> RecoveryCompleteResult {
        try await request("/api/v1/recovery/complete", method: "POST", json: payload, decode: RecoveryCompleteResult.self)
    }

    public struct RotateRecoveryResult: Sendable, Decodable {
        public var ok: Bool
        public var recoveryVersion: Int
    }

    public func rotateRecovery(_ payload: [String: Any]) async throws -> RotateRecoveryResult {
        try await request("/api/v1/recovery", method: "PUT", json: payload, decode: RotateRecoveryResult.self)
    }

    // MARK: - Document (§10, §12.2)

    public func document(etag: String? = nil) async throws -> DocumentEnvelope {
        var headers: [String: String] = [:]
        if let etag { headers["If-None-Match"] = etag }
        guard let url = URL(string: "/api/v1/document", relativeTo: origin) else {
            throw TxtError.network("bad document path")
        }
        var request = URLRequest(url: url)
        if let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw TxtError.network("non-HTTP response for document")
            }
            if http.statusCode == 304 {
                return DocumentEnvelope(data: nil, etag: etag, notModified: true)
            }
            guard (200..<300).contains(http.statusCode) else {
                throw Self.apiError(status: http.statusCode, data: data)
            }
            let decoded = try JSONDecoder().decode(DocumentResponse.self, from: data)
            return DocumentEnvelope(
                data: decoded,
                etag: http.value(forHTTPHeaderField: "ETag"),
                notModified: false
            )
        } catch let error as TxtError {
            throw error
        } catch {
            throw TxtError.network("document: \(error.localizedDescription)")
        }
    }

    /// A document update payload as a concrete, `Sendable` value.
    ///
    /// `[String: Any]` cannot cross an actor boundary under Swift 6's checks,
    /// and it would also let a caller smuggle unexpected fields into the wire
    /// body. The fields are exactly the ones the Worker accepts (spec §12.2).
    public struct DocumentPayload: Sendable, Encodable {
        public var mutationId: String
        public var formatVersion: Int
        public var keyVersion: Int
        public var encryptedRevision: Int
        public var nonce: String
        public var ciphertext: String
        public var referencedMediaIds: [String]

        public init(
            mutationId: String,
            formatVersion: Int,
            keyVersion: Int,
            encryptedRevision: Int,
            nonce: String,
            ciphertext: String,
            referencedMediaIds: [String]
        ) {
            self.mutationId = mutationId
            self.formatVersion = formatVersion
            self.keyVersion = keyVersion
            self.encryptedRevision = encryptedRevision
            self.nonce = nonce
            self.ciphertext = ciphertext
            self.referencedMediaIds = referencedMediaIds
        }
    }

    /// The wire contract requires `encryptedRevision == current revision + 1`
    /// and the caller must send the ETag it based its edit on (spec §10.2).
    public func putDocument(_ payload: DocumentPayload, etag: String) async throws -> PutResult {
        let body = try JSONEncoder().encode(payload)
        return try await requestBody(
            "/api/v1/document",
            method: "PUT",
            body: body,
            headers: ["If-Match": etag],
            decode: PutResult.self
        )
    }

    // MARK: - Media (§11)

    public struct StartUploadResult: Sendable, Decodable {
        public var mediaId: String
        public var state: String
        public var partCount: Int
        public var partBytes: Int
        public var cipherBytes: Int
        public var replayed: Bool
    }

    public func startUpload(_ payload: [String: Any]) async throws -> StartUploadResult {
        try await request("/api/v1/media/uploads", method: "POST", json: payload, decode: StartUploadResult.self)
    }

    public struct UploadStatus: Sendable, Decodable {
        public struct AcceptedPart: Sendable, Decodable {
            public var partNumber: Int
            public var bytes: Int
        }
        public var mediaId: String
        public var state: String
        public var cipherBytes: Int
        public var partCount: Int
        public var acceptedParts: [AcceptedPart]
    }

    public func uploadStatus(mediaId: String) async throws -> UploadStatus {
        try await request("/api/v1/media/uploads/\(mediaId)", decode: UploadStatus.self)
    }

    public func uploadPart(mediaId: String, partNumber: Int, bytes: [UInt8]) async throws {
        guard let url = URL(string: "/api/v1/media/uploads/\(mediaId)/parts/\(partNumber)", relativeTo: origin) else {
            throw TxtError.network("bad part path")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        if let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("1", forHTTPHeaderField: "X-Txt-Request")
        request.httpBody = Data(bytes)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw TxtError.network("non-HTTP response for part upload")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.apiError(status: http.statusCode, data: data)
        }
    }

    public struct CompleteUploadResult: Sendable, Decodable {
        public var mediaId: String
        public var state: String
        public var cipherBytes: Int
    }

    public func completeUpload(mediaId: String) async throws -> CompleteUploadResult {
        try await request(
            "/api/v1/media/uploads/\(mediaId)/complete",
            method: "POST",
            json: [:],
            decode: CompleteUploadResult.self
        )
    }

    public func cancelUpload(mediaId: String) async throws {
        _ = try await request("/api/v1/media/uploads/\(mediaId)", method: "DELETE", decode: EmptyResponse.self)
    }

    /// Range read of the stored ciphertext (spec §11.5).
    public func cipherRange(mediaId: String, start: Int, end: Int) async throws -> (bytes: [UInt8], status: Int) {
        guard let url = URL(string: "/api/v1/media/\(mediaId)/cipher", relativeTo: origin) else {
            throw TxtError.network("bad cipher path")
        }
        var request = URLRequest(url: url)
        if let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw TxtError.network("non-HTTP response for cipher range")
        }
        guard http.statusCode == 206 || http.statusCode == 200 else {
            throw Self.apiError(status: http.statusCode, data: data)
        }
        return ([UInt8](data), http.statusCode)
    }

    // MARK: - Sessions & account (§5, §12.2)

    public struct SessionRow: Sendable, Decodable {
        public var sid: String
        public var clientKind: String
        public var scope: String
        public var createdAt: Int
        public var expiresAt: Int
        public var idleExpiresAt: Int
        public var isCurrent: Bool
    }

    public struct SessionsResponse: Sendable, Decodable {
        public var sessions: [SessionRow]
    }

    public func sessions() async throws -> SessionsResponse {
        try await request("/api/v1/sessions", decode: SessionsResponse.self)
    }

    public func revokeSession(_ sid: String) async throws {
        _ = try await request("/api/v1/sessions/\(sid)", method: "DELETE", decode: EmptyResponse.self)
    }

    public struct DeleteAccountResult: Sendable, Decodable {
        public var ok: Bool
        public var operationId: String
        public var state: String
    }

    public func deleteAccount(operationId: String) async throws -> DeleteAccountResult {
        try await request(
            "/api/v1/account",
            method: "DELETE",
            json: ["confirm": "DELETE", "operationId": operationId],
            decode: DeleteAccountResult.self
        )
    }
}

/// Minimal JSON value for endpoints whose shape is not part of the client
/// contract (kept explicit so nothing accidentally round-trips unknown data).
public enum JSONValue: Sendable, Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        self = .null
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}
