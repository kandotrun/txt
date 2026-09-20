import Foundation
import Testing

@testable import TxtCore

/// Document model and codec (spec §8).
///
/// The critical property is that the Swift encoder emits the same JSON the
/// TypeScript client writes: the whole document is encrypted as one blob, so a
/// byte difference in key order is a cross-platform read failure.
struct DocumentTests {
    static let mediaId = "33333333-3333-4333-8333-333333333333"

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

    static func documentWithMedia() -> DocumentModel {
        DocumentModel(
            blocks: [
                .text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: "前。")),
                .media(MediaBlock(id: "22222222-2222-4222-8222-222222222222", mediaId: mediaId)),
                .text(TextBlock(id: "44444444-4444-4444-8444-444444444444", text: "")),
            ],
            media: [mediaId: mediaInfo()]
        )
    }

    @Test func emptyDocumentIsOneEmptyTextBlock() {
        let document = DocumentModel.empty()
        #expect(document.blocks.count == 1)
        #expect(document.blocks[0].textContent == "")
        #expect(DocumentCodec.validate(document).isEmpty)
    }

    @Test func roundTripsThroughJSON() throws {
        let document = Self.documentWithMedia()
        let json = try DocumentCodec.serialize(document)
        let parsed = try DocumentCodec.parse([UInt8](json.utf8))
        #expect(parsed == document)
    }

    @Test func serializedJsonMatchesTheTypeScriptShape() throws {
        // Byte-identical to `serializeDocument` in the TypeScript protocol:
        // schemaVersion, blocks, media; id, type, text|mediaId; the media fields
        // in contract order, media keys sorted.
        let document = Self.documentWithMedia()
        let json = try DocumentCodec.serialize(document)
        let expected = "{\"schemaVersion\":1,\"blocks\":[{\"id\":\"11111111-1111-4111-8111-111111111111\",\"type\":\"text\",\"text\":\"前。\"},{\"id\":\"22222222-2222-4222-8222-222222222222\",\"type\":\"media\",\"mediaId\":\"33333333-3333-4333-8333-333333333333\"},{\"id\":\"44444444-4444-4444-8444-444444444444\",\"type\":\"text\",\"text\":\"\"}],\"media\":{\"33333333-3333-4333-8333-333333333333\":{\"kind\":\"image\",\"name\":\"photo.png\",\"mime\":\"image/png\",\"plainBytes\":1024,\"cryptoFormat\":1,\"chunkBytes\":1048576,\"chunkCount\":1,\"noncePrefix\":\"AAAAAAAAAAA\",\"fileKey\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}}}"
        #expect(json == expected, "Swift JSON must match the TypeScript serializer byte for byte")
    }

    @Test func preservesLineFeedsTabsAndEmoji() throws {
        let text = "行1\n\n行3\t全角　🐕‍🦺\n"
        let document = DocumentModel(
            blocks: [.text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: text))],
            media: [:]
        )
        let json = try DocumentCodec.serialize(document)
        let parsed = try DocumentCodec.parse([UInt8](json.utf8))
        #expect(parsed.blocks[0].textContent == text)
    }

    @Test func rejectsMediaWithoutSurroundingText() {
        let document = DocumentModel(
            blocks: [.media(MediaBlock(id: "22222222-2222-4222-8222-222222222222", mediaId: Self.mediaId))],
            media: [Self.mediaId: Self.mediaInfo()]
        )
        let issues = DocumentCodec.validate(document)
        #expect(issues.contains { $0.contains("before") })
        #expect(issues.contains { $0.contains("after") })
    }

    @Test func rejectsCRInText() {
        let document = DocumentModel(
            blocks: [.text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: "a\r\nb"))],
            media: [:]
        )
        #expect(DocumentCodec.validate(document).contains { $0.contains("CR") })
        // A lone CR must be caught as well, not only the CR+LF pair.
        let loneCr = DocumentModel(
            blocks: [.text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: "a\rb"))],
            media: [:]
        )
        #expect(DocumentCodec.validate(loneCr).contains { $0.contains("CR") })
    }

    @Test func rejectsUnreferencedMediaAndMissingEntries() {
        let withOrphan = DocumentModel(
            blocks: [.text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: ""))],
            media: [Self.mediaId: Self.mediaInfo()]
        )
        #expect(DocumentCodec.validate(withOrphan).contains { $0.contains("not referenced") })

        let withMissing = DocumentModel(
            blocks: [
                .text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: "")),
                .media(MediaBlock(id: "22222222-2222-4222-8222-222222222222", mediaId: "55555555-5555-4555-8555-555555555555")),
                .text(TextBlock(id: "44444444-4444-4444-8444-444444444444", text: "")),
            ],
            media: [:]
        )
        #expect(DocumentCodec.validate(withMissing).contains { $0.contains("no such media entry") })
    }

    @Test func prunesUnreferencedMedia() {
        let document = DocumentModel(
            blocks: [.text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: ""))],
            media: [Self.mediaId: Self.mediaInfo()]
        )
        let pruned = document.pruningUnreferencedMedia()
        #expect(pruned.media.isEmpty)
        #expect(DocumentCodec.validate(pruned).isEmpty)
    }

    @Test func repairsAnOrphanOnlyDocument() throws {
        // The orphan is the only defect: the referenced entry stays, so the
        // visible content survives untouched.
        let orphanId = "66666666-6666-4666-8666-666666666666"
        let document = DocumentModel(
            blocks: [
                .text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: "")),
                .media(MediaBlock(id: "22222222-2222-4222-8222-222222222222", mediaId: Self.mediaId)),
                .text(TextBlock(id: "44444444-4444-4444-8444-444444444444", text: "")),
            ],
            media: [
                Self.mediaId: Self.mediaInfo(),
                orphanId: Self.mediaInfo(),
            ]
        )
        let repaired = DocumentRepairer.repair(document)
        #expect(repaired != nil)
        #expect(repaired?.dropped == [orphanId])
        #expect(repaired?.document.media.keys.sorted() == [Self.mediaId])
        #expect(repaired?.document.blocks.count == 3, "visible content must be untouched")
        #expect(DocumentCodec.validate(repaired!.document).isEmpty)

        // When the surviving entry is itself unreferenced, both are dropped —
        // there is nothing to keep.
        let bothOrphaned = DocumentModel(
            blocks: [.text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: "本文"))],
            media: [
                Self.mediaId: Self.mediaInfo(),
                orphanId: Self.mediaInfo(),
            ]
        )
        let repairedBoth = DocumentRepairer.repair(bothOrphaned)
        #expect(repairedBoth?.document.media.isEmpty == true)
        #expect(repairedBoth?.document.blocks[0].textContent == "本文")
    }

    @Test func repairRefusesOtherDamage() {
        let missingEntry = DocumentModel(
            blocks: [
                .text(TextBlock(id: "11111111-1111-4111-8111-111111111111", text: "")),
                .media(MediaBlock(id: "22222222-2222-4222-8222-222222222222", mediaId: "55555555-5555-4555-8555-555555555555")),
                .text(TextBlock(id: "44444444-4444-4444-8444-444444444444", text: "")),
            ],
            media: [:]
        )
        #expect(DocumentRepairer.repair(missingEntry) == nil)
    }

    @Test func parsesADocumentWrittenByAnotherClient() throws {
        // Exact bytes the Web client produces for a repaired document.
        let json = """
        {"schemaVersion":1,"blocks":[{"id":"11111111-1111-4111-8111-111111111111","type":"text","text":"ああ"},{"id":"22222222-2222-4222-8222-222222222222","type":"media","mediaId":"33333333-3333-4333-8333-333333333333"},{"id":"44444444-4444-4444-8444-444444444444","type":"text","text":""}],"media":{"33333333-3333-4333-8333-333333333333":{"kind":"image","name":"a.png","mime":"image/png","plainBytes":10,"cryptoFormat":1,"chunkBytes":1048576,"chunkCount":1,"noncePrefix":"AAAAAAAAAAA","fileKey":"\(String(repeating: "A", count: 43))"}}}
        """
        let parsed = try DocumentCodec.parse([UInt8](json.utf8))
        #expect(parsed.blocks.count == 3)
        #expect(parsed.blocks[0].textContent == "ああ")
        #expect(parsed.media.keys.sorted() == ["33333333-3333-4333-8333-333333333333"])
    }
}
