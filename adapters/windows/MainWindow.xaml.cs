using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Flockbot;

/// The one setup window: Flocknote sign-in and a row per assistant. Mirrors
/// the Mac app's window; the connector beside it does the actual work.
public partial class MainWindow : Window
{
    Connector.Status? status;
    bool @checked;
    HashSet<Assistant> installed = [];
    HashSet<Assistant> connected = [];
    Assistant? working;
    bool signingIn;
    bool signingOut;
    bool formFocused;
    /// Set after a sign-in in this window, to point the person back to their chat.
    bool justSignedIn;
    string? signOutError;
    readonly Dictionary<Assistant, string> errors = [];
    /// When this window last changed each assistant's settings.
    readonly Dictionary<Assistant, DateTime> changedAt = [];
    readonly Dictionary<Assistant, AssistantRow> rows = [];

    /// Set while launch repoints entries left by an older install location.
    bool repairing = true;
    /// Assistants keep the connector's full path, so only an installed copy
    /// connects them; a copy run from a download folder may not stay there.
    readonly bool installedCopy = Updates.IsInstalled;

    bool IsSignedIn => status?.State == "ready";
    /// One change at a time: signing in or out and connecting must not interleave.
    bool Busy => working != null || signingIn || signingOut || repairing;

    static readonly Dictionary<string, string> Messages = new()
    {
        ["credentials_rejected"] = "Flocknote didn't accept that email and password. Check both and try again.",
        ["password_unavailable"] =
            "Flocknote didn't offer password sign-in for that email. Logins that use an emailed code aren't supported yet.",
        ["unavailable"] = "Flocknote couldn't be reached. Wait a moment and try again.",
        ["invalid_parish"] = "Enter your parish's Flocknote address, such as yourparish.flocknote.com.",
        ["connection_changed"] = "This computer is already signed in to a different parish or login. Sign out first.",
        ["incomplete"] = "Enter your parish, email address and password.",
        ["failed"] = "Sign-in didn't complete. Try again.",
    };

    public MainWindow()
    {
        InitializeComponent();
        VersionLabel.Text = $"Version {Updates.Version}";
        foreach (var assistant in AssistantInfo.All)
        {
            var row = new AssistantRow(assistant);
            row.Button.Click += (_, _) => Toggle(assistant);
            rows[assistant] = row;
            AssistantRows.Children.Add(row.Root);
        }
        // Coming back from a chat, or from quitting an assistant, is when
        // things change, so recheck whenever the window comes forward.
        Activated += async (_, _) => { if (!repairing) await Refresh(); };
        Loaded += async (_, _) => await Start();
        Render();
    }

    async Task Start()
    {
        // An installed copy takes over entries an older location left behind.
        // Until this finishes, Busy keeps every other change waiting.
        if (installedCopy)
        {
            try
            {
                foreach (var (assistant, time, error) in await Connector.Repoint())
                    if (error != null) errors[assistant] = error;
                    else changedAt[assistant] = time!.Value;
            }
            catch (ConnectorException)
            {
                // The rows show the connector's state either way.
            }
        }
        repairing = false;
        await Refresh();
        await Updates.Download();
        Render();
    }

    /// Shows the window when the connector opens the app a second time.
    public void BringForward()
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    /// Counts status checks, so only the latest one updates the window.
    int refreshes;

    async Task Refresh()
    {
        // Checks overlap: coming forward starts one while a change's own is
        // running. An older check finishing last would show what was true
        // before the change, so its results are dropped.
        var refresh = ++refreshes;
        Connector.Status? latestStatus;
        try
        {
            latestStatus = await Connector.GetStatus();
        }
        catch (ConnectorException)
        {
            latestStatus = null;
        }
        Dictionary<Assistant, Connector.AssistantState>? states;
        try
        {
            states = await Connector.Assistants();
        }
        catch (ConnectorException)
        {
            // A connector that can't answer leaves the rows as they were
            // rather than showing every assistant as disconnected.
            states = null;
        }
        if (refresh != refreshes) return;
        status = latestStatus;
        @checked = true;
        if (!IsSignedIn) justSignedIn = false;
        if (!IsSignedIn && Parish.Text.Length == 0 && status?.Parish is { } parish) Parish.Text = parish;
        if (states != null)
        {
            installed = AssistantInfo.All.Where(a => a.IsInstalled(states[a].CommandLine)).ToHashSet();
            connected = AssistantInfo.All.Where(a => states[a].Connected).ToHashSet();
        }
        // A change is finished once the app that predates it has quit.
        foreach (var assistant in changedAt.Keys.ToList())
            if (assistant.AppStartedBefore(changedAt[assistant]) == null)
                changedAt.Remove(assistant);
        Render();
        if (SignInForm.IsVisible && !formFocused)
        {
            formFocused = true;
            (Parish.Text.Length == 0 ? (Control)Parish : Email).Focus();
        }
    }

    static Visibility Shown(bool shown) => shown ? Visibility.Visible : Visibility.Collapsed;

    bool Incomplete => Subdomain(Parish.Text).Length == 0 || Email.Text.Trim().Length == 0
        || Password.Password.Length == 0;

    void Render()
    {
        Checking.Visibility = Shown(!@checked);
        SignedInPanel.Visibility = Shown(@checked && IsSignedIn);
        ParishAddress.Text = $"{status?.Parish ?? "your parish"}.flocknote.com";
        SignOutButton.Content = signingOut ? "Signing Out…" : "Sign Out…";
        SignOutButton.IsEnabled = !Busy;
        SignedInHint.Visibility = Shown(IsSignedIn && justSignedIn);
        SignInForm.Visibility = Shown(@checked && !IsSignedIn);
        PasswordNote.Visibility = SignInForm.Visibility;
        SignInForm.IsEnabled = !signingIn;
        SigningIn.Visibility = Shown(signingIn);
        SignInButton.IsEnabled = !signingIn && !Incomplete;
        // Outside the sign-in states: a failed sign-out stays visible even
        // when the status check after it fails too.
        SignOutMessage.Text = signOutError;
        SignOutMessage.Visibility = Shown(signOutError != null);

        foreach (var (assistant, row) in rows)
        {
            var isInstalled = installed.Contains(assistant);
            var isConnected = connected.Contains(assistant);
            row.Update(
                isInstalled,
                isConnected,
                working == assistant,
                errors.GetValueOrDefault(assistant),
                changedAt.TryGetValue(assistant, out var time) ? assistant.AppStartedBefore(time) : null,
                enabled: isInstalled && !Busy && (isConnected || (IsSignedIn && installedCopy)));
        }

        string? footer = !installedCopy ? "Install Flockbot with its installer to connect your assistants."
            : Updates.Ready is { } version ? $"Flockbot {version} will install when you close this window."
            : !IsSignedIn ? null
            : connected.Count == 0 ? "Next, connect the assistants you use."
            : "Once connected, Flockbot does not need to stay open.";
        AssistantsFooter.Text = footer;
        AssistantsFooter.Visibility = Shown(footer != null);
    }

    void Field_Changed(object sender, RoutedEventArgs e) => Render();

    /// Accepts "yourparish", "yourparish.flocknote.com" or a pasted address.
    static string Subdomain(string text)
    {
        var value = text.Trim().ToLowerInvariant();
        var scheme = value.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0) value = value[(scheme + 3)..];
        return value.Split('.')[0].Split('/')[0];
    }

    async void SignIn_Click(object sender, RoutedEventArgs e)
    {
        if (Busy || Incomplete) return;
        signingIn = true;
        SignInMessage.Visibility = Visibility.Collapsed;
        Render();
        string result;
        try
        {
            result = await Connector.SignIn(Subdomain(Parish.Text), Email.Text.Trim(), Password.Password);
        }
        catch (ConnectorException)
        {
            result = "failed";
        }
        signingIn = false;
        if (result == "signed_in")
        {
            Password.Clear();
            await Refresh();
            justSignedIn = true;
            signOutError = null;
        }
        else
        {
            SignInMessage.Text = Messages.GetValueOrDefault(result, Messages["failed"]);
            SignInMessage.Visibility = Visibility.Visible;
            if (result == "credentials_rejected")
            {
                // Like the Windows sign-in screen: clear the password, keep the email.
                Password.Clear();
                Password.Focus();
            }
        }
        Render();
    }

    /// Signing out also disconnects every assistant, so nothing keeps starting
    /// a connector that has no sign-in to use. A failed sign-out leaves the
    /// sign-in, and every assistant, as they were.
    async void SignOut_Click(object sender, RoutedEventArgs e)
    {
        if (Busy) return;
        var text = "Sign out of Flocknote on this computer?";
        if (connected.Count > 0)
            text += connected.Contains(Assistant.ClaudeDesktop) && Assistant.ClaudeDesktop.IsBlockedByOpenApp()
                ? "\n\nFlockbot will also disconnect from your assistants, which quits Claude."
                : "\n\nFlockbot will also disconnect from your assistants.";
        if (MessageBox.Show(this, text, "Flockbot", MessageBoxButton.YesNo, MessageBoxImage.Question)
            != MessageBoxResult.Yes)
            return;
        signingOut = true;
        signOutError = null;
        Render();
        try
        {
            await Connector.Forget();
        }
        catch (ConnectorException)
        {
            signOutError = "Flockbot couldn't sign out. Try again.";
            signingOut = false;
            await Refresh();
            return;
        }
        // Each change keeps the moment it was written, so an assistant that
        // restarts while a later one is still being changed isn't flagged.
        foreach (var assistant in connected.ToList())
        {
            try
            {
                await QuitAppsBlockingChange(assistant);
                await Connector.Change(assistant, connect: false);
                errors.Remove(assistant);
                changedAt[assistant] = DateTime.Now;
            }
            catch (ConnectorException error)
            {
                errors[assistant] = error.Message;
            }
        }
        await Refresh();
        signingOut = false;
        formFocused = false;
        Render();
    }

    const string QuitFailed = "Claude didn't quit, so Flockbot left its settings alone. Try again.";

    /// Quits the app that would undo the change, if it's open.
    static async Task QuitAppsBlockingChange(Assistant assistant)
    {
        var processes = assistant.AppsBlockingChange();
        if (processes.Count > 0 && !await AssistantInfo.Quit(processes))
            throw new ConnectorException(QuitFailed);
    }

    async void Toggle(Assistant assistant)
    {
        if (Busy) return;
        var connecting = !connected.Contains(assistant);
        // Asks first when the change means quitting the assistant's app.
        if (assistant.IsBlockedByOpenApp())
        {
            var text = "Claude has to be closed while Flockbot changes its settings. "
                + "Any chat or Code session running in Claude will stop.";
            if (connecting) text += " Open Claude again to use Flockbot.";
            text += $"\n\nQuit Claude and {(connecting ? "connect" : "disconnect")}?";
            if (MessageBox.Show(this, text, "Quit Claude?", MessageBoxButton.YesNo, MessageBoxImage.Question)
                != MessageBoxResult.Yes)
                return;
        }
        working = assistant;
        errors.Remove(assistant);
        Render();
        try
        {
            await QuitAppsBlockingChange(assistant);
            await Connector.Change(assistant, connecting);
            changedAt[assistant] = DateTime.Now;
        }
        catch (ConnectorException error)
        {
            errors[assistant] = error.Message;
        }
        await Refresh();
        working = null;
        Render();
    }
}

/// One assistant's row: its icon, name, status and Connect button.
sealed class AssistantRow
{
    public readonly Grid Root = new() { Margin = new Thickness(0, 10, 0, 10) };
    public readonly Button Button = new() { MinWidth = 104, VerticalAlignment = VerticalAlignment.Center };
    readonly Assistant assistant;
    readonly TextBlock glyph = new()
    {
        FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"),
        Margin = new Thickness(0, 2, 6, 0),
    };
    readonly TextBlock text = new() { TextWrapping = TextWrapping.Wrap };

    public AssistantRow(Assistant assistant)
    {
        this.assistant = assistant;
        Root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Root.ColumnDefinitions.Add(new ColumnDefinition());
        Root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var icon = new Grid { Width = 32, Height = 32, VerticalAlignment = VerticalAlignment.Center };
        if (assistant.Icon() is { } image)
            icon.Children.Add(new Image { Source = image });
        else
            icon.Children.Add(new TextBlock
            {
                Text = "\uE71D",
                FontFamily = glyph.FontFamily,
                FontSize = 24,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            });
        // Claude Code shares Claude's icon; a terminal badge tells the rows apart.
        if (assistant == Assistant.ClaudeCode)
            icon.Children.Add(new Border
            {
                Width = 18,
                Height = 18,
                CornerRadius = new CornerRadius(4),
                Background = Brushes.Black,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
                Margin = new Thickness(0, 0, -4, -4),
                Child = new TextBlock
                {
                    Text = "\uE756",
                    FontFamily = glyph.FontFamily,
                    FontSize = 11,
                    Foreground = Brushes.White,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                },
            });
        Root.Children.Add(icon);

        var status = new DockPanel();
        DockPanel.SetDock(glyph, Dock.Left);
        status.Children.Add(glyph);
        status.Children.Add(text);
        var labels = new StackPanel { Margin = new Thickness(12, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center };
        labels.Children.Add(new TextBlock { Text = assistant.Name() });
        labels.Children.Add(status);
        Grid.SetColumn(labels, 1);
        Root.Children.Add(labels);

        Grid.SetColumn(Button, 2);
        Root.Children.Add(Button);
    }

    public void Update(bool installed, bool connected, bool working, string? error, string? restartApp, bool enabled)
    {
        Button.Content = connected ? "Disconnect" : "Connect";
        Button.IsEnabled = enabled;
        Root.Opacity = installed ? 1 : 0.55;
        var secondary = "TextFillColorSecondaryBrush";
        var (symbol, color, message, textColor) =
            working ? ("", secondary, connected ? "Disconnecting…" : "Connecting…", secondary)
            : error != null ? ("\uEA39", "SystemFillColorCriticalBrush", error, "SystemFillColorCriticalBrush")
            // Shown only while the app that predates the change is still running.
            : restartApp != null ? ("\uE72C", "SystemFillColorCautionBrush", $"Quit and reopen {restartApp} to finish", secondary)
            : !installed ? ("", secondary, "Not installed", secondary)
            : connected ? ("\uE73E", "SystemFillColorSuccessBrush", "Connected", secondary)
            : ("", secondary, "Not connected", secondary);
        glyph.Text = symbol;
        glyph.Visibility = symbol.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        glyph.SetResourceReference(TextBlock.ForegroundProperty, color);
        text.Text = message;
        text.SetResourceReference(TextBlock.ForegroundProperty, textColor);
    }
}
