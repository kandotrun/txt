import SwiftUI
import TxtCore

/// iOS application entry point (spec §4.3).
///
/// One scene, no document list, standard toolbar; the keyboard appears only
/// when the body is tapped (the editor never forces first responder).
@main
struct TxtIOSApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task { await model.onAppear() }
        }
    }
}

/// Chooses between the gate and the editing surface (spec §4.3, §4.6).
struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .editing:
                    EditingView()
                default:
                    GateView()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            // The navigation bar stays visible: the toolbar (添付 / その他) lives
            // on it, and hiding it removed the only way to attach a file.
        }
    }
}
