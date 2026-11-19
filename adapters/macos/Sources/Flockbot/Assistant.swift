import AppKit

/// The assistants this app can connect. The bundled connector edits their
/// settings (see `Helper`); this type only knows how each one looks and runs.
enum Assistant: String, CaseIterable, Identifiable {
  case claudeDesktop = "claude-desktop"
  case claudeCode = "claude-code"
  case codex

  var id: String { rawValue }

  var name: String {
    switch self {
    case .claudeDesktop: "Claude Desktop"
    case .claudeCode: "Claude Code"
    case .codex: "ChatGPT & Codex"
    }
  }

  /// Apps that read this assistant's configuration, most familiar first.
  var bundleIdentifiers: [String] {
    switch self {
    case .claudeDesktop, .claudeCode: ["com.anthropic.claudefordesktop"]
    case .codex: ["com.openai.codex", "com.openai.chat"]
    }
  }

  var appURL: URL? {
    bundleIdentifiers.lazy.compactMap {
      NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0)
    }.first
  }

  /// Whether the assistant is on this Mac. The connector reports whether its
  /// command-line tool is installed.
  func isInstalled(commandLine: Bool) -> Bool {
    switch self {
    case .claudeDesktop: appURL != nil
    case .claudeCode: commandLine
    case .codex: appURL != nil || commandLine
    }
  }

  /// A running app that launched before `date`, and so still uses the
  /// configuration from then. Desktop apps read it only at launch; Claude Code
  /// reads it as each session starts, so it never needs a restart.
  func appLaunched(before date: Date) -> NSRunningApplication? {
    guard self != .claudeCode else { return nil }
    return bundleIdentifiers.lazy
      .flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }
      .first { ($0.launchDate ?? .distantPast) < date }
  }

  /// The installed app's own icon; command-line tools borrow their maker's app.
  var icon: NSImage? {
    appURL.map { NSWorkspace.shared.icon(forFile: $0.path) }
  }
}

/// Where this copy of the app lives. Assistants launch the bundled connector
/// by its full path, so that path has to stay put.
enum Install {
  /// The shared Applications folder, then the person's own for a standard
  /// account that can't write to the shared one.
  static var applicationFolders: [URL] {
    [
      URL(fileURLWithPath: "/Applications"),
      FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications"),
    ]
  }

  /// Whether this copy sits somewhere it will stay. A downloaded app can run
  /// from a temporary translocated path, and a disk image goes away when it's
  /// ejected, so only a copy in an Applications folder connects assistants or
  /// takes over their entries.
  static var isInstalledDurably: Bool {
    applicationFolders.contains { Helper.url.path.hasPrefix($0.path + "/") }
  }

  /// Copies the app into the first Applications folder that takes it,
  /// swapping out an older Flockbot there in one step, and returns the copy.
  static func moveToApplications(
    from source: URL = Bundle.main.bundleURL, into folders: [URL] = applicationFolders
  ) throws -> URL {
    let files = FileManager.default
    var lastError: Error = CocoaError(.fileWriteNoPermission)
    for folder in folders {
      let destination = folder.appendingPathComponent("Flockbot.app")
      // Copied beside the destination first, so a failed copy leaves an
      // existing Flockbot as it was.
      let staging = folder.appendingPathComponent(".Flockbot-\(UUID().uuidString).app")
      do {
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        try files.copyItem(at: source, to: staging)
        // A copy that keeps the download's quarantine flag would run from a
        // translocated path again. Gatekeeper already approved this one.
        let xattr = Process()
        xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        xattr.arguments = ["-dr", "com.apple.quarantine", staging.path]
        if (try? xattr.run()) != nil { xattr.waitUntilExit() }
        if files.fileExists(atPath: destination.path) {
          _ = try files.replaceItemAt(destination, withItemAt: staging)
        } else {
          try files.moveItem(at: staging, to: destination)
        }
        return destination
      } catch {
        try? files.removeItem(at: staging)
        lastError = error
      }
    }
    throw lastError
  }
}
