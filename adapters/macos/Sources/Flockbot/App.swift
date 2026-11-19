import AppKit
import Sparkle
import SwiftUI

/// Flockbot is a setup window, not a background app: closing it quits.
/// Assistants launch the bundled connector themselves when they need it.
final class AppDelegate: NSObject, NSApplicationDelegate {
  /// Sparkle checks the feed named in Info.plist and installs signed updates in
  /// place, so assistants' entries keep pointing at the same connector. Builds
  /// without an update signing key have no feed and run without an updater.
  let updater: SPUStandardUpdaterController? =
    Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") == nil
    ? nil
    : SPUStandardUpdaterController(
      startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct FlockbotApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @StateObject private var model = AppModel()

  var body: some Scene {
    Window("Flockbot", id: "main") {
      ContentView(model: model)
        // The connector reopens the app when an assistant needs sign-in.
        .onReceive(
          NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
        ) { _ in
          Task { await model.refresh() }
        }
    }
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentSize)
    .commands {
      CommandGroup(replacing: .newItem) {}
      if let updater = delegate.updater {
        CommandGroup(after: .appInfo) {
          CheckForUpdatesButton(updater: updater.updater)
        }
      }
      CommandGroup(replacing: .help) {
        Button("Flockbot Support") {
          NSWorkspace.shared.open(URL(string: "https://github.com/askmyparish/flockbot/issues")!)
        }
      }
    }
  }
}

/// A SwiftUI menu item skips Sparkle's AppKit menu validation, so it follows
/// `canCheckForUpdates` itself and stays disabled while a check is running.
final class UpdateAvailability: ObservableObject {
  @Published var canCheck = false

  init(_ updater: SPUUpdater) {
    updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
  }
}

struct CheckForUpdatesButton: View {
  @ObservedObject private var availability: UpdateAvailability
  private let updater: SPUUpdater

  init(updater: SPUUpdater) {
    self.updater = updater
    availability = UpdateAvailability(updater)
  }

  var body: some View {
    Button("Check for Updates…", action: updater.checkForUpdates)
      .disabled(!availability.canCheck)
  }
}

@MainActor
final class AppModel: ObservableObject {
  @Published var status: Helper.Status?
  @Published var checked = false
  @Published var installed: Set<Assistant> = []
  @Published var connected: Set<Assistant> = []
  @Published var working: Assistant?
  @Published var signingOut = false
  /// Set while launch repoints entries left by a moved copy of the app.
  @Published var repairing = true
  @Published var signOutError: String?
  /// Assistants keep the connector's full path, so only a copy in an
  /// Applications folder connects them (see `Install.isInstalledDurably`).
  let installedDurably = Install.isInstalledDurably
  @Published var moving = false
  @Published var moveError: String?
  @Published var errors: [Assistant: String] = [:]
  /// When this window last changed each assistant's configuration.
  @Published var changedAt: [Assistant: Date] = [:]
  /// Set after a sign-in in this window, to point the person back to their chat.
  @Published var justSignedIn = false
  private var terminationObserver: NSObjectProtocol?

  init() {
    // Quitting an assistant is what finishes a change, so recheck then.
    terminationObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.forgetFinishedChanges() }
    }
    Task {
      // A moved or renamed app leaves assistants pointing at the old copy.
      // Until this finishes, busy keeps every other change waiting.
      // Only a copy that will stay takes over the entries.
      if installedDurably {
        for (assistant, result) in (try? await Helper.repoint()) ?? [] {
          switch result {
          case .success(let date): changedAt[assistant] = date
          case .failure(let error): errors[assistant] = error.localizedDescription
          }
        }
        forgetFinishedChanges()
      }
      await refresh()
      repairing = false
    }
  }

  /// The assistant app still running with the configuration from before
  /// this window changed it, if any.
  func appNeedingRestart(_ assistant: Assistant) -> NSRunningApplication? {
    changedAt[assistant].flatMap { assistant.appLaunched(before: $0) }
  }

  private func forgetFinishedChanges() {
    changedAt = changedAt.filter { $0.key.appLaunched(before: $0.value) != nil }
  }

  var signedIn: Bool { status?.state == "ready" }
  /// One change at a time: sign-out and connecting must not interleave.
  var busy: Bool { working != nil || signingOut || repairing || moving }

  /// Copies the app into Applications, opens that copy and quits. The copy
  /// here goes to the Trash when it can; a disk image or a translocated
  /// download is read-only, so that one stays.
  func moveToApplications() {
    guard !busy else { return }
    moving = true
    moveError = nil
    Task {
      do {
        let copy = try await Task.detached { try Install.moveToApplications() }.value
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        try await NSWorkspace.shared.openApplication(at: copy, configuration: configuration)
        try? FileManager.default.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)
        NSApp.terminate(nil)
      } catch {
        moveError = "Flockbot couldn't move to Applications. Drag it there in Finder instead."
        moving = false
      }
    }
  }

  func refresh() async {
    status = try? await Helper.status()
    checked = true
    if !signedIn { justSignedIn = false }
    // A connector that can't answer leaves the rows as they were rather than
    // showing every assistant as disconnected.
    guard let states = try? await Helper.assistants() else { return }
    installed = Set(
      Assistant.allCases.filter { $0.isInstalled(commandLine: states[$0]?.commandLine ?? false) })
    connected = Set(Assistant.allCases.filter { states[$0]?.connected ?? false })
  }

  /// Signing out also disconnects every assistant, so nothing keeps
  /// starting a connector that has no sign-in to use.
  /// A failed sign-out leaves the sign-in, and every assistant, as they were.
  func signOut() {
    guard !busy else { return }
    signingOut = true
    signOutError = nil
    Task {
      defer { signingOut = false }
      do {
        try await Helper.forget()
      } catch {
        signOutError = "Flockbot couldn't sign out. Try again."
        await refresh()
        return
      }
      // Each change keeps the moment it was written, so an assistant that
      // restarts while a later one is still being changed isn't flagged.
      for assistant in connected {
        do {
          try await Helper.change(assistant, connect: false)
          errors[assistant] = nil
          changedAt[assistant] = Date()
        } catch {
          errors[assistant] = error.localizedDescription
        }
      }
      forgetFinishedChanges()
      await refresh()
    }
  }

  func toggle(_ assistant: Assistant) {
    guard !busy else { return }
    let connecting = !connected.contains(assistant)
    working = assistant
    errors[assistant] = nil
    Task {
      do {
        try await Helper.change(assistant, connect: connecting)
        changedAt[assistant] = Date()
        forgetFinishedChanges()
      } catch {
        errors[assistant] = error.localizedDescription
      }
      await refresh()
      working = nil
    }
  }
}

struct ContentView: View {
  @ObservedObject var model: AppModel
  @State private var confirmingSignOut = false

  var body: some View {
    VStack(spacing: 0) {
      header
      Form {
        if !model.installedDurably {
          Section { install }
        }
        Section {
          flocknote
        } header: {
          Text("Flocknote")
        } footer: {
          if model.checked && !model.signedIn {
            Label(
              "Your password is sent only to Flocknote and is never saved.",
              systemImage: "lock.fill"
            )
            .modifier(FooterStyle())
          }
        }
        Section {
          ForEach(Assistant.allCases) { AssistantRow(model: model, assistant: $0) }
        } header: {
          Text("Assistants")
        } footer: {
          if let assistantsFooter {
            Text(assistantsFooter)
              .font(.callout)
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity)
          }
        }
      }
      .formStyle(.grouped)
      // Let the window background show through so header, form and footer share one surface.
      .scrollContentBackground(.hidden)
      .scrollDisabled(true)
      .fixedSize(horizontal: false, vertical: true)
      Text("Flockbot is independent and not affiliated with Flocknote.")
        .font(.footnote)
        .foregroundStyle(.tertiary)
        .padding(.bottom, 18)
    }
    .frame(width: 480)
    .confirmationDialog(
      "Sign out of Flocknote on this Mac?", isPresented: $confirmingSignOut,
      titleVisibility: .visible
    ) {
      Button("Sign Out", role: .destructive) { model.signOut() }
    } message: {
      if !model.connected.isEmpty {
        Text("Flockbot will also disconnect from your assistants.")
      }
    }
  }

  private var header: some View {
    VStack(spacing: 6) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .frame(width: 96, height: 96)
      Text("Flockbot").font(.title.weight(.semibold))
      Text("Connect your parish Flocknote to Claude and ChatGPT.")
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    // The hidden title bar already leaves room for the window buttons.
    .padding(.top, 4)
    .padding(.horizontal, 24)
  }

  @ViewBuilder private var install: some View {
    HStack(spacing: 12) {
      Image(systemName: "arrow.down.app.fill")
        .font(.title2)
        .foregroundStyle(.blue)
      VStack(alignment: .leading, spacing: 2) {
        Text("Move Flockbot to Applications")
        Text("Your assistants can only connect to Flockbot there.")
          .font(.callout)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
      Button(model.moving ? "Moving…" : "Move") { model.moveToApplications() }
        .disabled(model.busy)
    }
    if let error = model.moveError {
      Label {
        Text(error).foregroundStyle(.red)
      } icon: {
        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
      }
    }
  }

  private var assistantsFooter: String? {
    if !model.signedIn || !model.installedDurably { return nil }
    if model.connected.isEmpty { return "Next, connect the assistants you use." }
    return "Once connected, Flockbot does not need to stay open."
  }

  @ViewBuilder private var flocknote: some View {
    if !model.checked {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Checking sign-in…").foregroundStyle(.secondary)
      }
    } else if model.signedIn {
      HStack(spacing: 12) {
        Image(systemName: "checkmark.circle.fill")
          .font(.title2)
          .foregroundStyle(.green)
        VStack(alignment: .leading, spacing: 2) {
          Text("Signed in")
          Text("\(model.status?.parish ?? "your parish").flocknote.com")
            .font(.callout)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button(model.signingOut ? "Signing Out…" : "Sign Out…") { confirmingSignOut = true }
          .disabled(model.busy)
      }
      if model.justSignedIn {
        Label(
          "If Claude or ChatGPT sent you here, go back to your chat to continue.",
          systemImage: "arrow.uturn.backward.circle"
        )
        .foregroundStyle(.secondary)
      }
    } else {
      SignInFields(model: model, parish: model.status?.parish ?? "")
    }
    // Outside the branches: a failed sign-out stays visible even when the
    // status check after it fails too.
    if let error = model.signOutError {
      Label {
        Text(error).foregroundStyle(.red)
      } icon: {
        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
      }
    }
  }
}

struct FooterStyle: ViewModifier {
  func body(content: Content) -> some View {
    content
      .font(.callout)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      // Line up with the text inside the section's card, like the section headers.
      .padding(.horizontal, 10)
  }
}

struct AssistantRow: View {
  @ObservedObject var model: AppModel
  let assistant: Assistant

  private var installed: Bool { model.installed.contains(assistant) }
  private var connected: Bool { model.connected.contains(assistant) }
  private var working: Bool { model.working == assistant }

  var body: some View {
    HStack(spacing: 12) {
      icon
      VStack(alignment: .leading, spacing: 2) {
        Text(assistant.name)
        status
      }
      Spacer()
      Button(connected ? "Disconnect" : "Connect") { model.toggle(assistant) }
        .disabled(
          !installed || model.busy
            || (!connected && (!model.signedIn || !model.installedDurably)))
    }
    .opacity(installed ? 1 : 0.55)
  }

  @ViewBuilder private var status: some View {
    Group {
      if working {
        Text(connected ? "Disconnecting…" : "Connecting…")
      } else if let error = model.errors[assistant] {
        Label {
          Text(error).foregroundStyle(.red)
        } icon: {
          Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
        }
      } else if let app = model.appNeedingRestart(assistant) {
        // Shown only while the app that predates the change is still running.
        Label {
          Text("Quit and reopen \(app.localizedName ?? assistant.name) to finish")
        } icon: {
          Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(.orange)
        }
      } else if !installed {
        Text("Not installed")
      } else if connected {
        Label {
          Text("Connected")
        } icon: {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        }
      } else {
        Text("Not connected")
      }
    }
    .font(.callout)
    .foregroundStyle(.secondary)
  }

  private var icon: some View {
    Group {
      if let image = assistant.icon {
        Image(nsImage: image).resizable()
      } else {
        Image(systemName: "app.dashed").resizable().foregroundStyle(.tertiary).padding(4)
      }
    }
    .frame(width: 32, height: 32)
    // Claude Code shares Claude's icon; a terminal badge tells the rows apart.
    .overlay(alignment: .bottomTrailing) {
      if assistant == .claudeCode {
        Image(nsImage: NSWorkspace.shared.icon(forFile: "/System/Applications/Utilities/Terminal.app"))
          .resizable()
          .frame(width: 18, height: 18)
          .offset(x: 4, y: 4)
      }
    }
  }
}

struct SignInFields: View {
  @ObservedObject var model: AppModel
  @State private var parish: String
  @State private var email = ""
  @State private var password = ""
  @State private var busy = false
  @State private var message: String?
  @State private var rejections = 0
  @FocusState private var focus: Field?

  enum Field { case parish, email, password }

  init(model: AppModel, parish: String) {
    self.model = model
    _parish = State(initialValue: parish)
  }

  private static let messages = [
    "credentials_rejected":
      "Flocknote didn't accept that email and password. Check both and try again.",
    "password_unavailable":
      "Flocknote didn't offer password sign-in for that email. Logins that use an emailed code aren't supported yet.",
    "unavailable": "Flocknote couldn't be reached. Wait a moment and try again.",
    "invalid_parish": "Enter your parish's Flocknote address, such as yourparish.flocknote.com.",
    "connection_changed":
      "This Mac is already signed in to a different parish or login. Sign out first.",
    "incomplete": "Enter your parish, email address and password.",
    "failed": "Sign-in didn't complete. Try again.",
  ]

  private var incomplete: Bool {
    Self.subdomain(parish).isEmpty || email.trimmingCharacters(in: .whitespaces).isEmpty
      || password.isEmpty
  }

  var body: some View {
    Group {
      LabeledContent("Parish") {
        HStack(spacing: 2) {
          TextField("Parish", text: $parish, prompt: Text("yourparish"))
            .labelsHidden()
            .multilineTextAlignment(.trailing)
            .focused($focus, equals: .parish)
          Text(".flocknote.com").foregroundStyle(.secondary)
        }
      }
      TextField("Email", text: $email, prompt: Text("you@example.org"))
        .textContentType(.username)
        .focused($focus, equals: .email)
      SecureField("Password", text: $password, prompt: Text("Required"))
        .textContentType(.password)
        .focused($focus, equals: .password)
        .onSubmit { if !busy && !incomplete { submit() } }
        .modifier(Shake(animatableData: CGFloat(rejections)))
      if let message {
        Label {
          Text(message).fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
      }
      HStack(spacing: 8) {
        if busy {
          ProgressView().controlSize(.small)
          Text("Signing in…").foregroundStyle(.secondary)
        }
        Spacer()
        Button("Sign In") { submit() }
          .keyboardShortcut(.defaultAction)
          .disabled(busy || incomplete)
      }
    }
    .disabled(busy)
    .onAppear { focus = parish.isEmpty ? .parish : .email }
  }

  /// Accepts "yourparish", "yourparish.flocknote.com" or a pasted address.
  static func subdomain(_ text: String) -> String {
    var value = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if let range = value.range(of: "://") { value = String(value[range.upperBound...]) }
    return String(value.split(separator: ".").first ?? "")
  }

  private func submit() {
    busy = true
    message = nil
    let parish = Self.subdomain(parish)
    let email = email.trimmingCharacters(in: .whitespaces)
    let password = password
    Task { @MainActor in
      let result =
        (try? await Helper.signIn(parish: parish, email: email, password: password)) ?? "failed"
      busy = false
      if result == "signed_in" {
        self.password = ""
        await model.refresh()
        model.justSignedIn = true
        model.signOutError = nil
      } else {
        message = Self.messages[result] ?? Self.messages["failed"]
        if result == "credentials_rejected" {
          // Like the Mac login window: shake, clear the password, keep the email.
          self.password = ""
          withAnimation(.linear(duration: 0.4)) { rejections += 1 }
          focus = .password
        }
      }
    }
  }
}

/// A horizontal shake, one per change of `animatableData`.
struct Shake: GeometryEffect {
  var animatableData: CGFloat

  func effectValue(size: CGSize) -> ProjectionTransform {
    ProjectionTransform(
      CGAffineTransform(translationX: 8 * sin(animatableData * .pi * 6), y: 0))
  }
}
