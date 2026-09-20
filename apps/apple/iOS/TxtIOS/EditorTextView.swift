import SwiftUI
import TxtCore
import UIKit

/// The editing surface (spec §4.3, §9.5).
///
/// A `UITextView` wrapped for SwiftUI. The same invariants as the macOS side:
/// stable view identity (no per-keystroke rebuild, no `attributedText`
/// reassignment, no `.id(text)`), and IME state observed through
/// `markedTextRange` instead of being forced.
struct EditorTextView: UIViewRepresentable {
    let document: DocumentModel
    let mediaProvider: (String) -> MediaInfo?
    let onDocumentChange: (DocumentModel) -> Void
    let onComposingChange: (Bool) -> Void
    let onFilesDropped: ([URL]) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.isEditable = true
        textView.isSelectable = true
        textView.alwaysBounceVertical = true
        textView.keyboardDismissMode = .interactive
        textView.autocorrectionType = .no
        textView.autocapitalizationType = .none
        textView.spellCheckingType = .no
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.smartInsertDeleteType = .no
        textView.textContainerInset = UIEdgeInsets(top: 20, left: 16, bottom: 20, right: 16)
        textView.textContainer.lineFragmentPadding = 0
        textView.font = .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = .label
        textView.backgroundColor = .systemBackground
        context.coordinator.textView = textView
        context.coordinator.load(document)
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.applyExternal(document, to: textView)
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: EditorTextView
        weak var textView: UITextView?
        private var applyingExternal = false
        private var blockIds: [String] = []
        private var mediaIds: [Int: String] = [:]
        private var compositionActive = false
        private var settleItem: DispatchWorkItem?

        init(_ parent: EditorTextView) {
            self.parent = parent
        }

        // MARK: - Loading and external updates

        func load(_ document: DocumentModel) {
            guard let textView else { return }
            applyingExternal = true
            defer { applyingExternal = false }
            textView.text = EditorBridge.plainText(for: document)
            blockIds = document.blocks.map(\.id)
            mediaIds = Self.mediaMap(document)
            textView.undoManager?.removeAllActions()
            let end = (textView.text as NSString).length
            textView.selectedRange = NSRange(location: end, length: 0)
        }

        /// Skipped while composing: replacing the text would destroy the marked
        /// range (spec §9.5). The sync engine keeps the pending remote version
        /// and re-applies it at the next safe point.
        func applyExternal(_ document: DocumentModel, to textView: UITextView) {
            if document.blocks.map(\.id) == blockIds { return }
            if textView.markedTextRange != nil { return }
            load(document)
        }

        static func mediaMap(_ document: DocumentModel) -> [Int: String] {
            var map: [Int: String] = [:]
            for (index, block) in document.blocks.enumerated() {
                if let mediaId = block.mediaId { map[index] = mediaId }
            }
            return map
        }

        // MARK: - Reading back into the model

        func currentDocument() -> DocumentModel {
            guard let textView else { return DocumentModel.empty() }
            let text = textView.text ?? ""
            var media: [String: MediaInfo] = [:]
            for (_, mediaId) in mediaIds {
                if let info = parent.mediaProvider(mediaId) { media[mediaId] = info }
            }
            return EditorBridge.document(
                fromText: text,
                previous: DocumentModel(blocks: blockIds.enumerated().map { index, id in
                    if let mediaId = mediaIds[index] {
                        return .media(MediaBlock(id: id, mediaId: mediaId))
                    }
                    return .text(TextBlock(id: id, text: ""))
                }, media: media),
                mediaProvider: { parent.mediaProvider($0) }
            )
        }

        // MARK: - IME (spec §9.5)

        func textViewDidChange(_ textView: UITextView) {
            guard !applyingExternal else { return }
            let marked = textView.markedTextRange != nil
            if marked {
                if !compositionActive {
                    compositionActive = true
                    parent.onComposingChange(true)
                }
                scheduleSettleCheck()
                return
            }
            if compositionActive {
                scheduleSettleCheck()
                return
            }
            parent.onDocumentChange(currentDocument())
        }

        private func scheduleSettleCheck() {
            settleItem?.cancel()
            let textViewRef = textView
            let item = DispatchWorkItem { [weak self] in
                guard let self, let textView = textViewRef else { return }
                if textView.markedTextRange != nil {
                    self.scheduleSettleCheck()
                    return
                }
                self.compositionActive = false
                self.parent.onComposingChange(false)
                self.parent.onDocumentChange(self.currentDocument())
            }
            settleItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: item)
        }

        /// True while marked text exists (used by the save path).
        var isComposing: Bool {
            textView?.markedTextRange != nil
        }
    }
}
