import Foundation

/// Padding-free base64url (spec §6.3).
///
/// The wire format never uses `+`, `/` or `=`; this matches the TypeScript
/// implementation byte for byte.
public enum Base64Url {
    public static func encode(_ bytes: [UInt8]) -> String {
        var text = Data(bytes).base64EncodedString()
        text = text.replacingOccurrences(of: "+", with: "-")
        text = text.replacingOccurrences(of: "/", with: "_")
        text = text.replacingOccurrences(of: "=", with: "")
        return text
    }

    public static func decode(_ text: String) throws -> [UInt8] {
        guard !text.contains("+"), !text.contains("/"), !text.contains("=") else {
            throw TxtError.invalidBase64Url(text)
        }
        var padded = text.replacingOccurrences(of: "-", with: "+")
        padded = padded.replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded.append("=") }
        guard let data = Data(base64Encoded: padded) else {
            throw TxtError.invalidBase64Url(text)
        }
        return [UInt8](data)
    }
}
