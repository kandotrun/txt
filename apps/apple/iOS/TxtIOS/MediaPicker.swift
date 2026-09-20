import AVFoundation
import PhotosUI
import SwiftUI
import TxtCore
import UniformTypeIdentifiers
import UIKit

/// Standard media pickers (spec §4.3, §11.1).
///
/// Photos come from `PhotosPicker`, files from the document picker. The app
/// requests no camera, microphone or full-library access: only the items the
/// user explicitly picks are read.
struct MediaPicker: View {
    let onPicked: ([URL]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var isFilePickerPresented = false
    @State private var isPhotosPresented = false

    var body: some View {
        NavigationStack {
            List {
                Button {
                    isPhotosPresented = true
                } label: {
                    Label("写真・動画を選ぶ", systemImage: "photo")
                }
                Button {
                    isFilePickerPresented = true
                } label: {
                    Label("ファイルを選ぶ", systemImage: "folder")
                }
            }
            .navigationTitle("添付")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
            }
            .photosPicker(
                isPresented: $isPhotosPresented,
                selection: $photoItems,
                maxSelectionCount: 8,
                matching: .any(of: [.images, .videos])
            )
            .fileImporter(
                isPresented: $isFilePickerPresented,
                allowedContentTypes: MediaTypes.pickerTypes,
                allowsMultipleSelection: true
            ) { result in
                if case .success(let urls) = result {
                    onPicked(urls)
                    dismiss()
                }
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    var urls: [URL] = []
                    for item in items {
                        if let url = try? await Self.materialize(item) {
                            urls.append(url)
                        }
                    }
                    onPicked(urls)
                    dismiss()
                }
            }
        }
    }

    /// Copies a picked photo/video into the app's temporary directory so the
    /// uploader can read it as a file. The copy is removed after upload by the
    /// system's temp cleanup; nothing plaintext is written outside the sandbox.
    private static func materialize(_ item: PhotosPickerItem) async throws -> URL? {
        guard let data = try await item.loadTransferable(type: Data.self) else { return nil }
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "dat"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext)
        try data.write(to: url, options: .atomic)
        return url
    }
}

/// Playback surface for encrypted media (spec §11.7).
///
/// The player reads through `EncryptedResourceLoader`, which decrypts range
/// requests in memory; nothing plaintext is written to disk.
struct MediaPlayerView: View {
    @EnvironmentObject private var model: AppModel
    let mediaId: String
    let info: MediaInfo

    @State private var player: AVPlayer?

    var body: some View {
        Group {
            if let player {
                if info.kind == "video" {
                    VideoPlayerView(player: player)
                } else {
                    AudioPlayerView(player: player, name: info.name)
                }
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "paperclip")
                    Text(info.name).lineLimit(1)
                    Spacer()
                    Text("再生できません").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .onAppear {
            if player == nil {
                player = model.player(for: mediaId)
            }
        }
    }
}

/// Thin wrapper so the AVPlayerLayer is created once per player instance.
struct VideoPlayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {
        view.playerLayer.player = player
    }

    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

struct AudioPlayerView: View {
    let player: AVPlayer
    let name: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "waveform")
            Text(name).lineLimit(1)
            Spacer()
            Button {
                player.rate > 0 ? player.pause() : player.play()
            } label: {
                Image(systemName: player.rate > 0 ? "pause.fill" : "play.fill")
            }
        }
        .padding(.vertical, 6)
    }
}

