// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Watchwise",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "WatchwiseCore", targets: ["WatchwiseCore"]),
        .library(name: "WatchwiseIntegrations", targets: ["WatchwiseIntegrations"]),
        .executable(name: "WatchwiseApp", targets: ["WatchwiseApp"]),
        .executable(name: "WatchwiseBridge", targets: ["WatchwiseBridge"]),
        .executable(name: "WatchwiseVerify", targets: ["WatchwiseVerify"])
    ],
    targets: [
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3", providers: [.brew(["sqlite3"]), .apt(["libsqlite3-dev"])]),
        .target(name: "WatchwiseCore", dependencies: ["CSQLite"]),
        .target(name: "WatchwiseIntegrations", dependencies: ["WatchwiseCore"]),
        .executableTarget(name: "WatchwiseApp", dependencies: ["WatchwiseCore", "WatchwiseIntegrations"]),
        .executableTarget(name: "WatchwiseBridge", dependencies: ["WatchwiseCore", "WatchwiseIntegrations"]),
        .executableTarget(name: "WatchwiseVerify", dependencies: ["WatchwiseCore", "WatchwiseIntegrations"]),
        .testTarget(name: "WatchwiseCoreTests", dependencies: ["WatchwiseCore"]),
        .testTarget(name: "WatchwiseIntegrationsTests", dependencies: ["WatchwiseIntegrations", "WatchwiseCore"])
    ]
)
