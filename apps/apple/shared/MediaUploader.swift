import Foundation
import TxtCore

/// Media upload pipeline (spec §11.2, §11.3, §11.4).
///
/// Encrypts one chunk at a time, uploads bounded parts (8 chunks per part), and
/// never buffers a whole 512MiB file. The result carries the full media record,
/// because the document dictionary must describe the file with the same key
/// material that encrypted it — handing back only an ID would leave the block
/// pointing at a file nobody can decrypt.
enum MediaUploader {
    enum UploadError: Error, LocalizedError {
        case unsupportedType(String)
        case tooLarge(String)
        case missingFile
        case uploadFailed(String)

        var errorDescription: String? {
            switch self {
            case .unsupportedType(let name): "この形式のファイルは添付できません: \(name)"
            case .tooLarge(let name): "このファイルは大きすぎます: \(name)"
            case .missingFile: "ファイルを読み込めませんでした。"
            case .uploadFailed(let message): message
            }
        }
    }

    /// A completed upload: everything the document needs to reference it.
    struct UploadedMedia: Sendable {
        var mediaId: String
        var info: MediaInfo
    }

    /// Kind limits (spec §11.1).
    static func classify(url: URL) throws -> (kind: String, mime: String, limit: Int) {
        let ext = url.pathExtension.lowercased()
        let images = ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif"]
        let videos = ["mp4", "webm", "mov"]
        let audios = ["mp3", "m4a", "aac", "wav", "ogg", "flac"]
        if images.contains(ext) {
            let mime = ext == "jpg" ? "image/jpeg" : "image/\(ext == "jpeg" ? "jpeg" : ext)"
            return ("image", mime, 20 * 1024 * 1024)
        }
        if videos.contains(ext) {
            return ("video", "video/\(ext == "mov" ? "quicktime" : ext)", 512 * 1024 * 1024)
        }
        if audios.contains(ext) {
            let mime = ext == "mp3" ? "audio/mpeg" : "audio/\(ext == "ogg" ? "ogg" : ext)"
            return ("audio", mime, 100 * 1024 * 1024)
        }
        throw UploadError.unsupportedType(url.lastPathComponent)
    }

    /// Encrypts and uploads one file.
    ///
    /// The request fields are exactly what the Worker requires (§11.2):
    /// `clientUploadId` (idempotency), `cipherBytes`, `cryptoFormat` and
    /// `chunkBytes` (the ciphertext chunk size, not the plaintext one). The
    /// part layout is derived by the server, so it is not sent.
    static func upload(
        url: URL,
        documentId: String,
        api: ApiClient,
        bridge: CryptoBridge,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> UploadedMedia {
        let (kind, mime, limit) = try classify(url: url)
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            throw UploadError.missingFile
        }
        defer { try? handle.close() }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        guard size > 0 else { throw UploadError.missingFile }
        guard size <= limit else { throw UploadError.tooLarge(url.lastPathComponent) }

        let chunkPlain = TxtCrypto.chunkPlainBytes
        let chunkCount = max(1, Int(ceil(Double(size) / Double(chunkPlain))))
        let noncePrefix = TxtCrypto.randomBytes(8)
        let fileKey = TxtCrypto.randomBytes(TxtCrypto.keyBytes)
        let cipherBytes = size + chunkCount * TxtCrypto.tagBytes
        let clientUploadId = UUID().uuidString.lowercased()

        let start = try await api.startUpload(ApiClient.StartUploadPayload(
            clientUploadId: clientUploadId,
            cipherBytes: cipherBytes,
            cryptoFormat: DocumentLimits.formatVersion,
            chunkBytes: TxtCrypto.chunkCipherBytes
        ))
        let mediaId = start.mediaId

        // The server decides the part layout; follow what it reports so a
        // change on the Worker side cannot silently corrupt an upload.
        let chunksPerPart = max(1, Int(ceil(Double(start.partBytes) / Double(TxtCrypto.chunkCipherBytes))))

        var chunkIndex = 0
        var partNumber = 1
        var partBuffer = Data()
        var uploaded = 0

        while chunkIndex < chunkCount {
            let plainLength = min(chunkPlain, size - chunkIndex * chunkPlain)
            let plain = try handle.read(upToCount: plainLength) ?? Data()
            let cipher = try await bridge.encryptChunk(
                plaintext: [UInt8](plain),
                fileKey: fileKey,
                noncePrefix: noncePrefix,
                cryptoFormat: DocumentLimits.formatVersion,
                totalPlainBytes: size,
                index: chunkIndex,
                mediaId: mediaId
            )
            partBuffer.append(contentsOf: cipher)
            uploaded += plain.count
            chunkIndex += 1
            onProgress(Double(uploaded) / Double(size))

            let isLastChunk = chunkIndex == chunkCount
            let partFull = chunkIndex % chunksPerPart == 0
            if partFull || isLastChunk {
                try await api.uploadPart(mediaId: mediaId, partNumber: partNumber, bytes: [UInt8](partBuffer))
                partBuffer.removeAll(keepingCapacity: true)
                partNumber += 1
            }
        }

        _ = try await api.completeUpload(mediaId: mediaId)
        onProgress(1)

        // The dictionary entry must describe the file exactly as encrypted: the
        // key material and nonce prefix are only known here, so they travel back
        // with the ID (spec §8).
        let info = MediaInfo(
            kind: kind,
            name: url.lastPathComponent,
            mime: mime,
            plainBytes: size,
            cryptoFormat: DocumentLimits.formatVersion,
            chunkBytes: chunkPlain,
            chunkCount: chunkCount,
            noncePrefix: Base64Url.encode(noncePrefix),
            fileKey: Base64Url.encode(fileKey)
        )
        return UploadedMedia(mediaId: mediaId, info: info)
    }
}
