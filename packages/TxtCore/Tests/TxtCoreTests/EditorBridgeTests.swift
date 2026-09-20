import Foundation
import Testing

@testable import TxtCore

/// Editor bridge (spec §8, §4.4).
///
/// The mapping between the engine's plain text and the wire model is where
/// silent data loss happens (IDs regenerated, media orphaned, blank lines
/// collapsed), so it is a pure function under test rather than inline logic.
struct EditorBridgeTests {
    static let mediaId = "33333333-3333-4333-8333-333333333333"
    static let mediaId2 = "55555555-5555-4555-8555-555555555555"
    static let textId = "11111111-1111-4111-8111-111111111111"
    static let textId2 = "22222222-2222-4222-8222-222222222222"
    static let textId3 = "44444444-4444-4444-8444-444444444444"

    static func mediaInfo() -> MediaInfo {
        MediaInfo(
            kind: "image",
            name: "photo.png",
            mime: "image/png",
            plainBytes: 1024,
            noncePrefix: "AAAAAAAAAAA",
            fileKey: String(repeating: "A", count: 43)
        )
    }

    static func document() -> DocumentModel {
        DocumentModel(
            blocks: [
                .text(TextBlock(id: textId, text: "前。")),
                .media(MediaBlock(id: "66666666-6666-4666-8666-666666666666", mediaId: mediaId)),
                .text(TextBlock(id: textId2, text: "後。")),
            ],
            media: [mediaId: mediaInfo()]
        )
    }

    // MARK: - Text rendering

    @Test func rendersOneParagraphPerBlockWithAttachmentPlaceholder() {
        let text = EditorBridge.plainText(for: Self.document())
        #expect(text == "前。\n\u{FFFC}\n後。")
    }

    @Test func rendersEmptyDocumentAsASingleEmptyParagraph() {
        #expect(EditorBridge.plainText(for: DocumentModel.empty()) == "")
    }

    // MARK: - Round trip

    @Test func roundTripsTextAndMediaWithoutRegeneratingIds() {
        let original = Self.document()
        let text = EditorBridge.plainText(for: original)
        let rebuilt = EditorBridge.document(
            fromText: text,
            previous: original,
            mediaProvider: { $0 == Self.mediaId ? Self.mediaInfo() : nil }
        )
        #expect(rebuilt.blocks.map(\.id) == original.blocks.map(\.id))
        #expect(rebuilt.blocks[1].mediaId == Self.mediaId)
        #expect(rebuilt.media.keys.sorted() == [Self.mediaId])
    }

    @Test func preservesLineFeedsBlankLinesAndEmoji() {
        // LF is a literal character inside a block, so blank lines survive.
        let body = "1行目\n\n3行目🐕‍🦺"
        let original = DocumentModel(
            blocks: [.text(TextBlock(id: Self.textId, text: body))],
            media: [:]
        )
        let text = EditorBridge.plainText(for: original)
        #expect(text == body, "a single block renders without an extra separator")
        let rebuilt = EditorBridge.document(fromText: text, previous: original, mediaProvider: { _ in nil })
        #expect(rebuilt.blocks.count == 3, "internal newlines split into blocks")
        #expect(rebuilt.blocks.map { $0.textContent ?? "" }.joined(separator: "\n") == body)
    }

    @Test func typingKeepsIdsWhenParagraphCountIsStable() {
        let original = DocumentModel(
            blocks: [
                .text(TextBlock(id: Self.textId, text: "あ")),
                .text(TextBlock(id: Self.textId2, text: "い")),
            ],
            media: [:]
        )
        let rebuilt = EditorBridge.document(fromText: "あx\nい", previous: original, mediaProvider: { _ in nil })
        #expect(rebuilt.blocks[0].id == Self.textId, "typing must not regenerate the block ID")
        #expect(rebuilt.blocks[1].id == Self.textId2)
        #expect(rebuilt.blocks[0].textContent == "あx")
    }

    @Test func newParagraphGetsAFreshIdAndKeepsTheOthers() {
        let original = DocumentModel(
            blocks: [.text(TextBlock(id: Self.textId, text: "あ"))],
            media: [:]
        )
        let rebuilt = EditorBridge.document(fromText: "あ\nい", previous: original, mediaProvider: { _ in nil })
        #expect(rebuilt.blocks.count == 2)
        #expect(rebuilt.blocks[1].id != Self.textId)
        #expect(rebuilt.blocks[0].id != rebuilt.blocks[1].id)
    }

    @Test func deletingAnAttachmentPlaceholderDropsItsMediaEntry() {
        let original = Self.document()
        // The user removed the media line entirely.
        let rebuilt = EditorBridge.document(
            fromText: "前。\n後。",
            previous: original,
            mediaProvider: { _ in Self.mediaInfo() }
        )
        #expect(rebuilt.media.isEmpty, "the dictionary must not keep an unreferenced entry")
        #expect(DocumentCodec.validate(rebuilt).isEmpty)
        #expect(rebuilt.blocks.count == 2)
    }

    @Test func documentWithMediaIsValidForTheWireFormat() {
        let rebuilt = EditorBridge.document(
            fromText: EditorBridge.plainText(for: Self.document()),
            previous: Self.document(),
            mediaProvider: { _ in Self.mediaInfo() }
        )
        #expect(DocumentCodec.validate(rebuilt).isEmpty)
    }

    // MARK: - Insertion

    @Test func insertMediaSplitsTheTextAtTheCaret() {
        let original = DocumentModel(
            blocks: [.text(TextBlock(id: Self.textId, text: "あいうえお"))],
            media: [:]
        )
        let inserted = EditorBridge.insertMedia(original, mediaId: Self.mediaId, blockIndex: 0, offset: 2)
        #expect(inserted.blocks.count == 3)
        #expect(inserted.blocks[0].textContent == "あい")
        #expect(inserted.blocks[0].id == Self.textId, "the left part keeps its ID")
        #expect(inserted.blocks[1].mediaId == Self.mediaId)
        #expect(inserted.blocks[2].textContent == "うえお")
        #expect(inserted.blocks[2].id != Self.textId)
        #expect(DocumentCodec.validate(inserted.pruningUnreferencedMedia()).isEmpty == false)
    }

    @Test func insertMediaAtTheStartKeepsALeadingTextBlock() {
        let original = DocumentModel(
            blocks: [.text(TextBlock(id: Self.textId, text: "本文"))],
            media: [:]
        )
        let inserted = EditorBridge.insertMedia(original, mediaId: Self.mediaId, blockIndex: 0, offset: 0)
        #expect(inserted.blocks[0].isMedia == false, "an editable text block must lead (spec §8)")
        #expect(inserted.blocks[1].mediaId == Self.mediaId)
    }

    @Test func insertMediaAtTheEndKeepsATrailingTextBlock() {
        let original = DocumentModel(
            blocks: [.text(TextBlock(id: Self.textId, text: "本文"))],
            media: [:]
        )
        let inserted = EditorBridge.insertMedia(original, mediaId: Self.mediaId, blockIndex: 0, offset: 2)
        #expect(inserted.blocks.last?.isMedia == false)
    }

    @Test func insertMediaBetweenTwoAttachmentsRepairsTheGap() {
        var document = Self.document()
        document.media[Self.mediaId2] = Self.mediaInfo()
        let inserted = EditorBridge.insertMediaAtBoundary(document, mediaId: Self.mediaId2, position: 1)
        // text, media, media -> the repair inserts a text block between them.
        let types = inserted.blocks.map { $0.isMedia ? "media" : "text" }
        #expect(types.contains("media"))
        #expect(types.first == "text")
        #expect(types.last == "text")
        for index in 1..<types.count {
            if types[index] == "media" && types[index - 1] == "media" { Issue.record("adjacent media") }
        }
    }
}
