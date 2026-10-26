using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace BigFishBridge;

public sealed class ModConfig
{
    public int Port { get; set; } = 45931;
    public string Token { get; set; } = "";
}

public sealed class RemoteCommand
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
}

public sealed class ModEntry : Mod
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private readonly ConcurrentQueue<RemoteCommand> incoming = new();
    private HttpClient? client;
    private ModConfig config = new();
    private RemoteCommand? active;
    private DateTime movementStarted;
    private bool polling;
    private bool posting;
    private string lastPolledId = "";

    public override void Entry(IModHelper helper)
    {
        config = helper.ReadConfig<ModConfig>();
        if (config.Port < 1024 || config.Port > 65535 || config.Token.Length < 16 ||
            config.Token == "replace-with-a-random-secret")
        {
            Monitor.Log("Set Port and a random 16+ character Token in Mods/BigFishBridge/config.json first.", LogLevel.Warn);
            return;
        }
        client = new HttpClient
        {
            BaseAddress = new Uri("http://127.0.0.1:" + config.Port),
            Timeout = TimeSpan.FromSeconds(3)
        };
        client.DefaultRequestHeaders.Add("x-bigfish-token", config.Token);
        helper.Events.GameLoop.UpdateTicked += OnTick;
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => {
            active = null;
            while (incoming.TryDequeue(out _)) { }
            lastPolledId = "";
        };
        Monitor.Log("BigFish loopback bridge enabled. Use a backup save for testing.", LogLevel.Info);
    }

    private void OnTick(object? sender, UpdateTickedEventArgs e)
    {
        if (client == null || !Context.IsWorldReady || !Context.IsMainPlayer)
            return;
        if (e.IsMultipleOf(40) && !posting)
        {
            // Game API access stays on the game's update thread.
            var snapshot = Snapshot();
            posting = true;
            _ = PostStateAsync(snapshot);
        }
        if (e.IsMultipleOf(12) && !polling)
        {
            polling = true;
            _ = PollAsync();
        }
        if (active != null)
        {
            if (Game1.player.getTileX() == active.X && Game1.player.getTileY() == active.Y)
            {
                Finish(active, true, "reached target");
            }
            else if ((DateTime.UtcNow - movementStarted).TotalSeconds > 10 ||
                     Game1.player.controller == null)
            {
                Game1.player.controller = null;
                Finish(active, false, "path not found or movement timed out");
            }
            return;
        }
        if (!incoming.TryDequeue(out var cmd)) return;
        if (Game1.activeClickableMenu != null || Game1.eventUp)
        {
            Finish(cmd, false, "game menu or event is active");
            return;
        }
        Execute(cmd);
    }

    private object Snapshot()
    {
        var loc = Game1.player.currentLocation;
        var crops = new List<object>();
        if (loc.Name == "Farm")
        {
            foreach (var pair in loc.terrainFeatures.Pairs)
            {
                if (pair.Value is HoeDirt dirt && dirt.crop != null)
                {
                    crops.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y, watered = dirt.state.Value == 1 });
                    if (crops.Count >= 200) break;
                }
            }
        }
        return new
        {
            saveId = Game1.player.farmName.Value,
            location = loc.Name,
            day = Game1.dayOfMonth,
            season = Game1.currentSeason,
            time = Game1.timeOfDay,
            energy = (double)Game1.player.Stamina,
            x = Game1.player.getTileX(),
            y = Game1.player.getTileY(),
            paused = Game1.activeClickableMenu != null || Game1.eventUp || !Game1.shouldTimePass(),
            crops
        };
    }

    private void Execute(RemoteCommand cmd)
    {
        var player = Game1.player;
        var loc = player.currentLocation;
        if (loc.Name != "Farm" || cmd.X < 0 || cmd.Y < 0 || cmd.X > 150 || cmd.Y > 150)
        {
            Finish(cmd, false, "only in-bounds Farm actions are allowed");
            return;
        }
        try
        {
            if (cmd.Type == "move_to")
            {
                if (player.getTileX() == cmd.X && player.getTileY() == cmd.Y)
                {
                    Finish(cmd, true, "already there");
                    return;
                }
                player.controller = new PathFindController(player, loc, new Point(cmd.X, cmd.Y), 2, false);
                movementStarted = DateTime.UtcNow;
                active = cmd;
                return;
            }
            if (cmd.Type == "water_tile")
            {
                if (player.Stamina < 5 || Math.Abs(player.getTileX() - cmd.X) > 1 ||
                    Math.Abs(player.getTileY() - cmd.Y) > 1)
                {
                    Finish(cmd, false, "too far or energy too low");
                    return;
                }
                var tile = new Vector2(cmd.X, cmd.Y);
                if (!loc.terrainFeatures.TryGetValue(tile, out var feature) ||
                    feature is not HoeDirt dirt || dirt.crop == null)
                {
                    Finish(cmd, false, "target is not planted soil");
                    return;
                }
                if (dirt.state.Value == 1)
                {
                    Finish(cmd, true, "already watered");
                    return;
                }
                // Experimental MVP only: modifies HoeDirt directly, not the real watering-can animation.
                dirt.state.Value = 1;
                Finish(cmd, true, "soil marked watered (prototype)");
                return;
            }
            Finish(cmd, false, "unsupported action");
        }
        catch (Exception ex)
        {
            active = null;
            Finish(cmd, false, ex.GetType().Name + ": " + ex.Message);
        }
    }

    private void Finish(RemoteCommand cmd, bool ok, string message)
    {
        if (active?.Id == cmd.Id) active = null;
        if (client != null) _ = SendResultAsync(new { id = cmd.Id, ok, message });
    }

    private async Task PostStateAsync(object snapshot)
    {
        try
        {
            using var res = await client!.PostAsJsonAsync("/state", snapshot);
            res.EnsureSuccessStatusCode();
        }
        catch (Exception ex) { Monitor.Log("State sync: " + ex.Message, LogLevel.Trace); }
        finally { posting = false; }
    }

    private async Task PollAsync()
    {
        try
        {
            using var res = await client!.GetAsync("/next");
            res.EnsureSuccessStatusCode();
            using var json = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var obj = json.RootElement.GetProperty("command");
            if (obj.ValueKind != JsonValueKind.Object) return;
            var cmd = obj.Deserialize<RemoteCommand>(JsonOptions);
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.Id) || cmd.Id == lastPolledId) return;
            lastPolledId = cmd.Id;
            incoming.Enqueue(cmd);
        }
        catch (Exception ex) { Monitor.Log("Poll: " + ex.Message, LogLevel.Trace); }
        finally { polling = false; }
    }

    private async Task SendResultAsync(object result)
    {
        try
        {
            using var res = await client!.PostAsJsonAsync("/result", result);
            res.EnsureSuccessStatusCode();
        }
        catch (Exception ex) { Monitor.Log("Result sync: " + ex.Message, LogLevel.Warn); }
    }
}
