using System.Diagnostics;
using System.Reflection;
using Velopack;

namespace Flockbot;

/// Installs updates from the feed release.sh publishes, the way Sparkle does
/// on the Mac: downloaded quietly while the window is open, installed when it
/// closes. Installing replaces the folder the connector runs from, which ends
/// any connector an assistant is running; the assistant starts it again.
static class Updates
{
    static readonly string Feed = typeof(Updates).Assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .First(attribute => attribute.Key == "UpdateFeed").Value!;

    static readonly UpdateManager Manager = new(Feed);

    /// Whether this copy was installed by Flockbot's installer. A copy run from
    /// anywhere else can't update, and assistants shouldn't point at it.
    public static bool IsInstalled => Manager.IsInstalled;

    /// This copy's version: the installed release's, or for a copy run from
    /// a build folder, the version build.sh stamped on it.
    public static string Version =>
        Manager.CurrentVersion?.ToString()
        ?? typeof(Updates).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion.Split('+')[0]
        ?? "unknown";

    /// The version waiting to install when the window closes, if any.
    public static string? Ready => Manager.UpdatePendingRestart?.Version.ToString();

    /// Downloads a newer version, if there is one. Failures wait for the next
    /// launch: an update is never worth an error message.
    public static async Task Download()
    {
        if (!IsInstalled) return;
        try
        {
            var update = await Manager.CheckForUpdatesAsync();
            if (update != null) await Manager.DownloadUpdatesAsync(update);
        }
        catch (Exception error)
        {
            Debug.WriteLine($"Update check failed: {error.Message}");
        }
    }

    /// Hands a downloaded update to Velopack's updater, which installs it once
    /// this app has exited. The window stays closed afterwards.
    public static void InstallOnExit()
    {
        if (Manager.UpdatePendingRestart is not { } update) return;
        try
        {
            Manager.WaitExitThenApplyUpdates(update, silent: true, restart: false);
        }
        catch (Exception error)
        {
            Debug.WriteLine($"Update install failed: {error.Message}");
        }
    }
}
