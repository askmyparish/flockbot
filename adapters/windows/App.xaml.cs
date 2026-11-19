using System.Runtime.InteropServices;
using System.Windows;
using Velopack;

namespace Flockbot;

/// Flockbot is a setup window, not a background app: closing it quits.
/// Assistants start the connector beside it themselves when they need it.
public partial class App : Application
{
    [STAThread]
    static void Main()
    {
        // First: the installer and updater run this exe with arguments that
        // Run() handles and then exits on.
        VelopackApp.Build()
            // A launch while the window is open, such as the connector asking
            // for sign-in, must not install an update: that would end the open
            // window and every running connector. The open window installs
            // updates as it closes (see OnExit).
            .SetAutoApplyOnStartup(false)
            .OnBeforeUninstallFastCallback(_ => Connector.CleanUpBeforeUninstall())
            .Run();
        var app = new App();
        app.InitializeComponent();
        app.Run();
    }

    // Per sign-in session, so each person on the computer gets their own window.
    const string Name = @"Local\com.askmyparish.flockbot";
    Mutex? instance;
    /// Whether this copy owns the window, rather than handing off to one.
    bool primary;

    protected override void OnExit(ExitEventArgs e)
    {
        if (primary) Updates.InstallOnExit();
        base.OnExit(e);
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        instance = new Mutex(true, Name, out primary);
        var show = new EventWaitHandle(false, EventResetMode.AutoReset, Name + ".show");
        if (!primary)
        {
            // The connector opens the app when an assistant needs sign-in. A
            // window that's already open comes forward instead of a second one.
            AllowSetForegroundWindow(AnyProcess);
            show.Set();
            Shutdown();
            return;
        }
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
        new Thread(() =>
        {
            while (show.WaitOne()) Dispatcher.Invoke(window.BringForward);
        }) { IsBackground = true }.Start();
    }

    const int AnyProcess = -1;

    [DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(int processId);
}
