// swift-tools-version: 6.1
import PackageDescription

/// Shared native core (spec §16): document model, crypto contract, API client
/// and sync engine used by the iOS and macOS apps. Kept free of UI so it can be
/// unit-tested from the command line and reused by both platforms.
let package = Package(
    name: "TxtCore",
    platforms: [
        // macOS 15 / iOS 18 are the minimum candidates in the spec (§13); the
        // APIs actually used are checked on device before that is claimed.
        .macOS(.v15),
        .iOS(.v18),
    ],
    products: [
        .library(name: "TxtCore", targets: ["TxtCore"]),
    ],
    targets: [
        .target(
            name: "TxtCore",
            path: "Sources/TxtCore"
        ),
        .testTarget(
            name: "TxtCoreTests",
            dependencies: ["TxtCore"],
            path: "Tests/TxtCoreTests"
        ),
    ]
)
