import Foundation
import Testing

@testable import TxtCore

/// Gate presentation (spec §4.6).
///
/// The rule that matters and was violated once: a first visit must offer
/// "パスキーで開く". Offering only "create a new passkey" sends a user who
/// already has an account (created on the Web or another device) into a second,
/// separate account, and there is no way for them to reach their existing data.
struct GatePresentationTests {
    @Test func firstVisitOffersUnlockAndRegister() {
        let actions = GatePresentation.actions(for: .firstVisit)
        #expect(actions.primary == "パスキーで開く", "first visit must unlock, not create")
        #expect(actions.primaryUnlocks)
        #expect(actions.showsRegister, "creating an account stays available explicitly")
        #expect(actions.showsRecovery)
    }

    @Test func needsUnlockOffersBothPaths() {
        let actions = GatePresentation.actions(for: .needsUnlock)
        #expect(actions.primary == "パスキーで開く")
        #expect(actions.primaryUnlocks)
        #expect(actions.showsRegister)
        #expect(actions.showsRecovery)
    }

    @Test func errorStateRetriesAndStillUnlocks() {
        let actions = GatePresentation.actions(for: .error)
        #expect(actions.primary == "もう一度試す")
        #expect(actions.primaryUnlocks, "the retry path must not create an account")
        #expect(actions.showsRegister)
        #expect(actions.showsRecovery)
    }

    @Test func pendingRegistrationContinuesInsteadOfCreatingAgain() {
        let actions = GatePresentation.actions(for: .completingRegistration)
        #expect(actions.primary == "続ける")
        #expect(actions.primaryUnlocks)
        #expect(actions.showsRecovery)
    }

    @Test func loadingAndEditingOfferNoGateAction() {
        for state in [GatePresentation.State.loading] {
            let actions = GatePresentation.actions(for: state)
            #expect(actions.primary.isEmpty)
            #expect(!actions.showsRegister)
            #expect(!actions.showsRecovery)
        }
    }

    @Test func everyNonLoadingStateCanReachRecovery() {
        // Recovery is the only way in when the passkey is gone, so it must never
        // be hidden behind a state the user cannot leave.
        for state in [
            GatePresentation.State.firstVisit,
            .needsUnlock,
            .completingRegistration,
            .error,
        ] {
            #expect(GatePresentation.actions(for: state).showsRecovery, "\(state) must offer recovery")
        }
    }

    @Test func noStateOffersOnlyAccountCreation() {
        // The regression this table exists to prevent.
        for state in [
            GatePresentation.State.firstVisit,
            .needsUnlock,
            .completingRegistration,
            .error,
        ] {
            let actions = GatePresentation.actions(for: state)
            #expect(!actions.primary.isEmpty, "\(state) needs a primary action")
            #expect(actions.primaryUnlocks, "\(state) must unlock an existing account")
        }
    }
}
