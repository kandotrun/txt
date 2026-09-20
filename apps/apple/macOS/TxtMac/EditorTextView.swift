import AppKit
import SwiftUI
import TxtCore

/// The editing surface (spec §4.4, §9.5).
///
/// An `NSTextView` wrapped for SwiftUI. Two invariants drive the design:
///
/// - **The view identity is stable.** No per-keystroke rebuild, no
///   `attributedString` reassignment, no `.id(text)`; `textStorage` only changes
///   through an explicit replacement path.
/// - **IME state is observed, never forced.** `hasMarkedText()` decides whether
///   a change is committed, and nothing writes storage while composing
///   (spec §9.5).
///
/// The shared model's text block holds LF literally, so one text block is one
/// paragraph in the engine: internal newlines are soft wrapping, and the block
/// separator stays invisible to the user as an ordinary newline.
struct EditorTextView: NSViewRepresentable {
    let document: DocumentModel
    let mediaProvider: (String) -> MediaInfo?
    let onDocumentChange: (DocumentModel) -> Void
    let onComposingChange: (Bool) -> Void
    let onFilesDropped: ([URL], Int) -> Void
    /// Reports the caret's block index so an attachment can be inserted at the
    /// caret (spec §11.3). The view calls this with a closure that reads the
    /// editor's current position on demand.
    let onInsertionPointChanged: (@escaping () -> Int) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.allowsUndo = true
        textView.usesFindBar = true
        textView.isIncrementalSearchingEnabled = true
        textView.textContainerInset = NSSize(width: 24, height: 20)
        let font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        textView.font = font
        textView.typingAttributes = [.font: font, .foregroundColor: NSColor.textColor]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        textView.registerForDraggedTypes([.fileURL])
        // Keep the model's block IDs alive across edits: the coordinator maps
        // storage paragraphs back onto them, preserving identity where it can.
        context.coordinator.textView = textView
        context.coordinator.load(document)
        // Give the model a way to read the caret on demand.
        onInsertionPointChanged { [weak coordinator = context.coordinator] in
            coordinator?.insertionBlockIndex() ?? 0
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        context.coordinator.applyExternal(document, to: textView)
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: EditorTextView
        weak var textView: NSTextView?
        /// True while this coordinator writes storage, so delegate callbacks
        /// caused by our own write are not reported as user edits.
        private var applyingExternal = false
        /// Block IDs in storage order, so a plain-text edit keeps them stable.
        private var blockIds: [String] = []
        private var mediaIds: [Int: String] = [:]
        private var compositionActive = false
        private var settleItem: DispatchWorkItem?

        init(_ parent: EditorTextView) {
            self.parent = parent
        }

        // MARK: - Loading and external updates

        /// Full replacement: initial load, remote adoption, draft recovery.
        func load(_ document: DocumentModel) {
            guard let textView else { return }
            applyingExternal = true
            defer { applyingExternal = false }
            let text = Self.plainText(for: document)
            textView.string = text
            blockIds = document.blocks.map(\.id)
            mediaIds = Self.mediaMap(document)
            applyAttachmentStyling(textView)
            textView.undoManager?.removeAllActions()
            let end = (text as NSString).length
            textView.setSelectedRange(NSRange(location: end, length: 0))
        }

        /// Applies a model that changed elsewhere (remote version, draft).
        ///
        /// Skipped entirely while composing: replacing storage would destroy the
        /// marked range (spec §9.5). The caller re-applies at the next safe
        /// point because the sync engine keeps the pending remote candidate.
        func applyExternal(_ document: DocumentModel, to textView: NSTextView) {
            if document.blocks.map(\.id) == blockIds { return }
            if textView.hasMarkedText() { return }
            load(document)
        }

        static func mediaMap(_ document: DocumentModel) -> [Int: String] {
            var map: [Int: String] = [:]
            for (index, block) in document.blocks.enumerated() {
                if let mediaId = block.mediaId { map[index] = mediaId }
            }
            return map
        }

        /// Plain text with an attachment placeholder per media block.
        static func plainText(for document: DocumentModel) -> String {
            var parts: [String] = []
            for block in document.blocks {
                switch block {
                case .text(let text): parts.append(text.text)
                case .media: parts.append("\u{FFFC}")
                }
            }
            // Block boundaries are ordinary newlines in the engine's view.
            return parts.joined(separator: "\n")
        }

        private func applyAttachmentStyling(_ textView: NSTextView) {
            // Attachment placeholders render as a media marker. The real player
            // view is provided later by the media node view; keeping a visible
            // marker now means the document structure is never invisible.
            guard let storage = textView.textStorage else { return }
            let full = NSRange(location: 0, length: storage.length)
            let body = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            storage.addAttributes(
                [.font: body, .foregroundColor: NSColor.textColor],
                range: full
            )
        }

        // MARK: - Reading storage back into the model

        /// The block index containing the caret, for attachment insertion.
        func insertionBlockIndex() -> Int {
            guard let textView else { return 0 }
            let location = textView.selectedRange().location
            let text = textView.string as NSString
            let prefix = text.substring(to: min(location, text.length))
            // One block per paragraph, so the caret's block is the number of
            // newlines before it.
            return prefix.components(separatedBy: "\n").count - 1
        }

        /// Serializes storage into the shared model, preserving block IDs where
        /// the paragraph count allows it (spec §8: normal edits never regenerate
        /// IDs).
        func currentDocument() -> DocumentModel {
            guard let textView, let textStorage = textView.textStorage else {
                return DocumentModel.empty()
            }
            let paragraphs = Self.paragraphs(from: textStorage.string)
            var blocks: [Block] = []
            for (index, paragraph) in paragraphs.enumerated() {
                let id = index < blockIds.count ? blockIds[index] : UUID().uuidString.lowercased()
                if let mediaId = mediaIds[index] {
                    blocks.append(.media(MediaBlock(id: id, mediaId: mediaId)))
                } else {
                    blocks.append(.text(TextBlock(id: id, text: paragraph)))
                }
            }
            if blocks.isEmpty {
                blocks = [.text(TextBlock(id: UUID().uuidString.lowercased(), text: ""))]
            }
            var media: [String: MediaInfo] = [:]
            for (_, mediaId) in mediaIds {
                if let info = parent.mediaProvider(mediaId) { media[mediaId] = info }
            }
            return DocumentModel(blocks: blocks, media: media)
        }

        /// Splits the engine text into model blocks (one per paragraph).
        static func paragraphs(from text: String) -> [String] {
            text.components(separatedBy: "\n")
        }

        // MARK: - IME (spec §9.5)

        func textDidChange(_ notification: Notification) {
            guard let textView, !applyingExternal else { return }
            let marked = textView.hasMarkedText()
            if marked {
                if !compositionActive {
                    compositionActive = true
                    parent.onComposingChange(true)
                }
                // Keep watching: compositionend is not a commit by itself.
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
                if textView.hasMarkedText() {
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

        /// True while marked text exists (used by the ⌘S path).
        var isComposing: Bool {
            textView?.hasMarkedText() ?? false
        }

        // MARK: - Drag & drop

        func textView(
            _ textView: NSTextView,
            shouldChangeTextIn affectedCharRange: NSRange,
            replacementString: String?
        ) -> Bool {
            // Observation only: never block the engine's own editing, and never
            // let an external write land inside a marked range.
            true
        }
    }
}
