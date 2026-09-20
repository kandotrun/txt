import AuthenticationServices
import CryptoKit
import Foundation
import TxtCore

/// Passkey ceremonies with PRF (spec §6.2, §13).
///
/// The native client uses `ASAuthorization` with the shared RP ID
/// `txt.2-38.com` and the fixed public PRF input, so the KEK it derives for a
/// credential is byte-identical to the one the Web client derives for the same
/// credential. A ceremony that authenticates without a usable PRF is a failure:
/// there is no server-side key fallback (spec §7).
@MainActor
final class PasskeyClient: NSObject {
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

    struct Ceremony: Sendable {
        var credentialId: String
        var credentialIdRaw: [UInt8]
        var prfOutput: [UInt8]?
    }

    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    /// The fixed PRF salt shared with the Web client (spec §6.2).
    private var prfSalt: Data {
        Data([UInt8](TxtCrypto.prfInputV1))
    }

    // MARK: - Registration

    func createCredential(options: ApiClient.RegisterOptions.Options, rpId: String) async throws -> Ceremony {
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
        // Evaluating the PRF at registration is what makes the credential
        // usable for unwrapping without a second ceremony later.
        request.prf = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.inputValues(
            .init(saltInput1: prfSalt)
        )

        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw PasskeyError.failed("パスキーの作成に失敗しました。")
        }
        return Ceremony(
            credentialId: Base64Url.encode([UInt8](credential.credentialID)),
            credentialIdRaw: [UInt8](credential.credentialID),
            prfOutput: Self.symmetricKeyBytes(credential.prf?.first)
        )
    }

    // MARK: - Assertion

    func assertCredential(options: ApiClient.LoginOptions.Options, rpId: String) async throws -> Ceremony {
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
        // `first` is the PRF output for saltInput1 — exactly the bytes the Web
        // client reads from `getClientExtensionResults().prf.results.first`.
        let prfOutput = Self.symmetricKeyBytes(credential.prf?.first)
        return Ceremony(
            credentialId: Base64Url.encode([UInt8](credential.credentialID)),
            credentialIdRaw: [UInt8](credential.credentialID),
            prfOutput: prfOutput
        )
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
            NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        }
    }
}
