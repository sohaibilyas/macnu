// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "MacnuNative",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MacnuNative", type: .static, targets: ["MacnuNative"])
    ],
    targets: [
        .target(
            name: "MacnuNative",
            path: "Sources/MacnuNative"
        )
    ]
)
