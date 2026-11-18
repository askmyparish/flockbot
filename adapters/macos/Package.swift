// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Flockbot",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.10.1")
  ],
  targets: [
    .executableTarget(
      name: "Flockbot",
      dependencies: [.product(name: "Sparkle", package: "Sparkle")],
      path: "Sources/Flockbot",
      // build.sh copies Sparkle.framework into the bundle's Frameworks folder.
      linkerSettings: [
        .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])
      ]
    )
  ]
)
