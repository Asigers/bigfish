using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Pathfinding;
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
    public string SaveId { get; set; } = "";
    public string Location { get; set; } = "";
    public string Target { get; set; } = "";
    public string SeedId { get; set; } = "";
    public int Day { get; set; }
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
    private Warp? activeExit;
    private bool sleeping;

    public override void Entry(IModHelper helper)
    {
        config = helper.ReadConfig<ModConfig>();
        if (config.Port < 1024 || config.Port > 65535 || config.Token.Length < 16 ||
            config.Token == "replace-with-a-random-secret")
        {
            Monitor.Log("Configure a 16+ character random token and valid port in config.json.", LogLevel.Warn);
            return;
        }
        client = new HttpClient
        {
            BaseAddress = new Uri("http://127.0.0.1:" + config.Port),
            Timeout = TimeSpan.FromSeconds(3)
        };
        client.DefaultRequestHeaders.Add("x-bigfish-token", config.Token);
        helper.Events.GameLoop.UpdateTicked += OnTick;
        helper.Events.GameLoop.DayStarted += (_, _) =>
        {
            if (active?.Type == "sleep" && Game1.dayOfMonth != active.Day)
                Finish(active, true, "next game day started");
        };
        helper.Events.GameLoop.ReturnedToTitle += (_, _) =>
        {
            if (active != null) Finish(active, false, "returned to title");
            while (incoming.TryDequeue(out _)) { }
            lastPolledId = "";
        };
        Monitor.Log("BigFish experimental agent bridge loaded. BACK UP your save.", LogLevel.Info);
    }

    private void OnTick(object? sender, UpdateTickedEventArgs e)
    {
        if (client == null || !Context.IsWorldReady || !Context.IsMainPlayer) return;
        if (e.IsMultipleOf(40) && !posting)
        {
            var snapshot = Snapshot(); // never access game objects from async HTTP continuations
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
            Advance();
            return;
        }
        if (!incoming.TryDequeue(out var cmd)) return;
        if (Game1.activeClickableMenu != null || Game1.eventUp)
        {
            Finish(cmd, false, "menu or cutscene active");
            return;
        }
        Execute(cmd);
    }

    // Farm doors are not guaranteed to appear in the raw location.warps table.
    // Expose a conservative built-in Farm <-> FarmHouse link at the actual door locations.
    private IEnumerable<Warp> Exits(GameLocation location)
    {
        foreach (var warp in location.warps) yield return warp;
        var house = Game1.getLocationFromName("FarmHouse") as FarmHouse;
        if (house == null) yield break;
        var outer = Game1.getFarm().GetMainFarmHouseEntry();
        var inner = house.getEntryLocation();
        if (location.Name == "Farm" && !location.warps.Any(w => w.TargetName == "FarmHouse"))
            yield return new Warp(outer.X, outer.Y, "FarmHouse", inner.X, inner.Y, false);
        else if (location.Name == "FarmHouse" && !location.warps.Any(w => w.TargetName == "Farm"))
            yield return new Warp(inner.X, inner.Y, "Farm", outer.X, outer.Y + 1, false);
    }

    private object Snapshot()
    {
        var player = Game1.player;
        var loc = player.currentLocation;
        var crops = new List<object>();
        var emptyPlots = new List<object>();
        var tillable = new List<object>();
        if (loc.Name == "Farm")
        {
            foreach (var pair in loc.terrainFeatures.Pairs)
            {
                if (pair.Value is not HoeDirt dirt) continue;
                int x = (int)pair.Key.X, y = (int)pair.Key.Y;
                if (dirt.crop != null)
                {
                    var crop = dirt.crop;
                    bool ready = !crop.dead.Value && crop.currentPhase.Value >= crop.phaseDays.Count - 1 &&
                                 (!crop.fullyGrown.Value || crop.dayOfCurrentPhase.Value <= 0);
                    crops.Add(new { x, y, watered = dirt.state.Value == 1, ready });
                }
                else emptyPlots.Add(new { x, y, watered = dirt.state.Value == 1 });
                if (crops.Count + emptyPlots.Count >= 200) break;
            }
            // Never suggest land occupied by objects, terrain features, or non-diggable tiles.
            for (int dx = -7; dx <= 7 && tillable.Count < 40; dx++)
            for (int dy = -7; dy <= 7 && tillable.Count < 40; dy++)
            {
                var x = player.TilePoint.X + dx;
                var y = player.TilePoint.Y + dy;
                var tile = new Vector2(x, y);
                if (x < 0 || y < 0 || !loc.isTileOnMap(tile)) continue;
                if (loc.doesTileHaveProperty(x, y, "Diggable", "Back") == null) continue;
                if (!loc.CanItemBePlacedHere(tile, itemIsPassable: true)) continue;
                tillable.Add(new { x, y });
            }
        }
        var seeds = player.Items.Where(i => i != null && i.Category == -74 && i.QualifiedItemId.StartsWith("(O)"))
            .GroupBy(i => i!.QualifiedItemId)
            .Take(60)
            .Select(g => new { id = g.Key, count = g.Sum(i => i!.Stack) })
            .ToArray();
        var exits = Exits(loc).Where(w => w.TargetName != null)
            .Take(50).Select(w => new { x = w.X, y = w.Y, target = w.TargetName }).ToArray();
        var links = Game1.locations.SelectMany(l => Exits(l).Select(w => new { from = l.Name, to = w.TargetName }))
            .Where(l => l.to != null).Take(300).ToArray();
        Point? bed = loc is FarmHouse home && home.GetPlayerBed() != null ? home.GetPlayerBedSpot() : null;
        return new
        {
            saveId = Game1.uniqueIDForThisGame.ToString(),
            location = loc.Name,
            day = Game1.dayOfMonth, season = Game1.currentSeason, time = Game1.timeOfDay,
            energy = (double)player.Stamina, x = player.TilePoint.X, y = player.TilePoint.Y,
            paused = Game1.activeClickableMenu != null || Game1.eventUp || !Game1.shouldTimePass(),
            crops, emptyPlots, tillable, seeds, exits, worldLinks = links,
            bed = bed.HasValue ? new { x = bed.Value.X, y = bed.Value.Y } : null,
            inventoryFree = player.Items.Count(i => i == null)
        };
    }

    private static bool Near(Point tile, int x, int y) => Math.Max(Math.Abs(tile.X - x), Math.Abs(tile.Y - y)) <= 1;

    private void Execute(RemoteCommand cmd)
    {
        var player = Game1.player;
        var loc = player.currentLocation;
        if (cmd.SaveId != Game1.uniqueIDForThisGame.ToString() ||
            cmd.Day != Game1.dayOfMonth || cmd.Location != loc.Name)
        {
            Finish(cmd, false, "stale command, day, save or location changed");
            return;
        }
        try
        {
            if (cmd.Type == "sleep")
            {
                if (loc is not FarmHouse house || !Game1.IsMasterGame || house.GetPlayerBed() == null)
                {
                    Finish(cmd, false, "sleep only works in owned farmhouse single-player host");
                    return;
                }
                active = cmd;
                sleeping = false;
                BeginMovement(house.GetPlayerBedSpot());
                return;
            }
            if (cmd.Type == "travel_to")
            {
                // Only a direct, mapped exit from the current location is accepted.
                activeExit = Exits(loc)
                    .Where(w => w.TargetName == cmd.Target)
                    .OrderBy(w => Math.Abs(w.X - player.TilePoint.X) + Math.Abs(w.Y - player.TilePoint.Y))
                    .FirstOrDefault();
                if (activeExit == null)
                {
                    Finish(cmd, false, "no direct map exit to " + cmd.Target);
                    return;
                }
                active = cmd;
                BeginMovement(new Point(activeExit.X, activeExit.Y));
                return;
            }
            if (loc.Name != "Farm" || cmd.X < 0 || cmd.Y < 0 || cmd.X > 150 || cmd.Y > 150)
            {
                Finish(cmd, false, "farm tile required");
                return;
            }
            if (cmd.Type == "move_to")
            {
                if (player.TilePoint.X == cmd.X && player.TilePoint.Y == cmd.Y)
                {
                    Finish(cmd, true, "already there");
                    return;
                }
                active = cmd;
                BeginMovement(new Point(cmd.X, cmd.Y));
                return;
            }
            if (!Near(player.TilePoint, cmd.X, cmd.Y))
            {
                Finish(cmd, false, "stand next to target tile first");
                return;
            }
            var tile = new Vector2(cmd.X, cmd.Y);
            loc.terrainFeatures.TryGetValue(tile, out var terrain);
            var dirt = terrain as HoeDirt;
            if (cmd.Type == "till_tile")
            {
                if (dirt != null) { Finish(cmd, true, "already tilled"); return; }
                if (player.Stamina < 4 || !loc.isTileOnMap(tile) ||
                    loc.doesTileHaveProperty(cmd.X, cmd.Y, "Diggable", "Back") == null ||
                    !loc.CanItemBePlacedHere(tile, itemIsPassable: true))
                {
                    Finish(cmd, false, "not diggable, occupied or no energy");
                    return;
                }
                // Prototype hoe behavior; real tool animation will replace it after Mac verification.
                loc.terrainFeatures.Add(tile, new HoeDirt(0, loc));
                player.Stamina -= 2;
                Finish(cmd, true, "tilled soil");
                return;
            }
            if (dirt == null) { Finish(cmd, false, "not tilled soil"); return; }
            if (cmd.Type == "plant_seed")
            {
                if (dirt.crop != null) { Finish(cmd, false, "soil already planted"); return; }
                var seed = player.Items.FirstOrDefault(i => i != null &&
                    i.Category == -74 && i.QualifiedItemId == cmd.SeedId);
                if (seed == null) { Finish(cmd, false, "seed missing from inventory"); return; }
                if (!dirt.plant(seed.ItemId, player, false))
                {
                    Finish(cmd, false, "crop can't be planted at this location/season");
                    return;
                }
                seed.Stack--;
                if (seed.Stack <= 0) player.Items.Remove(seed);
                Finish(cmd, true, "planted " + cmd.SeedId);
                return;
            }
            if (cmd.Type == "water_tile")
            {
                if (dirt.crop == null) { Finish(cmd, false, "no planted crop"); return; }
                if (dirt.state.Value == 1) { Finish(cmd, true, "already watered"); return; }
                if (player.Stamina < 3) { Finish(cmd, false, "low energy"); return; }
                // Prototyping: direct HoeDirt mutation. Watering-can use is a separate task.
                dirt.state.Value = 1;
                player.Stamina -= 2;
                Finish(cmd, true, "watered crop");
                return;
            }
            if (cmd.Type == "harvest_crop")
            {
                if (dirt.crop == null) { Finish(cmd, false, "no crop"); return; }
                var crop = dirt.crop;
                if (crop.dead.Value || crop.currentPhase.Value < crop.phaseDays.Count - 1 ||
                    (crop.fullyGrown.Value && crop.dayOfCurrentPhase.Value > 0))
                {
                    Finish(cmd, false, "crop is not ripe");
                    return;
                }
                if (!player.Items.Any(i => i == null)) { Finish(cmd, false, "no free inventory slot"); return; }
                var consumed = crop.harvest(cmd.X, cmd.Y, dirt);
                if (consumed) dirt.crop = null; // game harvest returns true when crop must be removed
                Finish(cmd, consumed || dirt.crop != crop, "harvest attempted; inspect inventory and crop state");
                return;
            }
            Finish(cmd, false, "unsupported action");
        }
        catch (Exception ex)
        {
            Game1.player.controller = null;
            Finish(cmd, false, ex.GetType().Name + ": " + ex.Message);
        }
    }

    private void BeginMovement(Point destination)
    {
        movementStarted = DateTime.UtcNow;
        if (Near(Game1.player.TilePoint, destination.X, destination.Y) &&
            (active?.Type == "travel_to" || active?.Type == "sleep")) return;
        Game1.player.controller = new PathFindController(Game1.player, Game1.player.currentLocation,
            destination, 2, false);
    }

    private void Advance()
    {
        if (active == null) return;
        var cmd = active;
        var player = Game1.player;
        if (cmd.Type == "sleep")
        {
            if (Game1.dayOfMonth != cmd.Day) { Finish(cmd, true, "day advanced"); return; }
            if (sleeping) return;
            if (player.currentLocation is not FarmHouse house) { Finish(cmd, false, "left farmhouse"); return; }
            var bed = house.GetPlayerBedSpot();
            if (Near(player.TilePoint, bed.X, bed.Y))
            {
                player.controller = null;
                // Sleep is initiated at the actual bed location (not an arbitrary global time jump).
                player.Position = new Vector2(bed.X * 64f, bed.Y * 64f);
                sleeping = true;
                house.answerDialogueAction("Sleep_Yes", Array.Empty<string>());
                return;
            }
        }
        else if (cmd.Type == "travel_to")
        {
            if (player.currentLocation.Name == cmd.Target) { Finish(cmd, true, "arrived at " + cmd.Target); return; }
            if (activeExit != null && Near(player.TilePoint, activeExit.X, activeExit.Y))
            {
                player.controller = null;
                // Entry is only triggered near a real warp tile: no arbitrary-location teleport.
                Game1.warpFarmer(activeExit.TargetName, activeExit.TargetX, activeExit.TargetY, false);
                activeExit = null; // wait for the next tick to verify actual destination
                return;
            }
        }
        else if (cmd.Type == "move_to")
        {
            if (player.TilePoint.X == cmd.X && player.TilePoint.Y == cmd.Y)
            {
                player.controller = null;
                Finish(cmd, true, "arrived"); return;
            }
        }
        if ((DateTime.UtcNow - movementStarted).TotalSeconds > (cmd.Type == "sleep" ? 75 : 12) ||
            (player.controller == null && !(cmd.Type == "travel_to" && activeExit == null)))
        {
            player.controller = null;
            Finish(cmd, false, "movement, warp or sleep timed out");
        }
    }

    private void Finish(RemoteCommand cmd, bool ok, string message)
    {
        if (active?.Id == cmd.Id)
        {
            active = null;
            activeExit = null;
            sleeping = false;
        }
        if (client != null) _ = SendResultAsync(new { id = cmd.Id, ok, message });
    }

    private async Task PostStateAsync(object snapshot)
    {
        try { using var res = await client!.PostAsJsonAsync("/state", snapshot); res.EnsureSuccessStatusCode(); }
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
        try { using var res = await client!.PostAsJsonAsync("/result", result); res.EnsureSuccessStatusCode(); }
        catch (Exception ex) { Monitor.Log("Result sync: " + ex.Message, LogLevel.Warn); }
    }
}
