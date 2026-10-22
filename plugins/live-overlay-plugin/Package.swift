// swift-tools-version: 5.9
import PackageDescription

// ชื่อ package/product ต้องตรงกับ fixName(npm package name)
// "live-overlay-plugin" -> "LiveOverlayPlugin"
let package = Package(
    name: "LiveOverlayPlugin",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "LiveOverlayPlugin",
            targets: ["LiveOverlayPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3")
    ],
    targets: [
        .target(
            name: "LiveOverlayPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "ios")
    ]
)
