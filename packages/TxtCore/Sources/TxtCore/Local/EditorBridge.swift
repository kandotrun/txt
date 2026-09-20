import Foundation
import TxtCore

/// Mapping between the shared document model and the editor's plain text
/// (spec §8, §4.4).
///
/// Kept as pure functions so the round-trip rules are unit-tested instead of
/// being re-derived on every keystroke: the engine's text holds one paragraph
/// per block, media blocks appear as U+FFFC, and block IDs survive text edits
/// wherever the paragraph count allows it.
public enum EditorBridge {
    /// The object replacement character; what an attachment occupies in the
    /// engine's text. Never produced by ordinary typing.
    public static let attachmentPlaceholder: Character = "\u{FFFC}"

    /// Renders a document as the editor's plain text.
    public static func plainText(for document: DocumentModel) -> String {
        var parts: [String] = []
        for block in document.blocks {
            switch block {
            case .text(let text): parts.append(text.text)
            case .media: parts.append(String(attachmentPlaceholder))
            }
        }
        return parts.joined(separator: "\n")
    }

    /// Splits the editor's text back into one string per block.
    public static func paragraphTexts(from text: String) -> [String] {
        text.components(separatedBy: "\n")
    }

    /// Rebuilds the model from the editor's text, carrying IDs and media over.
    ///
    /// - Existing block IDs are reused positionally while the paragraph count is
    ///   unchanged, so ordinary typing never regenerates an ID (spec §8).
    /// - A new paragraph receives a fresh ID; a removed one simply disappears
    ///   from the model, which is what the user sees.
    /// - Media placeholders keep their `mediaId`; a media block that survived
    ///   keeps both its block ID and its entry in the media dictionary.
    public static func document(
        fromText text: String,
        previous: DocumentModel,
        mediaProvider: (String) -> MediaInfo?
    ) -> DocumentModel {
        let paragraphs = paragraphTexts(from: text)
        var blocks: [Block] = []
        blocks.reserveCapacity(paragraphs.count)

        // Positional ID/media reuse, but only when the counts line up: a pure
        // insertion at the front would otherwise shift every ID by one and
        // regenerate the whole document (spec §8 forbids that).
        let reusePositionally = paragraphs.count == previous.blocks.count

        for (index, paragraph) in paragraphs.enumerated() {
            let previousBlock = reusePositionally && index < previous.blocks.count
                ? previous.blocks[index]
                : nil
            let id = previousBlock?.id ?? UUID().uuidString.lowercased()

            if paragraph == String(attachmentPlaceholder) {
                if let mediaId = previousBlock?.mediaId {
                    blocks.append(.media(MediaBlock(id: id, mediaId: mediaId)))
                    continue
                }
                // A placeholder without a known media block is not a document
                // the wire format allows; treat it as text so nothing is lost.
                blocks.append(.text(TextBlock(id: id, text: paragraph)))
                continue
            }

            // An attachment that the user deleted or replaced disappears with
            // its placeholder; a text block keeps the text as typed.
            blocks.append(.text(TextBlock(id: id, text: paragraph)))
        }

        if blocks.isEmpty {
            blocks = [.text(TextBlock(id: UUID().uuidString.lowercased(), text: ""))]
        }

        // The media dictionary holds exactly the referenced entries
        // (spec §8): anything the user removed is dropped here, not later.
        var media: [String: MediaInfo] = [:]
        for block in blocks {
            guard let mediaId = block.mediaId else { continue }
            if let info = mediaProvider(mediaId) {
                media[mediaId] = info
            } else if let info = previous.media[mediaId] {
                media[mediaId] = info
            }
        }
        return DocumentModel(blocks: blocks, media: media)
    }

    /// Inserts a media block at the caret, splitting the text block there
    /// (spec §8). The left part keeps its ID; the right part gets a new one.
    public static func insertMedia(
        _ document: DocumentModel,
        mediaId: String,
        blockIndex: Int,
        offset: Int
    ) -> DocumentModel {
        var blocks = document.blocks
        let index = max(0, min(blockIndex, blocks.count == 0 ? 0 : blocks.count - 1))
        guard index < blocks.count, case .text(let target) = blocks[index] else {
            // Not inside a text block: insert with the surrounding repair.
            return insertMediaAtBoundary(document, mediaId: mediaId, position: blocks.count)
        }
        let text = target.text
        let characters = Array(text)
        let clamped = max(0, min(offset, characters.count))
        if clamped == 0 {
            return insertMediaAtBoundary(document, mediaId: mediaId, position: index)
        }
        if clamped == characters.count {
            return insertMediaAtBoundary(document, mediaId: mediaId, position: index + 1)
        }
        let left = TextBlock(id: target.id, text: String(characters[0..<clamped]))
        let right = TextBlock(id: UUID().uuidString.lowercased(), text: String(characters[clamped...]))
        let media = MediaBlock(id: UUID().uuidString.lowercased(), mediaId: mediaId)
        blocks.replaceSubrange(index...index, with: [.text(left), .media(media), .text(right)])
        return DocumentModel(schemaVersion: document.schemaVersion, blocks: blocks, media: document.media)
    }

    /// Inserts at a block boundary, repairing the neighbours so the wire format
    /// invariant (an editable text block on both sides) holds.
    public static func insertMediaAtBoundary(
        _ document: DocumentModel,
        mediaId: String,
        position: Int
    ) -> DocumentModel {
        var blocks = document.blocks
        let clamped = max(0, min(position, blocks.count))
        let media = MediaBlock(id: UUID().uuidString.lowercased(), mediaId: mediaId)
        blocks.insert(.media(media), at: clamped)
        var mediaIndex = clamped
        if mediaIndex == 0 || blocks[mediaIndex - 1].isMedia == true {
            blocks.insert(.text(TextBlock(id: UUID().uuidString.lowercased(), text: "")), at: mediaIndex)
            mediaIndex += 1
        }
        if mediaIndex == blocks.count - 1 || blocks[mediaIndex + 1].isMedia == true {
            blocks.insert(.text(TextBlock(id: UUID().uuidString.lowercased(), text: "")), at: mediaIndex + 1)
        }
        return DocumentModel(schemaVersion: document.schemaVersion, blocks: blocks, media: document.media)
    }
}
