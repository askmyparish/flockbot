import XCTest

@testable import Flockbot

/// Moving the app into Applications, against scratch folders. The connector's
/// own tests cover the assistants' settings (test/mcp/assistants.test.ts).
final class InstallTests: XCTestCase {
  var scratch: URL!

  override func setUpWithError() throws {
    scratch = FileManager.default.temporaryDirectory
      .appendingPathComponent("flockbot-tests-\(UUID().uuidString)").resolvingSymlinksInPath()
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try FileManager.default.removeItem(at: scratch)
  }

  func testMoveToApplicationsReplacesAnOlderCopyAndClearsQuarantine() throws {
    let source = try fakeApp(at: scratch.appendingPathComponent("Downloads/Flockbot.app"), version: "new")
    XCTAssertEqual(xattr(["-w", "com.apple.quarantine", "0081;0;Safari;", source.path]), 0)
    let applications = scratch.appendingPathComponent("Applications")
    _ = try fakeApp(at: applications.appendingPathComponent("Flockbot.app"), version: "old")

    let copy = try Install.moveToApplications(from: source, into: [applications])

    XCTAssertEqual(copy.path, applications.appendingPathComponent("Flockbot.app").path)
    XCTAssertEqual(try read(copy.appendingPathComponent("Contents/version")), "new")
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: applications.path), ["Flockbot.app"],
      "no staging copy is left behind")
    XCTAssertNotEqual(
      xattr(["-p", "com.apple.quarantine", copy.path]), 0,
      "the copy must not be translocated again")
  }

  func testMoveToApplicationsFallsBackWhenTheSharedFolderIsReadOnly() throws {
    let source = try fakeApp(at: scratch.appendingPathComponent("Downloads/Flockbot.app"), version: "new")
    let shared = scratch.appendingPathComponent("Shared Applications")
    let existing = try fakeApp(at: shared.appendingPathComponent("Flockbot.app"), version: "old")
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: shared.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: shared.path) }
    let personal = scratch.appendingPathComponent("Applications")

    let copy = try Install.moveToApplications(from: source, into: [shared, personal])

    XCTAssertEqual(copy.path, personal.appendingPathComponent("Flockbot.app").path)
    XCTAssertEqual(try read(existing.appendingPathComponent("Contents/version")), "old")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: shared.path), ["Flockbot.app"])
  }

  // MARK: Helpers

  func fakeApp(at url: URL, version: String) throws -> URL {
    let file = url.appendingPathComponent("Contents/version")
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try version.write(to: file, atomically: true, encoding: .utf8)
    return url
  }

  func read(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }

  /// Runs /usr/bin/xattr quietly and returns its exit status.
  func xattr(_ arguments: [String]) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return -1 }
    process.waitUntilExit()
    return process.terminationStatus
  }
}
