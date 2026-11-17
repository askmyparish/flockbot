import AppKit

/// The assistants this app can connect. Each launches the bundled helper by
/// its full path, so all of them share the one Keychain session.
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

  var isInstalled: Bool {
    switch self {
    case .claudeDesktop: appURL != nil
    case .claudeCode: Configs.claudeCLI() != nil
    case .codex: appURL != nil || Configs.codexCLI() != nil
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

enum ConfigError: LocalizedError {
  case unreadable(String)
  case claudeNotFound
  case commandFailed(String)

  var errorDescription: String? {
    switch self {
    case .unreadable(let path):
      "Flockbot couldn't read \(path), so it left the file unchanged."
    case .claudeNotFound:
      "Flockbot couldn't find the claude command. Install Claude Code first."
    case .commandFailed(let output):
      "The claude command failed: \(output.trimmingCharacters(in: .whitespacesAndNewlines))"
    }
  }
}

/// Adds one `flockbot` server entry to each assistant's own configuration,
/// leaving every other setting in those files alone.
enum Configs {
  static let server = "flockbot"

  static var helperPath: String { Helper.url.path }

  /// HOME first, so the `--connect` command can be tried against a scratch home.
  static var home: URL {
    if let path = ProcessInfo.processInfo.environment["HOME"], !path.isEmpty {
      return URL(fileURLWithPath: path, isDirectory: true)
    }
    return FileManager.default.homeDirectoryForCurrentUser
  }

  static var claudeDesktopURL: URL {
    home.appendingPathComponent("Library/Application Support/Claude/claude_desktop_config.json")
  }

  static var claudeCodeURL: URL { home.appendingPathComponent(".claude.json") }

  static var codexURL: URL {
    if let path = ProcessInfo.processInfo.environment["CODEX_HOME"], !path.isEmpty {
      return URL(fileURLWithPath: path, isDirectory: true).appendingPathComponent("config.toml")
    }
    return home.appendingPathComponent(".codex/config.toml")
  }

  static func isConnected(_ assistant: Assistant) -> Bool {
    switch assistant {
    case .claudeDesktop: (try? jsonCommand(at: claudeDesktopURL)) == helperPath
    case .claudeCode: (try? jsonCommand(at: claudeCodeURL)) == helperPath
    case .codex: codexConnected()
    }
  }

  /// Removes only the `flockbot` entry, leaving the rest of each file alone.
  static func disconnect(_ assistant: Assistant) throws -> String {
    switch assistant {
    case .claudeDesktop:
      let url = claudeDesktopURL.resolvingSymlinksInPath()
      guard let data = try? Data(contentsOf: url) else { return "" }
      guard var root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw ConfigError.unreadable(url.path)
      }
      var servers = try claudeDesktopServers(in: root, at: url)
      guard servers.removeValue(forKey: server) != nil else { return "" }
      root["mcpServers"] = servers
      var output = try JSONSerialization.data(
        withJSONObject: root, options: [.prettyPrinted, .withoutEscapingSlashes])
      output.append(Data("\n".utf8))
      try writePrivate(output, to: url)
      return "Reopen Claude to finish"
    case .claudeCode:
      guard let claude = claudeCLI() else { throw ConfigError.claudeNotFound }
      try run(claude, ["mcp", "remove", "--scope", "user", server])
      return "Applies to new sessions"
    case .codex:
      let url = codexURL.resolvingSymlinksInPath()
      guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
      var lines = text.components(separatedBy: "\n")
      guard let range = codexSection(in: lines) else { return "" }
      lines.removeSubrange(range)
      var result = lines.joined(separator: "\n")
      while result.hasSuffix("\n\n") { result.removeLast() }
      try writePrivate(Data(result.utf8), to: url)
      return "Reopen ChatGPT to finish"
    }
  }

  /// Returns what to tell the person once the entry is written.
  static func connect(_ assistant: Assistant) throws -> String {
    switch assistant {
    case .claudeDesktop:
      try connectClaudeDesktop()
      return "Reopen Claude to finish"
    case .claudeCode:
      try connectClaudeCode()
      return "Applies to new sessions"
    case .codex:
      try connectCodex()
      return "Reopen ChatGPT to finish"
    }
  }

  // MARK: Claude Desktop

  static func connectClaudeDesktop() throws {
    let url = claudeDesktopURL.resolvingSymlinksInPath()
    var root: [String: Any] = [:]
    if FileManager.default.fileExists(atPath: url.path) {
      guard let data = try? Data(contentsOf: url),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { throw ConfigError.unreadable(url.path) }
      root = parsed
    }
    var servers = try claudeDesktopServers(in: root, at: url)
    servers[server] = ["command": helperPath, "args": [String]()]
    root["mcpServers"] = servers
    var data = try JSONSerialization.data(
      withJSONObject: root, options: [.prettyPrinted, .withoutEscapingSlashes])
    data.append(Data("\n".utf8))
    try writePrivate(data, to: url)
  }

  /// The file's server list. Anything but a JSON object there is a file this
  /// app doesn't understand, so it refuses to replace it.
  static func claudeDesktopServers(in root: [String: Any], at url: URL) throws -> [String: Any] {
    guard let value = root["mcpServers"] else { return [:] }
    guard let servers = value as? [String: Any] else { throw ConfigError.unreadable(url.path) }
    return servers
  }

  static func jsonCommand(at url: URL) throws -> String? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let servers = root?["mcpServers"] as? [String: Any]
    return (servers?[server] as? [String: Any])?["command"] as? String
  }

  // MARK: Claude Code

  /// Claude Code rewrites ~/.claude.json while it runs, so its own CLI makes the change.
  static func connectClaudeCode() throws {
    guard let claude = claudeCLI() else { throw ConfigError.claudeNotFound }
    _ = try? run(claude, ["mcp", "remove", "--scope", "user", server])
    try run(claude, ["mcp", "add", "--scope", "user", server, "--", helperPath])
  }

  static func claudeCLI() -> String? {
    [
      "\(home.path)/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "\(home.path)/.claude/local/claude",
    ].first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  static func codexCLI() -> String? {
    [
      "\(home.path)/.local/bin/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ].first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  @discardableResult
  static func run(_ path: String, _ arguments: [String]) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    // Apps opened from Finder get a minimal PATH.
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = [
      "\(home.path)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ].joined(separator: ":")
    process.environment = environment
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    process.standardInput = FileHandle.nullDevice
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    guard process.terminationStatus == 0 else { throw ConfigError.commandFailed(text) }
    return text
  }

  // MARK: Codex

  static var codexHeader: String { "[mcp_servers.\(server)]" }

  static func codexCommandLine() -> String { "command = \(tomlString(helperPath))" }

  /// Replaces any existing `[mcp_servers.flockbot]` table, including its
  /// subtables, then appends the current one. Other text is kept as written.
  static func connectCodex() throws {
    let url = codexURL.resolvingSymlinksInPath()
    var text = ""
    if FileManager.default.fileExists(atPath: url.path) {
      guard let existing = try? String(contentsOf: url, encoding: .utf8) else {
        throw ConfigError.unreadable(url.path)
      }
      text = existing
    }
    var lines = text.components(separatedBy: "\n")
    if let range = codexSection(in: lines) { lines.removeSubrange(range) }
    var result = lines.joined(separator: "\n")
    while result.hasSuffix("\n\n") { result.removeLast() }
    if !result.isEmpty {
      if !result.hasSuffix("\n") { result += "\n" }
      result += "\n"
    }
    result += "\(codexHeader)\n\(codexCommandLine())\n"
    try writePrivate(Data(result.utf8), to: url)
  }

  static func codexConnected() -> Bool {
    guard let text = try? String(contentsOf: codexURL, encoding: .utf8) else { return false }
    let lines = text.components(separatedBy: "\n")
    guard let range = codexSection(in: lines) else { return false }
    return lines[range].contains { $0.trimmingCharacters(in: .whitespaces) == codexCommandLine() }
  }

  static func codexSection(in lines: [String]) -> Range<Int>? {
    guard
      let start = lines.firstIndex(where: {
        $0.trimmingCharacters(in: .whitespaces) == codexHeader
      })
    else { return nil }
    var end = start + 1
    while end < lines.count {
      let line = lines[end].trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("[") && !line.hasPrefix("[mcp_servers.\(server).") { break }
      end += 1
    }
    return start..<end
  }

  static func tomlString(_ value: String) -> String {
    let escaped = value.replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(escaped)\""
  }

  // MARK: Files

  /// Atomic owner-only write. Callers pass the resolved path so a symlinked
  /// dotfile is updated in place rather than replaced.
  static func writePrivate(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
}
