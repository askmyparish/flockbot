import Foundation

// `Flockbot --connect <assistant>` and `--disconnect <assistant>` change one
// assistant's entry without the window, for scripted setup and for trying it
// against a scratch HOME.
let arguments = CommandLine.arguments
for flag in ["--connect", "--disconnect"] {
  guard let index = arguments.firstIndex(of: flag) else { continue }
  let names = Assistant.allCases.map(\.rawValue).joined(separator: ", ")
  guard index + 1 < arguments.count, let assistant = Assistant(rawValue: arguments[index + 1])
  else {
    FileHandle.standardError.write(Data("Usage: Flockbot \(flag) <\(names)>\n".utf8))
    exit(2)
  }
  do {
    print(try flag == "--connect" ? Configs.connect(assistant) : Configs.disconnect(assistant))
    exit(0)
  } catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
  }
}

// Writing to a helper that already exited must fail the write, not end the app.
signal(SIGPIPE, SIG_IGN)
FlockbotApp.main()
