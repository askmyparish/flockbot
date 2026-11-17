import Foundation

/// The bundled connector binary. It owns the Flocknote session and the Keychain
/// item; this app only asks it for status, sign-in and sign-out.
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

enum HelperError: Error {
  case failed
}
