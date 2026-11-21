using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace Flockbot;

/// The assistants this app can connect. The connector edits their settings
/// (see `Connector`); this type only knows how each one looks and runs.
enum Assistant { ClaudeDesktop, ClaudeCode, Codex }

static class AssistantInfo
{
    public static readonly Assistant[] All = Enum.GetValues<Assistant>();

    /// The connector's name for the assistant.
    public static string Id(this Assistant assistant) => assistant switch
    {
        Assistant.ClaudeDesktop => "claude-desktop",
        Assistant.ClaudeCode => "claude-code",
        _ => "codex",
    };

    public static Assistant? FromId(string id) => All.Cast<Assistant?>().FirstOrDefault(a => a!.Value.Id() == id);

    public static string Name(this Assistant assistant) => assistant switch
    {
        Assistant.ClaudeDesktop => "Claude Desktop",
        Assistant.ClaudeCode => "Claude Code",
        _ => "ChatGPT & Codex",
    };

    /// Package family prefixes of the Microsoft Store apps that read this
    /// assistant's settings. Claude Code borrows Claude's for its icon.
    static string[] Packages(this Assistant assistant) => assistant switch
    {
        Assistant.Codex => ["OpenAI.Codex_", "OpenAI.ChatGPT"],
        _ => ["Claude_"],
    };

    static string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    /// Whether the assistant is on this computer. The connector reports whether
    /// its command-line tool is installed.
    public static bool IsInstalled(this Assistant assistant, bool commandLine) => assistant switch
    {
        Assistant.ClaudeDesktop => PackageFolder(assistant) != null
            || Directory.Exists(Path.Combine(LocalAppData, "AnthropicClaude")),
        Assistant.ClaudeCode => commandLine,
        _ => PackageFolder(assistant) != null || commandLine,
    };

    /// A running app that started before `time`, and so still uses the
    /// settings from then. Claude Desktop isn't listed: the connector changes
    /// its settings only while it's closed. Claude Code reads them as each
    /// session starts.
    public static string? AppStartedBefore(this Assistant assistant, DateTime time)
    {
        if (assistant != Assistant.Codex) return null;
        foreach (var name in new[] { "ChatGPT", "Codex" })
            foreach (var process in Process.GetProcessesByName(name))
                using (process)
                {
                    try
                    {
                        // Only the Store app, not a codex command-line tool.
                        var path = process.MainModule?.FileName ?? "";
                        if (path.Contains(@"\WindowsApps\OpenAI.", StringComparison.OrdinalIgnoreCase)
                            && process.StartTime < time)
                            return "ChatGPT";
                    }
                    catch (Exception)
                    {
                        // Gone, or not ours to read.
                    }
                }
        return null;
    }

    /// Claude Desktop's install folder within a process path: the Store
    /// package or the standalone installer's. Claude Code's claude.exe lives
    /// elsewhere, as do Flockbot and the connectors Claude starts.
    static readonly Regex ClaudeDesktopFolder =
        new(@"\\(WindowsApps\\Claude_[^\\]+|AnthropicClaude)\\", RegexOptions.IgnoreCase);

    /// Running processes that would undo a change to this assistant's
    /// settings. Only Claude Desktop saves its in-memory copy over the file
    /// while open, so the connector changes its file only while it's closed.
    /// Every program in its install folder counts, so its helpers go with it.
    public static List<Process> AppsBlockingChange(this Assistant assistant)
    {
        var found = new List<Process>();
        if (assistant != Assistant.ClaudeDesktop) return found;
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (ClaudeDesktopFolder.IsMatch(process.MainModule?.FileName ?? ""))
                {
                    found.Add(process);
                    continue;
                }
            }
            catch (Exception)
            {
                // Gone, or not ours to read.
            }
            process.Dispose();
        }
        return found;
    }

    public static bool IsBlockedByOpenApp(this Assistant assistant)
    {
        var processes = assistant.AppsBlockingChange();
        processes.ForEach(process => process.Dispose());
        return processes.Count > 0;
    }

    /// Ends the processes and waits for them, returning whether they exited.
    /// Closing Claude's window only hides it in the system tray, so this stops
    /// it outright, which also keeps it from saving its old settings. Only the
    /// processes given: not their children, which can include this app when
    /// Claude's connector opened it for sign-in.
    public static async Task<bool> Quit(List<Process> processes)
    {
        try
        {
            foreach (var process in processes)
            {
                try
                {
                    process.Kill();
                }
                catch (InvalidOperationException)
                {
                    // Already exited.
                }
            }
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            foreach (var process in processes) await process.WaitForExitAsync(timeout.Token);
            return true;
        }
        catch (Exception error) when (error is OperationCanceledException or System.ComponentModel.Win32Exception)
        {
            // Still running, or not ours to stop.
            return false;
        }
        finally
        {
            processes.ForEach(process => process.Dispose());
        }
    }

    /// The Store app's own tile icon, if it's installed.
    public static ImageSource? Icon(this Assistant assistant)
    {
        var folder = PackageFolder(assistant);
        if (folder == null) return null;
        try
        {
            var logo = Directory
                .EnumerateFiles(folder, "Square44x44Logo*.png", SearchOption.AllDirectories)
                .OrderBy(path => path.Contains("targetsize-48") ? 0 : path.Contains("scale-200") ? 1 : 2)
                .FirstOrDefault();
            if (logo == null) return null;
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.UriSource = new Uri(logo);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// Where the newest installed Store package for the assistant lives.
    static string? PackageFolder(Assistant assistant)
    {
        using var packages = Registry.CurrentUser.OpenSubKey(
            @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages");
        if (packages == null) return null;
        return packages.GetSubKeyNames()
            .Where(name => assistant.Packages().Any(prefix => name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
            .OrderByDescending(name => name, StringComparer.OrdinalIgnoreCase)
            .Select(name =>
            {
                using var key = packages.OpenSubKey(name);
                return key?.GetValue("PackageRootFolder") as string;
            })
            .FirstOrDefault(folder => folder != null && Directory.Exists(folder));
    }
}
