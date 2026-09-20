import AuthenticationServices
import CryptoKit
import Foundation
import TxtCore

/// Passkey ceremonies with PRF (spec §6.2, §13), shared by macOS and iOS.
///
/// The native client uses `ASAuthorization` with the shared RP ID
/// `txt.2-38.com` and the fixed public PRF input, so the KEK it derives for a
/// credential is byte-identical to the one the Web client derives for the same
/// credential. A ceremony that authenticates without a usable PRF is a failure:
/// there is no server-side key fallback (spec §7).
///
/// The DTOs carry **only** the fields signature verification needs. PRF results
/// never travel; the server sanitizes again on arrival, so a mistake here would
/// still be caught — but it must not happen.
@MainActor
final class PasskeyClient: NSObject, PasskeyCeremonies, @unchecked Sendable {
    enum PasskeyError: Error, LocalizedError {
        case cancelled
        case noPrf
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .cancelled: "操作がキャンセルされました。"
            case .noPrf: "この環境では、このパスキーで暗号化された内容を開けません。"
            case .failed(let message): message
            }
        }
    }

    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    /// The fixed PRF salt shared with the Web client (spec §6.2).
    private var prfSalt: Data {
        Data([UInt8](TxtCrypto.prfInputV1))
    }

    // MARK: - Registration

    func createCredential(
        options: ApiClient.RegisterOptions.Options,
        rpId: String
    ) async throws -> PasskeyRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let challenge = (try? Base64Url.decode(options.challenge)).map { Data($0) } ?? Data()
        let userID = (try? Base64Url.decode(options.user.id)).map { Data($0) } ?? Data()
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: options.user.name,
            userID: userID
        )
        request.userVerificationPreference = .preferred
        request.attestationPreference = .none
        request.prf = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.inputValues(
            .init(saltInput1: prfSalt)
        )

        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw PasskeyError.failed("パスキーの作成に失敗しました。")
        }
        let credentialIdRaw = [UInt8](credential.credentialID)
        let clientDataJSON = Base64Url.encode([UInt8](credential.rawClientDataJSON))
        let attestationObject = Base64Url.encode([UInt8](credential.rawAttestationObject ?? Data()))
        guard !attestationObject.isEmpty else {
            throw PasskeyError.failed("パスキーの構成情報を取得できませんでした。")
        }
        let dto = PasskeyRegistrationDTO(
            id: Base64Url.encode(credentialIdRaw),
            rawId: Base64Url.encode(credentialIdRaw),
            clientDataJSON: clientDataJSON,
            attestationObject: attestationObject
        )
        return PasskeyRegistration(
            dto: dto,
            credentialId: Base64Url.encode(credentialIdRaw),
            credentialIdRaw: credentialIdRaw,
            prfOutput: Self.symmetricKeyBytes(credential.prf?.first)
        )
    }

    // MARK: - Assertion

    func assertCredential(
        options: ApiClient.LoginOptions.Options,
        rpId: String
    ) async throws -> PasskeyAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let challenge = (try? Base64Url.decode(options.challenge)).map { Data($0) } ?? Data()
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .preferred
        if let allowed = options.allowCredentials, !allowed.isEmpty {
            request.allowedCredentials = allowed.compactMap { entry -> ASAuthorizationPlatformPublicKeyCredentialDescriptor? in
                guard let id = try? Base64Url.decode(entry.id) else { return nil }
                return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: Data(id))
            }
        }
        request.prf = ASAuthorizationPublicKeyCredentialPRFAssertionInput.inputValues(
            .init(saltInput1: prfSalt)
        )
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyError.failed("パスキーの確認に失敗しました。")
        }
        let credentialIdRaw = [UInt8](credential.credentialID)
        // The user handle belongs in `response.userHandle`, never inside
        // authenticatorData (spec §6.2).
        let userHandle = credential.userID.isEmpty
            ? nil
            : Base64Url.encode([UInt8](credential.userID))
        let dto = PasskeyAssertionDTO(
            id: Base64Url.encode(credentialIdRaw),
            rawId: Base64Url.encode(credentialIdRaw),
            clientDataJSON: Base64Url.encode([UInt8](credential.rawClientDataJSON)),
            authenticatorData: Base64Url.encode([UInt8](credential.rawAuthenticatorData)),
            signature: Base64Url.encode([UInt8](credential.signature)),
            userHandle: userHandle
        )
        // `first` is the PRF output for saltInput1 — exactly the bytes the Web
        // client reads from `getClientExtensionResults().prf.results.first`.
        return PasskeyAssertion(
            dto: dto,
            credentialId: Base64Url.encode(credentialIdRaw),
            credentialIdRaw: credentialIdRaw,
            prfOutput: Self.symmetricKeyBytes(credential.prf?.first)
        )
    }

    // MARK: - Session token

    nonisolated func storeSessionToken(_ token: String) async {
        SessionTokenStore.store(token: token)
    }

    /// Extracts raw bytes from a `SymmetricKey` PRF output.
    private static func symmetricKeyBytes(_ key: SymmetricKey?) -> [UInt8]? {
        guard let key else { return nil }
        return key.withUnsafeBytes { Array($0) }
    }

    // MARK: - Controller plumbing

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }
}

extension PasskeyClient: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        Task { @MainActor in
            continuation?.resume(returning: authorization)
            continuation = nil
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        Task { @MainActor in
            let mapped: Error
            if let asError = error as? ASAuthorizationError, asError.code == .canceled {
                mapped = PasskeyError.cancelled
            } else {
                mapped = PasskeyError.failed(error.localizedDescription)
            }
            continuation?.resume(throwing: mapped)
            continuation = nil
        }
    }
}

extension PasskeyClient: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            #if os(macOS)
            NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
            #else
            // iOS: the key window of the active scene.
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
            return window ?? ASPresentationAnchor()
            #endif
        }
    }
}
