// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Flockbot",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "Flockbot", path: "Sources/Flockbot")
  ]
)
