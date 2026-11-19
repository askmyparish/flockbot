import Foundation

/// The bundled connector binary. It owns the Flocknote session, the Keychain
/// item and the assistants' settings; this app asks it for status, sign-in,
/// sign-out and changes to those settings.
enum Helper {
  static var url: URL {
    Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/flockbot-mcp")
  }

  struct Status: Decodable {
    let state: String
    let parish: String?
  }

  struct SignInReply: Decodable {
    let result: String
  }

  static func status() async throws -> Status {
    try JSONDecoder().decode(Status.self, from: try await run(["status"]))
  }

  static func signIn(parish: String, email: String, password: String) async throws -> String {
    let input = try JSONSerialization.data(withJSONObject: [
      "parish": parish, "email": email, "password": password,
    ])
    let output = try await run(["sign-in"], input: input)
    return try JSONDecoder().decode(SignInReply.self, from: output).result
  }

  static func forget() async throws {
    _ = try await run(["forget"])
  }

  struct AssistantState: Decodable {
    let connected: Bool
    /// Whether the assistant's command-line tool is installed.
    let commandLine: Bool
  }

  // The connector's replies, decoded strictly: a reply missing its parts is
  // a failure, never a success or an empty state.

  private struct ChangeReply: Decodable {
    let changed: Bool?
    let error: String?
  }

  private struct RepointReply: Decodable {
    struct Result: Decodable {
      let assistant: String
      /// Milliseconds since 1970.
      let changedAt: Double?
      let error: String?
    }
    let results: [Result]
  }

  static func assistants() async throws -> [Assistant: AssistantState] {
    try decodeAssistants(try await run(["assistants"]))
  }

  /// Adds or removes the assistant's `flockbot` entry. A failure carries a
  /// message to show the person.
  static func change(_ assistant: Assistant, connect: Bool) async throws {
    try decodeChange(try await run([connect ? "connect" : "disconnect", assistant.rawValue]))
  }

  /// Points entries left by a moved copy of the app at this one's connector,
  /// returning when each change was written, or why it failed.
  static func repoint() async throws -> [(Assistant, Result<Date, HelperError>)] {
    try decodeRepoint(try await run(["repoint"]))
  }

  /// Exactly one state per assistant, or a failure.
  static func decodeAssistants(_ data: Data) throws -> [Assistant: AssistantState] {
    try decoding {
      let states = try JSONDecoder().decode([String: AssistantState].self, from: data)
      guard Set(states.keys) == Set(Assistant.allCases.map(\.rawValue)) else {
        throw HelperError.failed
      }
      return Dictionary(
        uniqueKeysWithValues: states.compactMap { name, state in
          Assistant(rawValue: name).map { ($0, state) }
        })
    }
  }

  static func decodeChange(_ data: Data) throws {
    try decoding {
      let reply = try JSONDecoder().decode(ChangeReply.self, from: data)
      if let error = reply.error { throw HelperError.message(error) }
      guard reply.changed == true else { throw HelperError.failed }
    }
  }

  static func decodeRepoint(_ data: Data) throws -> [(Assistant, Result<Date, HelperError>)] {
    try decoding {
      try JSONDecoder().decode(RepointReply.self, from: data).results.map { result in
        guard let assistant = Assistant(rawValue: result.assistant) else {
          throw HelperError.failed
        }
        if let error = result.error { return (assistant, .failure(.message(error))) }
        guard let changedAt = result.changedAt else { throw HelperError.failed }
        return (assistant, .success(Date(timeIntervalSince1970: changedAt / 1000)))
      }
    }
  }

  /// Any reply this app can't read shows as the connector not responding,
  /// never as Foundation's description of the decoding error.
  private static func decoding<T>(_ body: () throws -> T) throws -> T {
    do {
      return try body()
    } catch let error as HelperError {
      throw error
    } catch {
      throw HelperError.failed
    }
  }

  /// Runs the helper once. Credentials go over stdin, never in arguments.
  /// Blocking pipe and exit waits happen off the main actor.
  static func run(_ arguments: [String], input: Data? = nil) async throws -> Data {
    let url = url
    return try await Task.detached {
      let process = Process()
      process.executableURL = url
      process.arguments = arguments
      let stdout = Pipe()
      let stdin = Pipe()
      process.standardOutput = stdout
      process.standardInput = stdin
      process.standardError = FileHandle.nullDevice
      do { try process.run() } catch { throw HelperError.failed }
      do {
        // The throwing write reports a helper that exited early (EPIPE; the
        // app ignores SIGPIPE) instead of raising an Objective-C exception.
        if let input { try stdin.fileHandleForWriting.write(contentsOf: input) }
        try stdin.fileHandleForWriting.close()
      } catch {
        process.terminate()
        process.waitUntilExit()
        throw HelperError.failed
      }
      // Read to the end before waiting, so a full pipe can't stall the helper.
      let data = stdout.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else { throw HelperError.failed }
      return data
    }.value
  }
}

enum HelperError: LocalizedError, Equatable {
  case failed
  case message(String)

  var errorDescription: String? {
    switch self {
    case .failed: "Flockbot's connector didn't respond. Try again."
    case .message(let text): text
    }
  }
}
