import Foundation

/// Shared document model (spec §8).
///
/// The wire format is one JSON object that every client encrypts whole. This
/// type is the Swift representation; it encodes exactly the same bytes as the
/// TypeScript model in `packages/protocol/src/document.ts` (fixed key order,
/// media keys sorted), which is what makes cross-platform decryption possible.
public enum DocumentLimits {
    public static let schemaVersion = 1
    public static let formatVersion = 1
    public static let keyVersion = 1
    public static let maxBlocks = 2_000
    public static let maxMedia = 200
    public static let maxDocumentJsonBytes = 1_048_576
    public static let maxUpdateRequestBytes = 2_097_152
}

public enum MediaKind: String, Codable, Sendable, CaseIterable {
    case image
    case video
    case audio
}

public struct TextBlock: Codable, Sendable, Equatable {
    public var id: String
    public var type = "text"
    public var text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }

    private enum CodingKeys: String, CodingKey { case id, type, text }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(String.self, forKey: .type)
        text = try container.decode(String.self, forKey: .text)
    }
}

public struct MediaBlock: Codable, Sendable, Equatable {
    public var id: String
    public var type = "media"
    public var mediaId: String

    public init(id: String, mediaId: String) {
        self.id = id
        self.mediaId = mediaId
    }

    private enum CodingKeys: String, CodingKey { case id, type, mediaId }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        type = try container.decode(String.self, forKey: .type)
        mediaId = try container.decode(String.self, forKey: .mediaId)
    }
}

public enum Block: Sendable, Equatable {
    case text(TextBlock)
    case media(MediaBlock)

    public var id: String {
        switch self {
        case .text(let block): block.id
        case .media(let block): block.id
        }
    }

    public var isMedia: Bool {
        if case .media = self { return true }
        return false
    }

    public var textContent: String? {
        if case .text(let block) = self { return block.text }
        return nil
    }

    public var mediaId: String? {
        if case .media(let block) = self { return block.mediaId }
        return nil
    }
}

public struct MediaInfo: Codable, Sendable, Equatable {
    public var kind: String
    public var name: String
    public var mime: String
    public var plainBytes: Int
    public var cryptoFormat: Int
    public var chunkBytes: Int
    public var chunkCount: Int
    public var noncePrefix: String
    public var fileKey: String

    public init(
        kind: String,
        name: String,
        mime: String,
        plainBytes: Int,
        cryptoFormat: Int = 1,
        chunkBytes: Int = TxtCrypto.chunkPlainBytes,
        chunkCount: Int? = nil,
        noncePrefix: String,
        fileKey: String
    ) {
        self.kind = kind
        self.name = name
        self.mime = mime
        self.plainBytes = plainBytes
        self.cryptoFormat = cryptoFormat
        self.chunkBytes = chunkBytes
        self.chunkCount = chunkCount ?? max(1, Int(ceil(Double(plainBytes) / Double(TxtCrypto.chunkPlainBytes))))
        self.noncePrefix = noncePrefix
        self.fileKey = fileKey
    }

    /// Fixed field order: the ciphertext must not change when nothing changed.
    private enum CodingKeys: String, CodingKey {
        case kind, name, mime, plainBytes, cryptoFormat, chunkBytes, chunkCount, noncePrefix, fileKey
    }
}

public struct DocumentModel: Sendable, Equatable {
    public var schemaVersion: Int
    public var blocks: [Block]
    public var media: [String: MediaInfo]

    public init(schemaVersion: Int = DocumentLimits.schemaVersion, blocks: [Block], media: [String: MediaInfo]) {
        self.schemaVersion = schemaVersion
        self.blocks = blocks
        self.media = media
    }

    public static func empty() -> DocumentModel {
        DocumentModel(blocks: [.text(TextBlock(id: UUID().uuidString.lowercased(), text: ""))], media: [:])
    }

    /// Media IDs referenced by blocks, sorted and unique (spec §8, §10.3).
    public var referencedMediaIds: [String] {
        var set = Set<String>()
        for block in blocks {
            if let mediaId = block.mediaId { set.insert(mediaId) }
        }
        return set.sorted()
    }

    /// Drops media entries no block references (the wire format forbids them).
    public func pruningUnreferencedMedia() -> DocumentModel {
        let referenced = Set(referencedMediaIds)
        let kept = media.filter { referenced.contains($0.key) }
        if kept.count == media.count { return self }
        return DocumentModel(schemaVersion: schemaVersion, blocks: blocks, media: kept)
    }
}

public struct DocumentRepair: Sendable {
    public var document: DocumentModel
    public var dropped: [String]
}

/// Recovers a stored document whose only defect is unreferenced media entries
/// (spec §8), mirroring `repairOrphanedMedia` in the TypeScript protocol.
///
/// Dropping such an entry loses nothing because no block points at it. Any
/// other problem returns nil: repairing unknown damage could destroy visible
/// content, so the caller must keep failing closed there.
public enum DocumentRepairer {
    static let orphanIssuePattern = #"^media\[".+"\]: entry is not referenced$"#

    public static func repair(_ document: DocumentModel) -> DocumentRepair? {
        let issues = DocumentCodec.validate(document)
        if issues.isEmpty { return DocumentRepair(document: document, dropped: []) }
        guard issues.allSatisfy({ issue in
            issue.range(of: orphanIssuePattern, options: .regularExpression) != nil
        }) else { return nil }

        let referenced = Set(document.referencedMediaIds)
        var media: [String: MediaInfo] = [:]
        var dropped: [String] = []
        for (key, info) in document.media {
            if referenced.contains(key) {
                media[key] = info
            } else {
                dropped.append(key)
            }
        }
        let repaired = DocumentModel(schemaVersion: document.schemaVersion, blocks: document.blocks, media: media)
        guard DocumentCodec.validate(repaired).isEmpty else { return nil }
        return DocumentRepair(document: repaired, dropped: dropped.sorted())
    }
}

// MARK: - Deterministic JSON (shared wire format)

public enum DocumentCodec {
    /// Stable JSON text: fixed key order, media keys sorted (spec §6.3).
    ///
    /// Emitted by hand rather than through `JSONSerialization` because the
    /// canonical order (schemaVersion, blocks, media; id, type, text|mediaId;
    /// the media fields in contract order) must match the TypeScript serializer
    /// byte for byte — both clients encrypt this string, and a shared fixture
    /// pins it from both sides.
    public static func serialize(_ document: DocumentModel) throws -> String {
        var out = #"{"schemaVersion":"# + String(document.schemaVersion) + #","blocks":["#
        for (index, block) in document.blocks.enumerated() {
            if index > 0 { out += "," }
            switch block {
            case .text(let text):
                out += #"{"id":"# + jsonString(text.id)
                out += #","type":"text","text":"# + jsonString(text.text) + "}"
            case .media(let media):
                out += #"{"id":"# + jsonString(media.id)
                out += #","type":"media","mediaId":"# + jsonString(media.mediaId) + "}"
            }
        }
        out += #"],"media":{"#
        for (index, key) in document.media.keys.sorted().enumerated() {
            guard let info = document.media[key] else { continue }
            if index > 0 { out += "," }
            out += jsonString(key) + #":{"kind":"# + jsonString(info.kind)
            out += #","name":"# + jsonString(info.name)
            out += #","mime":"# + jsonString(info.mime)
            out += #","plainBytes":"# + String(info.plainBytes)
            out += #","cryptoFormat":"# + String(info.cryptoFormat)
            out += #","chunkBytes":"# + String(info.chunkBytes)
            out += #","chunkCount":"# + String(info.chunkCount)
            out += #","noncePrefix":"# + jsonString(info.noncePrefix)
            out += #","fileKey":"# + jsonString(info.fileKey) + "}"
        }
        out += "}}"
        return out
    }

    /// JSON string literal with the same escaping `JSON.stringify` applies:
    /// quote, backslash, the short escapes, and \u00XX for other controls.
    /// Non-ASCII characters stay raw (the TypeScript side does not escape them).
    static func jsonString(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    public static func parse(_ data: [UInt8]) throws -> DocumentModel {
        let document = try parse(Data(data))
        let issues = validate(document)
        guard issues.isEmpty else {
            throw TxtError.validation(issues)
        }
        return document
    }

    public static func parse(_ data: Data) throws -> DocumentModel {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TxtError.decoding("document is not a JSON object")
        }
        guard let schemaVersion = root["schemaVersion"] as? Int else {
            throw TxtError.decoding("document: missing schemaVersion")
        }
        guard let rawBlocks = root["blocks"] as? [[String: Any]] else {
            throw TxtError.decoding("document: missing blocks")
        }
        var blocks: [Block] = []
        for raw in rawBlocks {
            guard let id = raw["id"] as? String, let type = raw["type"] as? String else {
                throw TxtError.decoding("block: missing id/type")
            }
            switch type {
            case "text":
                guard let text = raw["text"] as? String else {
                    throw TxtError.decoding("text block \(id): missing text")
                }
                blocks.append(.text(TextBlock(id: id, text: text)))
            case "media":
                guard let mediaId = raw["mediaId"] as? String else {
                    throw TxtError.decoding("media block \(id): missing mediaId")
                }
                blocks.append(.media(MediaBlock(id: id, mediaId: mediaId)))
            default:
                throw TxtError.decoding("block \(id): unsupported type \(type)")
            }
        }
        guard let rawMedia = root["media"] as? [String: Any] else {
            throw TxtError.decoding("document: missing media")
        }
        var media: [String: MediaInfo] = [:]
        for (key, value) in rawMedia {
            guard let info = value as? [String: Any],
                  let kind = info["kind"] as? String,
                  let name = info["name"] as? String,
                  let mime = info["mime"] as? String,
                  let plainBytes = info["plainBytes"] as? Int,
                  let cryptoFormat = info["cryptoFormat"] as? Int,
                  let chunkBytes = info["chunkBytes"] as? Int,
                  let chunkCount = info["chunkCount"] as? Int,
                  let noncePrefix = info["noncePrefix"] as? String,
                  let fileKey = info["fileKey"] as? String
            else {
                throw TxtError.decoding("media[\(key)]: malformed entry")
            }
            media[key] = MediaInfo(
                kind: kind,
                name: name,
                mime: mime,
                plainBytes: plainBytes,
                cryptoFormat: cryptoFormat,
                chunkBytes: chunkBytes,
                chunkCount: chunkCount,
                noncePrefix: noncePrefix,
                fileKey: fileKey
            )
        }
        return DocumentModel(schemaVersion: schemaVersion, blocks: blocks, media: media)
    }

    /// Human-readable problems; empty means valid (spec §8).
    ///
    /// The rule set matches `validateDocument` in the TypeScript protocol
    /// byte for byte, including which defects are *not* reported: a client must
    /// never reject a document another client accepted.
    public static func validate(_ document: DocumentModel) -> [String] {
        var issues: [String] = []
        if document.schemaVersion != DocumentLimits.schemaVersion {
            issues.append("schemaVersion: unsupported (\(document.schemaVersion))")
        }
        if document.blocks.count > DocumentLimits.maxBlocks {
            issues.append("blocks: too many (\(document.blocks.count))")
        }
        var seen = Set<String>()
        var lastValidType: String? = nil
        for (index, block) in document.blocks.enumerated() {
            if !isUuid(block.id) {
                issues.append("blocks[\(index)].id: not a UUID")
            } else if seen.contains(block.id) {
                issues.append("blocks[\(index)].id: duplicated")
            } else {
                seen.insert(block.id)
            }
            switch block {
            case .text(let text):
                // `String.contains("\r")` is unreliable here: Swift treats a
                // CR+LF pair as a single grapheme cluster, so a literal "\r\n"
                // in the text is *not* found by that call. Scanning the Unicode
                // scalars is the only correct check.
                if text.text.unicodeScalars.contains("\r") {
                    issues.append("blocks[\(index)].text: contains CR (newlines must be LF)")
                }
                lastValidType = "text"
            case .media(let media):
                if !isUuid(media.mediaId) {
                    issues.append("blocks[\(index)].mediaId: not a UUID")
                } else if document.media[media.mediaId] == nil {
                    issues.append("blocks[\(index)].mediaId: no such media entry")
                }
                if lastValidType != "text" {
                    issues.append("blocks[\(index)]: media needs an editable text block before it")
                }
                lastValidType = "media"
            }
        }
        if lastValidType == "media" {
            issues.append("blocks: media needs an editable text block after it")
        }
        if document.media.count > DocumentLimits.maxMedia {
            issues.append("media: too many entries (\(document.media.count))")
        }
        let referenced = Set(document.referencedMediaIds)
        for (key, info) in document.media {
            if !isUuid(key) {
                issues.append("media[\"\(key)\"]: key is not a UUID")
                continue
            }
            if !referenced.contains(key) {
                issues.append("media[\"\(key)\"]: entry is not referenced")
            }
            if !MediaKind.allCases.map(\.rawValue).contains(info.kind) {
                issues.append("media[\"\(key)\"].kind: unsupported")
            }
            if info.cryptoFormat != DocumentLimits.formatVersion {
                issues.append("media[\"\(key)\"].cryptoFormat: unsupported")
            }
            if info.chunkBytes != TxtCrypto.chunkPlainBytes {
                issues.append("media[\"\(key)\"].chunkBytes: unexpected chunk size")
            }
            let expectedChunks = max(1, Int(ceil(Double(info.plainBytes) / Double(TxtCrypto.chunkPlainBytes))))
            if info.chunkCount != expectedChunks {
                issues.append("media[\"\(key)\"].chunkCount: \(info.chunkCount) != \(expectedChunks)")
            }
            if (try? Base64Url.decode(info.noncePrefix))?.count != 8 {
                issues.append("media[\"\(key)\"].noncePrefix: not 8 bytes")
            }
            if (try? Base64Url.decode(info.fileKey))?.count != 32 {
                issues.append("media[\"\(key)\"].fileKey: not 32 bytes")
            }
        }
        return issues
    }
}
