import AVFoundation
import Foundation
import TxtCore
import UniformTypeIdentifiers

/// Decrypted media playback (spec §11.7).
///
/// `AVAssetResourceLoaderDelegate` intercepts the player's Range requests on a
/// custom scheme and answers them with chunks fetched from the cipher endpoint
/// and decrypted locally. Plaintext never touches disk, and the cache is
/// bounded so seeking does not accumulate memory.
///
/// The chunk cache is an `actor` rather than a lock: Swift 6 forbids `NSLock`
/// in asynchronous contexts, and an actor also serializes the in-flight fetch
/// deduplication.
actor ChunkCache {
    private var cache: [Int: [UInt8]] = [:]
    private var inFlight: [Int: Task<[UInt8], Error>] = [:]
    /// How many chunks to keep: enough for the player's read-ahead, far below a
    /// whole-file buffer (§11.7).
    private let window = 4

    func plaintext(at index: Int, loader: @escaping @Sendable (Int) async throws -> [UInt8]) async throws -> [UInt8] {
        if let cached = cache[index] { return cached }
        if let running = inFlight[index] { return try await running.value }

        let task = Task { try await loader(index) }
        inFlight[index] = task
        defer { inFlight[index] = nil }
        let value = try await task.value
        cache[index] = value
        if cache.count > window {
            // Drop the entry furthest from the current index.
            if let furthest = cache.keys.min(by: { abs($0 - index) > abs($1 - index) }) {
                cache.removeValue(forKey: furthest)
            }
        }
        return value
    }

    func clear() {
        cache.removeAll()
        for (_, task) in inFlight { task.cancel() }
        inFlight.removeAll()
    }
}

/// Serves decrypted ranges to AVFoundation.
final class EncryptedResourceLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    private static let scheme = "txt-cipher"

    private let mediaId: String
    private let info: MediaInfo
    private let fileKey: [UInt8]
    private let noncePrefix: [UInt8]
    private let api: ApiClient
    private let bridge: CryptoBridge
    private let chunks = ChunkCache()

    init(mediaId: String, info: MediaInfo, api: ApiClient, bridge: CryptoBridge) throws {
        self.mediaId = mediaId
        self.info = info
        self.api = api
        self.bridge = bridge
        self.fileKey = try Base64Url.decode(info.fileKey)
        self.noncePrefix = try Base64Url.decode(info.noncePrefix)
        super.init()
    }

    /// A URL AVPlayer can load; the delegate answers it.
    func makeURL() -> URL? {
        URL(string: "\(Self.scheme)://media/\(mediaId)")
    }

    /// Only audio/video benefit from the range loader (images use the small-blob
    /// path in the media view).
    static func isPlayable(_ info: MediaInfo) -> Bool {
        info.kind == "video" || info.kind == "audio"
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.fulfill(loadingRequest)
            } catch {
                loadingRequest.finishLoading(with: error)
            }
        }
        return true
    }

    func stop() {
        Task { await chunks.clear() }
    }

    private func fulfill(_ request: AVAssetResourceLoadingRequest) async throws {
        guard let dataRequest = request.dataRequest else {
            request.finishLoading()
            return
        }
        if let contentInfo = request.contentInformationRequest {
            contentInfo.contentType = info.mime
            contentInfo.contentLength = Int64(info.plainBytes)
            contentInfo.isByteRangeAccessSupported = true
        }
        let start = Int(dataRequest.requestedOffset)
        let end = min(start + dataRequest.requestedLength - 1, info.plainBytes - 1)
        guard start <= end else {
            request.finishLoading()
            return
        }
        let plaintext = try await plainSlice(start: start, end: end)
        dataRequest.respond(with: Data(plaintext))
        request.finishLoading()
    }

    /// Decrypts the requested plaintext slice, fetching only the chunks it spans.
    private func plainSlice(start: Int, end: Int) async throws -> [UInt8] {
        let chunkPlain = TxtCrypto.chunkPlainBytes
        let firstChunk = start / chunkPlain
        let lastChunk = end / chunkPlain
        var out = [UInt8](repeating: 0, count: end - start + 1)
        var offset = 0
        for index in firstChunk...lastChunk {
            let chunk = try await chunkPlaintext(index)
            let chunkStart = index * chunkPlain
            let sliceStart = max(start, chunkStart) - chunkStart
            let sliceEnd = min(end, chunkStart + chunk.count - 1) - chunkStart
            let count = sliceEnd - sliceStart + 1
            out.replaceSubrange(offset..<(offset + count), with: chunk[sliceStart...sliceEnd])
            offset += count
        }
        return out
    }

    /// Fetches and decrypts one chunk (cache + in-flight dedup live in the actor).
    private func chunkPlaintext(_ index: Int) async throws -> [UInt8] {
        let chunkPlain = TxtCrypto.chunkPlainBytes
        let cipherChunk = TxtCrypto.chunkCipherBytes
        let cipherTotal = info.plainBytes + info.chunkCount * TxtCrypto.tagBytes
        return try await chunks.plaintext(at: index) { [self] index in
            let cipherStart = index * cipherChunk
            let cipherEnd = min(cipherStart + cipherChunk - 1, cipherTotal - 1)
            let (ciphertext, _) = try await api.cipherRange(
                mediaId: mediaId,
                start: cipherStart,
                end: cipherEnd
            )
            let plainBytes = min(chunkPlain, info.plainBytes - index * chunkPlain)
            return try await bridge.decryptChunk(
                ciphertext: ciphertext,
                fileKey: fileKey,
                noncePrefix: noncePrefix,
                cryptoFormat: info.cryptoFormat,
                totalPlainBytes: info.plainBytes,
                chunkPlainBytes: plainBytes,
                index: index,
                mediaId: mediaId
            )
        }
    }
}

/// Builds players for encrypted media and keeps them per mediaId (spec §3: an
/// existing player must not be recreated while typing).
@MainActor
final class MediaPlayerRegistry {
    private var players: [String: AVPlayer] = [:]
    private var loaders: [String: EncryptedResourceLoader] = [:]

    func player(
        mediaId: String,
        info: MediaInfo,
        api: ApiClient,
        bridge: CryptoBridge
    ) -> AVPlayer? {
        if let existing = players[mediaId] { return existing }
        guard EncryptedResourceLoader.isPlayable(info),
              let loader = try? EncryptedResourceLoader(mediaId: mediaId, info: info, api: api, bridge: bridge),
              let url = loader.makeURL()
        else { return nil }
        let asset = AVURLAsset(url: url)
        asset.resourceLoader.setDelegate(loader, queue: DispatchQueue(label: "txt-cipher-loader", qos: .userInitiated))
        let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        player.actionAtItemEnd = .pause
        players[mediaId] = player
        loaders[mediaId] = loader
        return player
    }

    func stopAll() {
        for player in players.values { player.pause() }
        for loader in loaders.values { loader.stop() }
        players.removeAll()
        loaders.removeAll()
    }
}

/// Supported picker types (spec §11.1): images, video, audio. SVG/HTML/PDF and
/// executables are rejected in the UI.
enum MediaTypes {
    static var pickerTypes: [UTType] {
        var types: [UTType] = [.image, .movie, .video, .audio]
        if let mpeg4 = UTType("public.mpeg-4-audio") { types.append(mpeg4) }
        if let wav = UTType("com.microsoft.waveform-audio") { types.append(wav) }
        if let flac = UTType("org.xiph.flac") { types.append(flac) }
        if let ogg = UTType("org.xiph.ogg-audio") { types.append(ogg) }
        return types
    }
}
