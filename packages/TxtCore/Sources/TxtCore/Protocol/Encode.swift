import Foundation

/// Binary encoding primitives (spec §6.3).
///
/// `encode` prefixes each field's bytes with a uint32 big-endian length and
/// concatenates them. Strings are UTF-8, UUIDs are 16 bytes, credential IDs are
/// raw bytes, integers are uint64 big-endian.
///
/// This must produce byte-identical output to the TypeScript implementation in
/// `packages/protocol/src/encode.ts`; the shared test vectors compare both.
public enum Encode {
    public enum Field {
        case string(String)
        case bytes([UInt8])
        case uint(UInt64)
    }

    /// `Encode(fields...)`: uint32 big-endian length || bytes, concatenated.
    public static func fields(_ fields: [Field]) -> [UInt8] {
        var out: [UInt8] = []
        for field in fields {
            let bytes: [UInt8]
            switch field {
            case .string(let value):
                bytes = Array(value.utf8)
            case .bytes(let raw):
                bytes = raw
            case .uint(let value):
                bytes = bigEndianUInt64(value)
            }
            precondition(bytes.count <= Int(UInt32.max), "Encode: field longer than uint32")
            out.append(contentsOf: bigEndianUInt32(UInt32(bytes.count)))
            out.append(contentsOf: bytes)
        }
        return out
    }

    public static func callAsFunction(_ fields: Field...) -> [UInt8] {
        self.fields(fields)
    }

    public static func bigEndianUInt32(_ value: UInt32) -> [UInt8] {
        [
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff),
        ]
    }

    public static func bigEndianUInt64(_ value: UInt64) -> [UInt8] {
        var out: [UInt8] = []
        for shift in stride(from: 56, through: 0, by: -8) {
            out.append(UInt8((value >> UInt64(shift)) & 0xff))
        }
        return out
    }
}

/// UUID hyphenated form -> 16 raw bytes (spec §6.3).
public func uuidToBytes(_ uuid: String) throws -> [UInt8] {
    let hex = uuid.replacingOccurrences(of: "-", with: "")
    guard hex.count == 32, hex.allSatisfy({ $0.isHexDigit }) else {
        throw TxtError.invalidIdentifier("not a UUID: \(uuid)")
    }
    var out: [UInt8] = []
    out.reserveCapacity(16)
    var index = hex.startIndex
    for _ in 0..<16 {
        let next = hex.index(index, offsetBy: 2)
        guard let byte = UInt8(hex[index..<next], radix: 16) else {
            throw TxtError.invalidIdentifier("not a UUID: \(uuid)")
        }
        out.append(byte)
        index = next
    }
    return out
}

/// 16 raw bytes -> UUID hyphenated form (lowercase).
public func bytesToUuid(_ bytes: [UInt8]) throws -> String {
    guard bytes.count == 16 else {
        throw TxtError.invalidIdentifier("uuid needs 16 bytes, got \(bytes.count)")
    }
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    let parts = [
        hex.prefix(8),
        hex.dropFirst(8).prefix(4),
        hex.dropFirst(12).prefix(4),
        hex.dropFirst(16).prefix(4),
        hex.dropFirst(20).prefix(12),
    ]
    return parts.map(String.init).joined(separator: "-")
}

public func isUuid(_ value: String) -> Bool {
    let hex = value.replacingOccurrences(of: "-", with: "")
    return hex.count == 32 && hex.allSatisfy { $0.isHexDigit }
}

public enum TxtError: Error, Equatable {
    case invalidIdentifier(String)
    case invalidBase64Url(String)
    case crypto(String)
    case decoding(String)
    case network(String)
    case api(status: Int, code: String, message: String)
    case validation([String])
    case locked
    case unsafePoint
}
