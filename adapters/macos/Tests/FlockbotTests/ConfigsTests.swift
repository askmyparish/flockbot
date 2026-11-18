import XCTest

@testable import Flockbot

/// Each test runs against its own scratch home, so the person's real assistant
/// configuration is never read or written.
final class ConfigsTests: XCTestCase {
  var home: URL!
  var savedEnvironment: [String: String?] = [:]
  let otherServer: [String: Any] = ["command": "/usr/local/bin/other", "args": ["--flag"]]

  override func setUpWithError() throws {
    home = FileManager.default.temporaryDirectory
      .appendingPathComponent("flockbot-tests-\(UUID().uuidString)").resolvingSymlinksInPath()
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    for name in ["HOME", "CODEX_HOME", "FAKE_CLAUDE_FAILED_ADDS"] {
      savedEnvironment.updateValue(ProcessInfo.processInfo.environment[name], forKey: name)
    }
    setenv("HOME", home.path, 1)
    unsetenv("CODEX_HOME")
    unsetenv("FAKE_CLAUDE_FAILED_ADDS")
  }

  override func tearDownWithError() throws {
    for (name, value) in savedEnvironment {
      if let value { setenv(name, value, 1) } else { unsetenv(name) }
    }
    try FileManager.default.removeItem(at: home)
  }

  // MARK: Claude Desktop

  func testClaudeDesktopConnectKeepsOtherSettingsAndServers() throws {
    try writeJSON(
      ["theme": "dark", "mcpServers": ["other": otherServer]], to: Configs.claudeDesktopURL)

    XCTAssertEqual(try Configs.connect(.claudeDesktop), "Reopen Claude to finish")

    let root = try readJSON(Configs.claudeDesktopURL)
    XCTAssertEqual(root["theme"] as? String, "dark")
    let servers = try XCTUnwrap(root["mcpServers"] as? [String: Any])
    XCTAssertEqual(servers["other"] as? NSDictionary, otherServer as NSDictionary)
    XCTAssertEqual(
      servers["flockbot"] as? NSDictionary,
      ["command": Configs.helperPath, "args": [String]()] as NSDictionary)
    XCTAssertTrue(Configs.isConnected(.claudeDesktop))
    XCTAssertEqual(try permissions(Configs.claudeDesktopURL), 0o600)
  }

  func testClaudeDesktopConnectCreatesMissingFile() throws {
    try Configs.connectClaudeDesktop()
    XCTAssertTrue(Configs.isConnected(.claudeDesktop))
  }

  func testClaudeDesktopRefusesFilesItCannotParse() throws {
    let invalid = "{ \"mcpServers\": { // a comment\n"
    try write(invalid, to: Configs.claudeDesktopURL)
    XCTAssertThrowsError(try Configs.connect(.claudeDesktop))
    XCTAssertThrowsError(try Configs.disconnect(.claudeDesktop))
    XCTAssertEqual(try read(Configs.claudeDesktopURL), invalid)

    let listOfServers = "{\"mcpServers\": [\"flockbot\"]}"
    try write(listOfServers, to: Configs.claudeDesktopURL)
    XCTAssertThrowsError(try Configs.connect(.claudeDesktop))
    XCTAssertEqual(try read(Configs.claudeDesktopURL), listOfServers)
  }

  func testClaudeDesktopDisconnectRemovesOnlyFlockbot() throws {
    try writeJSON(
      ["mcpServers": ["other": otherServer, "flockbot": ["command": Configs.helperPath]]],
      to: Configs.claudeDesktopURL)

    XCTAssertEqual(try Configs.disconnect(.claudeDesktop), "Reopen Claude to finish")

    let servers = try XCTUnwrap(try readJSON(Configs.claudeDesktopURL)["mcpServers"] as? [String: Any])
    XCTAssertEqual(Array(servers.keys), ["other"])
    XCTAssertFalse(Configs.isConnected(.claudeDesktop))
  }

  func testClaudeDesktopDisconnectWithoutAnEntryLeavesTheFileAlone() throws {
    XCTAssertEqual(try Configs.disconnect(.claudeDesktop), "")
    XCTAssertFalse(FileManager.default.fileExists(atPath: Configs.claudeDesktopURL.path))

    let text = "{\"mcpServers\":{\"other\":{}}}"
    try write(text, to: Configs.claudeDesktopURL)
    XCTAssertEqual(try Configs.disconnect(.claudeDesktop), "")
    XCTAssertEqual(try read(Configs.claudeDesktopURL), text)
  }

  func testWritesGoThroughASymlinkedConfig() throws {
    let target = home.appendingPathComponent("dotfiles/claude_desktop_config.json")
    try writeJSON(["mcpServers": [:]], to: target)
    try FileManager.default.createDirectory(
      at: Configs.claudeDesktopURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: Configs.claudeDesktopURL, withDestinationURL: target)

    try Configs.connectClaudeDesktop()

    XCTAssertEqual(
      try FileManager.default.destinationOfSymbolicLink(atPath: Configs.claudeDesktopURL.path),
      target.path)
    XCTAssertTrue(Configs.isConnected(.claudeDesktop))
  }

  func testClaudeDesktopRepointChangesOnlyTheCommand() throws {
    let moved = "/Volumes/Flockbot/Flockbot.app/Contents/MacOS/flockbot-mcp"
    try writeJSON(
      ["mcpServers": ["flockbot": ["command": moved, "args": ["--x"], "env": ["A": "1"]]]],
      to: Configs.claudeDesktopURL)

    try Configs.repoint(.claudeDesktop)

    let entry = try XCTUnwrap(
      (try readJSON(Configs.claudeDesktopURL)["mcpServers"] as? [String: Any])?["flockbot"]
        as? [String: Any])
    XCTAssertEqual(
      entry as NSDictionary,
      ["command": Configs.helperPath, "args": ["--x"], "env": ["A": "1"]] as NSDictionary)
  }

  // MARK: Codex

  func testCodexConnectAppendsAfterExistingSettings() throws {
    try write("model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n\n", to: Configs.codexURL)

    XCTAssertEqual(try Configs.connect(.codex), "Reopen ChatGPT to finish")

    XCTAssertEqual(
      try read(Configs.codexURL),
      "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n"
        + "[mcp_servers.flockbot]\n\(Configs.codexCommandLine())\n")
    XCTAssertTrue(Configs.isConnected(.codex))
    XCTAssertEqual(try permissions(Configs.codexURL), 0o600)
  }

  func testCodexConnectReplacesTheOldTableAndItsSubtables() throws {
    try write(
      """
      [mcp_servers.flockbot]
      command = "/old/flockbot-mcp"

      [mcp_servers.flockbot.env]
      A = "1"

      [mcp_servers.other]
      command = "other"
      """, to: Configs.codexURL)

    try Configs.connectCodex()

    XCTAssertEqual(
      try read(Configs.codexURL),
      "[mcp_servers.other]\ncommand = \"other\"\n\n[mcp_servers.flockbot]\n\(Configs.codexCommandLine())\n")
  }

  func testCodexConnectHonorsCodexHome() throws {
    let codexHome = home.appendingPathComponent("elsewhere")
    setenv("CODEX_HOME", codexHome.path, 1)
    try Configs.connectCodex()
    XCTAssertTrue(FileManager.default.fileExists(atPath: codexHome.appendingPathComponent("config.toml").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".codex").path))
  }

  func testCodexDisconnectRemovesOnlyFlockbot() throws {
    try write(
      """
      model = "o3"

      [mcp_servers.flockbot]
      command = "x"

      [mcp_servers.flockbot.env]
      A = "1"

      [mcp_servers.other]
      command = "other"

      """, to: Configs.codexURL)

    _ = try Configs.disconnect(.codex)

    XCTAssertEqual(
      try read(Configs.codexURL), "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"other\"\n")
  }

  func testCodexCommandReadsOnlyTheTablesOwnCommand() {
    let lines = """
      [mcp_servers.flockbot.env]
      command = "not this one"

      [mcp_servers.flockbot]
      # command = "commented out"
      args = []
      command = 'C:\\literal' # trailing comment

      [mcp_servers.flockbot.extra]
      command = "nor this one"
      """.components(separatedBy: "\n")

    let entry = Configs.codexCommandEntry(in: lines)
    XCTAssertEqual(entry?.line, 6)
    XCTAssertEqual(entry?.command, "C:\\literal")
    XCTAssertEqual(entry.map { String(lines[6][$0.value]) }, "'C:\\literal'")
  }

  func testCodexStringEscapes() {
    func command(_ value: String) -> String? {
      Configs.codexCommandEntry(in: ["[mcp_servers.flockbot]", "command = \(value)"])?.command
    }
    XCTAssertEqual(command(#""/A\u0020B/\"q\"\\""#), #"/A B/"q"\"#)
    XCTAssertEqual(command(#""\U0001F411""#), "🐑")
    XCTAssertNil(command(#""\x41""#), "unknown escape")
    XCTAssertNil(command(#""\uD800""#), "not a scalar")
    XCTAssertNil(command(#""open"#), "unterminated")
    XCTAssertNil(command(#""a" "b""#), "trailing text")
    XCTAssertNil(command(#""""a""""#), "multi-line string")

    let path = "/Users/o\"neil\\x/flockbot-mcp"
    XCTAssertEqual(command(Configs.tomlString(path)), path)
  }

  func testCodexTablesWithMultilineStringsAreNeverRewritten() throws {
    let text = """
      [mcp_servers.flockbot]
      command = "/old/flockbot-mcp"
      description = \"\"\"
      command = "/inside/a/string"
      \"\"\"
      """
    try write(text, to: Configs.codexURL)

    XCTAssertNil(Configs.codexCommand())
    XCTAssertThrowsError(try Configs.repoint(.codex))
    XCTAssertEqual(try read(Configs.codexURL), text)
  }

  func testCodexStatusRecognizesItsOwnLineInATableItCannotRead() throws {
    try write(
      "[mcp_servers.flockbot]\n\(Configs.codexCommandLine())\nnote = '''\nx\n'''\n",
      to: Configs.codexURL)
    XCTAssertTrue(Configs.isConnected(.codex))
  }

  func testCodexRepointReplacesOnlyTheString() throws {
    try write(
      """
      [mcp_servers.flockbot]
      command   =  "/old/flockbot-mcp"   # moved
      enabled = false
      """, to: Configs.codexURL)

    try Configs.repoint(.codex)

    XCTAssertEqual(
      try read(Configs.codexURL),
      """
      [mcp_servers.flockbot]
      command   =  \(Configs.tomlString(Configs.helperPath))   # moved
      enabled = false
      """)
  }

  // MARK: Claude Code

  func testClaudeCodeRepointKeepsTheRestOfTheEntry() throws {
    let log = try installFakeClaude()
    try writeClaudeCodeEntry()

    try Configs.repoint(.claudeCode)

    let calls = try invocations(log)
    XCTAssertEqual(calls.map { Array($0.prefix(4)) }, [
      ["mcp", "remove", "--scope", "user"], ["mcp", "add-json", "--scope", "user"],
    ])
    XCTAssertEqual(try entry(in: calls[1]), [
      "type": "stdio", "command": Configs.helperPath, "env": ["A": "1"],
    ] as NSDictionary)
    XCTAssertFalse(FileManager.default.fileExists(atPath: Configs.claudeCodeBackupURL.path))
  }

  func testClaudeCodeRepointRestoresTheOriginalWhenAddingFails() throws {
    let log = try installFakeClaude()
    try writeClaudeCodeEntry()
    setenv("FAKE_CLAUDE_FAILED_ADDS", "1", 1)

    XCTAssertThrowsError(try Configs.repoint(.claudeCode)) { error in
      guard case ConfigError.commandFailed = error else { return XCTFail("\(error)") }
    }

    let calls = try invocations(log)
    XCTAssertEqual(calls.count, 3)
    XCTAssertEqual(try entry(in: calls[2]), originalClaudeCodeEntry as NSDictionary)
    XCTAssertFalse(FileManager.default.fileExists(atPath: Configs.claudeCodeBackupURL.path))
  }

  func testClaudeCodeRepointKeepsABackupWhenTheEntryIsLost() throws {
    _ = try installFakeClaude()
    try writeClaudeCodeEntry()
    setenv("FAKE_CLAUDE_FAILED_ADDS", "2", 1)

    XCTAssertThrowsError(try Configs.repoint(.claudeCode)) { error in
      guard case ConfigError.claudeCodeEntryLost(let path) = error else { return XCTFail("\(error)") }
      XCTAssertEqual(path, Configs.claudeCodeBackupURL.path)
    }

    XCTAssertEqual(try readJSON(Configs.claudeCodeBackupURL) as NSDictionary, originalClaudeCodeEntry as NSDictionary)
    XCTAssertEqual(try permissions(Configs.claudeCodeBackupURL), 0o600)
  }

  func testClaudeCodeWithoutTheCLIIsReported() throws {
    try XCTSkipIf(Configs.claudeCLI() != nil, "A claude command is installed outside the scratch home.")
    try writeClaudeCodeEntry()
    XCTAssertThrowsError(try Configs.repoint(.claudeCode)) { error in
      guard case ConfigError.claudeNotFound = error else { return XCTFail("\(error)") }
    }
  }

  // MARK: Moved app

  func testRepointMovedTakesOverOnlyFlockbotConnectors() throws {
    try XCTSkipUnless(Configs.isInstalledDurably, "The test runner isn't in an Applications folder.")
    let moved = "/Users/someone/Downloads/Flockbot.app/Contents/MacOS/flockbot-mcp"
    try writeJSON(["mcpServers": ["flockbot": ["command": moved]]], to: Configs.claudeDesktopURL)
    try write("[mcp_servers.flockbot]\ncommand = \"/usr/local/bin/someone-elses-server\"\n", to: Configs.codexURL)

    let results = Configs.repointMoved()

    XCTAssertEqual(results.map { $0.0 }, [.claudeDesktop])
    XCTAssertNoThrow(try results.first?.1.get())
    XCTAssertTrue(Configs.isConnected(.claudeDesktop))
    XCTAssertEqual(Configs.codexCommand(), "/usr/local/bin/someone-elses-server")
    XCTAssertTrue(Configs.repointMoved().isEmpty, "a second launch has nothing to change")
  }

  // MARK: Helpers

  let originalClaudeCodeEntry: [String: Any] = [
    "type": "stdio", "command": "/old/Flockbot.app/Contents/MacOS/flockbot-mcp", "env": ["A": "1"],
  ]

  func writeClaudeCodeEntry() throws {
    try writeJSON(
      ["projects": [:], "mcpServers": ["flockbot": originalClaudeCodeEntry]], to: Configs.claudeCodeURL)
  }

  /// A stand-in `claude` that records each call, one argument per line, and
  /// fails its first FAKE_CLAUDE_FAILED_ADDS `add-json` calls.
  func installFakeClaude() throws -> URL {
    let log = home.appendingPathComponent("claude-calls.log")
    let script = home.appendingPathComponent(".local/bin/claude")
    try write(
      """
      #!/bin/bash
      printf '%s\\n' "$@" >> "\(log.path)"
      echo '--' >> "\(log.path)"
      if [[ "$2" == add-json ]]; then
        count_file="\(home.path)/claude-adds"
        count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
        echo "$count" > "$count_file"
        if (( count <= ${FAKE_CLAUDE_FAILED_ADDS:-0} )); then echo "add failed" >&2; exit 1; fi
      fi
      """, to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    XCTAssertEqual(Configs.claudeCLI(), script.path)
    return log
  }

  func invocations(_ log: URL) throws -> [[String]] {
    try read(log).components(separatedBy: "--\n").dropLast().map {
      Array($0.components(separatedBy: "\n").dropLast())
    }
  }

  /// The JSON entry passed to an `add-json` call.
  func entry(in call: [String]) throws -> NSDictionary {
    XCTAssertEqual(Array(call.prefix(5)), ["mcp", "add-json", "--scope", "user", "flockbot"])
    return try XCTUnwrap(
      try JSONSerialization.jsonObject(with: Data(XCTUnwrap(call.last).utf8)) as? NSDictionary)
  }

  func write(_ text: String, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
  }

  func read(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }

  func writeJSON(_ value: [String: Any], to url: URL) throws {
    try write(String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self), to: url)
  }

  func readJSON(_ url: URL) throws -> [String: Any] {
    try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
  }

  func permissions(_ url: URL) throws -> Int {
    try XCTUnwrap(
      FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
  }
}
