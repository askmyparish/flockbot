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
  case claudeCodeEntryLost(String)
  case commandFailed(String)

  var errorDescription: String? {
    switch self {
    case .unreadable(let path):
      "Flockbot couldn't read \(path), so it left the file unchanged."
    case .claudeNotFound:
      "Flockbot couldn't find the claude command. Install Claude Code first."
    case .claudeCodeEntryLost(let backup):
      "Claude Code lost its Flockbot connection during an update. Click Connect to add it again. Its previous settings are saved in \(backup)."
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

  static var claudeCodeBackupURL: URL {
    home.appendingPathComponent("Library/Application Support/flockbot/claude-code-entry.json")
  }

  static var codexURL: URL {
    if let path = ProcessInfo.processInfo.environment["CODEX_HOME"], !path.isEmpty {
      return URL(fileURLWithPath: path, isDirectory: true).appendingPathComponent("config.toml")
    }
    return home.appendingPathComponent(".codex/config.toml")
  }

  /// The command the assistant's `flockbot` entry runs, if it has one.
  static func registeredCommand(_ assistant: Assistant) -> String? {
    switch assistant {
    case .claudeDesktop: try? jsonCommand(at: claudeDesktopURL)
    case .claudeCode: try? jsonCommand(at: claudeCodeURL)
    case .codex: codexCommand()
    }
  }

  static func isConnected(_ assistant: Assistant) -> Bool {
    assistant == .codex ? codexConnected() : registeredCommand(assistant) == helperPath
  }

  /// Status needs only the exact line this app writes, so it also recognizes
  /// tables the guarded reader declines (see `codexCommandEntry`).
  static func codexConnected() -> Bool {
    if codexCommand() == helperPath { return true }
    guard let text = try? String(contentsOf: codexURL, encoding: .utf8) else { return false }
    let lines = text.components(separatedBy: "\n")
    guard let section = codexSection(in: lines) else { return false }
    return lines[section].contains { $0.trimmingCharacters(in: .whitespaces) == codexCommandLine() }
  }

  /// The shared Applications folder, then the person's own for a standard
  /// account that can't write to the shared one.
  static var applicationFolders: [URL] {
    [URL(fileURLWithPath: "/Applications"), home.appendingPathComponent("Applications")]
  }

  /// Whether this copy sits somewhere it will stay. A downloaded app can run
  /// from a temporary translocated path, and a disk image goes away when it's
  /// ejected, so only a copy in an Applications folder connects assistants or
  /// takes over their entries.
  static var isInstalledDurably: Bool {
    applicationFolders.contains { helperPath.hasPrefix($0.path + "/") }
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
        _ = try? run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staging.path])
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

  /// Points entries left behind by a moved or renamed Flockbot.app at this
  /// copy's connector. Entries that run anything other than a Flockbot
  /// connector belong to someone else and stay. Each result carries when its
  /// change was written, or why it failed.
  static func repointMoved() -> [(Assistant, Result<Date, Error>)] {
    guard isInstalledDurably else { return [] }
    return Assistant.allCases.compactMap { assistant in
      guard let command = registeredCommand(assistant), command != helperPath,
        URL(fileURLWithPath: command).lastPathComponent == "flockbot-mcp"
      else { return nil }
      return (assistant, Result { try repoint(assistant); return Date() })
    }
  }

  /// Changes only the entry's command, keeping its arguments, environment and
  /// any other settings, such as a Codex entry someone disabled.
  static func repoint(_ assistant: Assistant) throws {
    switch assistant {
    case .claudeDesktop:
      let url = claudeDesktopURL.resolvingSymlinksInPath()
      guard let data = try? Data(contentsOf: url),
        var root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { throw ConfigError.unreadable(url.path) }
      var servers = try claudeDesktopServers(in: root, at: url)
      guard var entry = servers[server] as? [String: Any] else {
        throw ConfigError.unreadable(url.path)
      }
      entry["command"] = helperPath
      servers[server] = entry
      root["mcpServers"] = servers
      try writeJSON(root, to: url)
    case .claudeCode:
      guard let claude = claudeCLI() else { throw ConfigError.claudeNotFound }
      guard let data = try? Data(contentsOf: claudeCodeURL),
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let original = (root["mcpServers"] as? [String: Any])?[server] as? [String: Any]
      else { throw ConfigError.unreadable(claudeCodeURL.path) }
      var entry = original
      entry["command"] = helperPath
      let replacement = try jsonText(entry)
      let restore = try jsonText(original)
      // Claude Code can only replace an entry by removing it first, so keep a
      // copy until the new one is in, in case putting the old one back fails.
      try writePrivate(Data(restore.utf8), to: claudeCodeBackupURL)
      do {
        try run(claude, ["mcp", "remove", "--scope", "user", server])
      } catch {
        try? FileManager.default.removeItem(at: claudeCodeBackupURL)
        throw error
      }
      do {
        try run(claude, ["mcp", "add-json", "--scope", "user", server, replacement])
      } catch {
        // Put the old entry back rather than leave Claude Code without one.
        do {
          try run(claude, ["mcp", "add-json", "--scope", "user", server, restore])
        } catch {
          throw ConfigError.claudeCodeEntryLost(claudeCodeBackupURL.path)
        }
        try? FileManager.default.removeItem(at: claudeCodeBackupURL)
        throw error
      }
      try? FileManager.default.removeItem(at: claudeCodeBackupURL)
    case .codex:
      let url = codexURL.resolvingSymlinksInPath()
      guard let text = try? String(contentsOf: url, encoding: .utf8) else {
        throw ConfigError.unreadable(url.path)
      }
      var lines = text.components(separatedBy: "\n")
      guard let entry = codexCommandEntry(in: lines) else { throw ConfigError.unreadable(url.path) }
      lines[entry.line].replaceSubrange(entry.value, with: tomlString(helperPath))
      try writePrivate(Data(lines.joined(separator: "\n").utf8), to: url)
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
      try writeJSON(root, to: url)
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
    try writeJSON(root, to: url)
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

  static func codexCommand() -> String? {
    guard let text = try? String(contentsOf: codexURL, encoding: .utf8) else { return nil }
    return codexCommandEntry(in: text.components(separatedBy: "\n"))?.command
  }

  /// The `command` key of the `[mcp_servers.flockbot]` table itself, not of a
  /// subtable: its line, the range of its string value and the decoded value.
  static func codexCommandEntry(in lines: [String]) -> (
    line: Int, value: Range<String.Index>, command: String
  )? {
    guard let section = codexSection(in: lines) else { return nil }
    let table = section.dropFirst().prefix {
      !lines[$0].trimmingCharacters(in: .whitespaces).hasPrefix("[")
    }
    // A line inside a multi-line string can look like a key. Rather than track
    // that context, a table with one is never read, so it's never rewritten.
    if table.contains(where: { lines[$0].contains("\"\"\"") || lines[$0].contains("'''") }) {
      return nil
    }
    for index in table {
      let line = lines[index]
      guard let equals = line.firstIndex(of: "="),
        line[..<equals].trimmingCharacters(in: .whitespaces) == "command",
        let (value, command) = tomlString(in: line, after: equals)
      else { continue }
      return (index, value, command)
    }
    return nil
  }

  /// Reads the single-line basic ("…") or literal ('…') TOML string after `=`,
  /// followed by nothing but whitespace or a comment. Anything else, including
  /// multi-line strings and unknown escapes, returns nil so the entry is left alone.
  static func tomlString(in line: String, after equals: String.Index) -> (
    Range<String.Index>, String
  )? {
    var index = line.index(after: equals)
    while index < line.endIndex, line[index] == " " || line[index] == "\t" {
      index = line.index(after: index)
    }
    guard index < line.endIndex, line[index] == "\"" || line[index] == "'" else { return nil }
    let quote = line[index]
    let open = index
    if line[line.index(after: open)...].hasPrefix(String(repeating: quote, count: 2)) {
      return nil
    }
    var value = ""
    index = line.index(after: open)
    while true {
      guard index < line.endIndex else { return nil }
      let character = line[index]
      if character == quote { break }
      if quote == "\"" && character == "\\" {
        index = line.index(after: index)
        guard index < line.endIndex else { return nil }
        switch line[index] {
        case "\"": value.append("\"")
        case "\\": value.append("\\")
        case "b": value.append("\u{08}")
        case "t": value.append("\t")
        case "n": value.append("\n")
        case "f": value.append("\u{0C}")
        case "r": value.append("\r")
        case "u", "U":
          let digits = line.index(after: index)
          guard
            let end = line.index(digits, offsetBy: line[index] == "u" ? 4 : 8, limitedBy: line.endIndex),
            line[digits..<end].allSatisfy(\.isHexDigit),
            let code = UInt32(line[digits..<end], radix: 16),
            let scalar = Unicode.Scalar(code)
          else { return nil }
          value.unicodeScalars.append(scalar)
          index = line.index(before: end)
        default: return nil
        }
      } else {
        value.append(character)
      }
      index = line.index(after: index)
    }
    let close = line.index(after: index)
    let rest = line[close...].trimmingCharacters(in: .whitespacesAndNewlines)
    guard rest.isEmpty || rest.hasPrefix("#") else { return nil }
    return (open..<close, value)
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

  static func jsonText(_ value: [String: Any]) throws -> String {
    String(
      decoding: try JSONSerialization.data(withJSONObject: value, options: .withoutEscapingSlashes),
      as: UTF8.self)
  }

  static func writeJSON(_ root: [String: Any], to url: URL) throws {
    var data = try JSONSerialization.data(
      withJSONObject: root, options: [.prettyPrinted, .withoutEscapingSlashes])
    data.append(Data("\n".utf8))
    try writePrivate(data, to: url)
  }

  /// Atomic owner-only write. Callers pass the resolved path so a symlinked
  /// dotfile is updated in place rather than replaced.
  static func writePrivate(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
}
