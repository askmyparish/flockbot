import XCTest

@testable import Flockbot

/// The app's side of the connector's replies. A reply missing its parts must
/// fail rather than read as a success or as every assistant disconnected.
final class HelperTests: XCTestCase {
  func testAssistantsNeedsEveryAssistant() throws {
    let complete = """
      {"claude-desktop":{"connected":true,"commandLine":false},
       "claude-code":{"connected":false,"commandLine":true},
       "codex":{"connected":false,"commandLine":false}}
      """
    let states = try Helper.decodeAssistants(Data(complete.utf8))
    XCTAssertEqual(states[.claudeDesktop]?.connected, true)
    XCTAssertEqual(states[.claudeCode]?.commandLine, true)

    let unknown = complete.replacingOccurrences(
      of: "}}", with: #"},"someone-else":{"connected":true,"commandLine":true}}"#)
    for bad in [
      "{}", #"{"claude-desktop":{"connected":true,"commandLine":false}}"#, unknown,
      #"{"claude-desktop":{"connected":"yes"}}"#, "[]", "",
    ] {
      assertFails(try Helper.decodeAssistants(Data(bad.utf8)), bad)
    }
  }

  func testChangeNeedsAnOutcome() {
    XCTAssertNoThrow(try Helper.decodeChange(Data(#"{"changed":true}"#.utf8)))
    XCTAssertThrowsError(try Helper.decodeChange(Data(#"{"error":"Shown as is."}"#.utf8))) {
      XCTAssertEqual($0 as? HelperError, .message("Shown as is."))
    }
    for bad in ["{}", #"{"changed":false}"#, #"{"changed":"yes"}"#, "", "not json"] {
      assertFails(try Helper.decodeChange(Data(bad.utf8)), bad)
    }
  }

  func testRepointKeepsEachChangesOwnTime() throws {
    let reply = """
      {"results":[{"assistant":"claude-desktop","changedAt":1700000000500},
                  {"assistant":"codex","error":"Shown as is."}]}
      """
    let results = try Helper.decodeRepoint(Data(reply.utf8))
    XCTAssertEqual(results.map(\.0), [.claudeDesktop, .codex])
    XCTAssertEqual(try results[0].1.get(), Date(timeIntervalSince1970: 1_700_000_000.5))
    guard case .failure(let error) = results[1].1 else { return XCTFail("expected an error") }
    XCTAssertEqual(error, .message("Shown as is."))

    for bad in [
      #"{"results":[{"assistant":"codex"}]}"#,
      #"{"results":[{"assistant":"someone-else","changedAt":1}]}"#,
      #"{"results":[{"assistant":"codex","changedAt":"now"}]}"#,
      "{}",
    ] {
      assertFails(try Helper.decodeRepoint(Data(bad.utf8)), bad)
    }
  }

  /// A reply the app can't read must surface as the connector not responding.
  func assertFails<T>(
    _ expression: @autoclosure () throws -> T, _ reply: String, line: UInt = #line
  ) {
    XCTAssertThrowsError(try expression(), reply, line: line) {
      XCTAssertEqual($0 as? HelperError, .failed, reply, line: line)
    }
  }
}
