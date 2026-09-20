import Foundation

/// Gate presentation rules (spec §4.6).
///
/// Both apps render the same gate, so the rules live here rather than in each
/// app: a missing "パスキーで開く" on first visit sent a user with an existing
/// Web account into a second, separate account, which is exactly what this
/// table prevents. Keep it in one place and pin it with tests.
public enum GatePresentation {
    /// What the visitor is looking at.
    public enum State: Sendable, Equatable {
        case loading
        /// No session: the normal entry point for a returning user.
        case firstVisit
        /// A session exists but the vault is locked (idle lock, relaunch).
        case needsUnlock
        /// Passkey created, bootstrap not finished.
        case completingRegistration
        case error
    }

    public struct Actions: Sendable, Equatable {
        /// Label of the primary button; empty means no primary action.
        public var primary: String
        /// "復旧キーで開く" — offered whenever a lock could stand in the way.
        public var showsRecovery: Bool
        /// "はじめて使う" — the deliberate path to a second account.
        public var showsRegister: Bool
        /// Whether the primary action unlocks an existing account (create is
        /// always the explicit "はじめて使う" button).
        public var primaryUnlocks: Bool

        public init(primary: String, showsRecovery: Bool, showsRegister: Bool, primaryUnlocks: Bool) {
            self.primary = primary
            self.showsRecovery = showsRecovery
            self.showsRegister = showsRegister
            self.primaryUnlocks = primaryUnlocks
        }
    }

    /// The action set for a state (spec §4.6).
    ///
    /// - The first visit shows **「パスキーで開く」 as the primary action** and
    ///   「はじめて使う」 as the explicit alternative: most people arriving on a
    ///   new device already have an account created elsewhere.
    /// - Recovery is reachable from every non-loading state; it is the only way
    ///   in when the passkey itself is unavailable.
    public static func actions(for state: State) -> Actions {
        switch state {
        case .loading:
            Actions(primary: "", showsRecovery: false, showsRegister: false, primaryUnlocks: false)
        case .firstVisit:
            Actions(primary: "パスキーで開く", showsRecovery: true, showsRegister: true, primaryUnlocks: true)
        case .needsUnlock:
            Actions(primary: "パスキーで開く", showsRecovery: true, showsRegister: true, primaryUnlocks: true)
        case .completingRegistration:
            Actions(primary: "続ける", showsRecovery: true, showsRegister: true, primaryUnlocks: true)
        case .error:
            Actions(primary: "もう一度試す", showsRecovery: true, showsRegister: true, primaryUnlocks: true)
        }
    }
}
