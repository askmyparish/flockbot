using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Flockbot;

/// The connector installed beside this app. It owns the Flocknote session,
/// the Credential Manager entry and the assistants' settings; this app asks it
/// for status, sign-in, sign-out and changes to those settings.
static class Connector
{
    public static string Path => System.IO.Path.Combine(AppContext.BaseDirectory, "flockbot-mcp.exe");

    public record Status(string State, string? Parish);

    public record AssistantState(bool Connected, bool CommandLine);

    public static async Task<Status> GetStatus()
    {
        var reply = await Run(["status"]);
        return Read(() => new Status(
            reply.GetProperty("state").GetString() ?? throw new ConnectorException(),
            reply.GetProperty("parish").ValueKind == JsonValueKind.Null
                ? null
                : reply.GetProperty("parish").GetString()));
    }

    /// One of the connector's results, such as "signed_in" or "credentials_rejected".
    public static async Task<string> SignIn(string parish, string email, string password)
    {
        var input = JsonSerializer.SerializeToUtf8Bytes(new { parish, email, password });
        var reply = await Run(["sign-in"], input);
        return Read(() => reply.GetProperty("result").GetString() ?? throw new ConnectorException());
    }

    public static Task Forget() => RunText(["forget"]);

    /// Exactly one state per assistant, or a failure.
    public static async Task<Dictionary<Assistant, AssistantState>> Assistants()
    {
        var reply = await Run(["assistants"]);
        return Read(() =>
        {
            var states = new Dictionary<Assistant, AssistantState>();
            foreach (var property in reply.EnumerateObject())
            {
                var assistant = AssistantInfo.FromId(property.Name) ?? throw new ConnectorException();
                states[assistant] = new AssistantState(
                    property.Value.GetProperty("connected").GetBoolean(),
                    property.Value.GetProperty("commandLine").GetBoolean());
            }
            if (states.Count != AssistantInfo.All.Length) throw new ConnectorException();
            return states;
        });
    }

    /// Adds or removes the assistant's `flockbot` entry. A failure carries a
    /// message to show the person.
    public static async Task Change(Assistant assistant, bool connect)
    {
        var reply = await Run([connect ? "connect" : "disconnect", assistant.Id()]);
        Read(() =>
        {
            if (reply.TryGetProperty("error", out var error))
                throw new ConnectorException(error.GetString());
            if (!reply.GetProperty("changed").GetBoolean()) throw new ConnectorException();
            return true;
        });
    }

    /// Points entries left by an older install location at this connector,
    /// returning when each change was made, or why it failed.
    public static async Task<List<(Assistant Assistant, DateTime? ChangedAt, string? Error)>> Repoint()
    {
        var reply = await Run(["repoint"]);
        return Read(() => reply.GetProperty("results").EnumerateArray().Select(result =>
        {
            var assistant = AssistantInfo.FromId(result.GetProperty("assistant").GetString() ?? "")
                ?? throw new ConnectorException();
            if (result.TryGetProperty("error", out var error))
                return (assistant, (DateTime?)null, error.GetString() ?? throw new ConnectorException());
            var changedAt = DateTimeOffset.FromUnixTimeMilliseconds(result.GetProperty("changedAt").GetInt64());
            return (assistant, (DateTime?)changedAt.LocalDateTime, (string?)null);
        }).ToList());
    }

    /// Velopack's uninstall hook has 30 seconds in all; leave it room to exit.
    static readonly TimeSpan UninstallDeadline = TimeSpan.FromSeconds(25);

    /// Before uninstalling, forgets the saved sign-in and removes every
    /// assistant entry, in that order, with one connector command. Nothing
    /// can be shown during an uninstall, and it goes ahead either way.
    public static void CleanUpBeforeUninstall()
    {
        try
        {
            var start = new ProcessStartInfo(Path)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
            };
            start.ArgumentList.Add("uninstall");
            using var process = Process.Start(start);
            if (process == null) return;
            process.StandardInput.Close();
            _ = process.StandardOutput.ReadToEndAsync();
            if (!process.WaitForExit(UninstallDeadline)) process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
            // Too late to tell anyone; the uninstall continues.
        }
    }

    /// Any reply this app can't read shows as the connector not responding.
    static T Read<T>(Func<T> body)
    {
        try
        {
            return body();
        }
        catch (ConnectorException)
        {
            throw;
        }
        catch (Exception)
        {
            throw new ConnectorException();
        }
    }

    static async Task<JsonElement> Run(string[] arguments, byte[]? input = null)
    {
        var text = await RunText(arguments, input);
        return Read(() =>
        {
            using var document = JsonDocument.Parse(text);
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new ConnectorException();
            return document.RootElement.Clone();
        });
    }

    /// Runs the connector once. Credentials go over stdin, never in arguments.
    static async Task<string> RunText(string[] arguments, byte[]? input = null)
    {
        var start = new ProcessStartInfo(Path)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        Process process;
        try
        {
            process = Process.Start(start) ?? throw new ConnectorException();
        }
        catch (Exception error) when (error is not ConnectorException)
        {
            throw new ConnectorException();
        }
        using (process)
        {
            // Read while writing, so a full pipe can't stall either side.
            var output = process.StandardOutput.ReadToEndAsync();
            try
            {
                if (input != null) await process.StandardInput.BaseStream.WriteAsync(input);
                process.StandardInput.Close();
            }
            catch (IOException)
            {
                // A connector that exited early fails on its exit code below.
            }
            var text = await output;
            await process.WaitForExitAsync();
            if (process.ExitCode != 0) throw new ConnectorException();
            return text;
        }
    }
}

class ConnectorException(string? message = null)
    : Exception(message ?? "Flockbot's connector didn't respond. Try again.");
