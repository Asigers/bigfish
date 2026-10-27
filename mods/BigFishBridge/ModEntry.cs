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
using StardewValley.Objects;
using StardewValley.Tools;
using StardewValley.Internal;
using SObject = StardewValley.Object;

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
    public string ItemId { get; set; } = "";
    public string Tool { get; set; } = "";
    public string Kind { get; set; } = "";
    public int Count { get; set; } = 1;
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
    private DateTime dropStartedAt;
    private string dropItemId = "";
    private int dropBagBefore;
    private DateTime foodStartedAt;
    private float foodEnergyBefore;
    private string foodItemId = "";
    private int foodItemCountBefore;
    private DateTime lastMovementDiagnostic;
    private Point movementOrigin;
    private Point movementDestination;
    private bool polling;
    private bool posting;
    private readonly HashSet<string> seenCommandIds = new();
    private readonly Queue<string> seenCommandOrder = new();
    private sealed record CommandReceipt(string Id, bool Ok, string Message);
    private readonly ConcurrentQueue<CommandReceipt> outboundResults = new();
    private int resultPosting;
    private Warp? activeExit;
    private bool sleeping;
    private List<Point>? cachedWaterSources;
    private readonly HashSet<string> reportedInvalidExitLocations = new();

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
            cachedWaterSources = null;
            if (active?.Type == "sleep" && Game1.dayOfMonth != active.Day)
                Finish(active, true, "next game day started");
        };
        helper.Events.GameLoop.ReturnedToTitle += (_, _) =>
        {
            cachedWaterSources = null;
            if (active != null) Finish(active, false, "returned to title");
            while (incoming.TryDequeue(out _)) { }
            // Preserve recently seen command IDs even after returning to title; do not replay them.
        };
        Monitor.Log("BigFish experimental agent bridge loaded. BACK UP your save.", LogLevel.Info);
    }

    private void OnTick(object? sender, UpdateTickedEventArgs e)
    {
        if (client == null) return;
        // A command may finish while a location is transitioning or the title menu opens.
        // Keep sending its receipt even when the world is temporarily unavailable.
        if (e.IsMultipleOf(30) && !outboundResults.IsEmpty &&
            Interlocked.CompareExchange(ref resultPosting, 1, 0) == 0)
            _ = FlushResultsAsync();
        if (!Context.IsWorldReady || !Context.IsMainPlayer) return;
        if (e.IsMultipleOf(40) && !posting)
        {
            try
            {
                var snapshot = Snapshot(); // never access game objects from async HTTP continuations
                posting = true;
                _ = PostStateAsync(snapshot);
            }
            catch (Exception ex)
            {
                Monitor.Log("Snapshot failed: " + ex, LogLevel.Error);
            }
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
        foreach (var warp in location.warps.Where(w => !w.npcOnly.Value)) yield return warp;
        // Pierre's front door is a map action, not necessarily a regular location warp.
        // Only expose the public SeedShop entrance, never locked/story doors or arbitrary teleports.
        if (location.Name == "Town")
        {
            foreach (var entry in location.doors.Pairs)
            {
                var doorWarp = location.getWarpFromDoor(entry.Key, Game1.player);
                if (doorWarp?.TargetName == "SeedShop")
                    yield return doorWarp;
            }
        }
        var house = Game1.getLocationFromName("FarmHouse") as FarmHouse;
        if (house == null) yield break;
        var outer = Game1.getFarm().GetMainFarmHouseEntry();
        var inner = house.getEntryLocation();
        if (location.Name == "Farm" && !location.warps.Any(w => w.TargetName == "FarmHouse"))
            yield return new Warp(outer.X, outer.Y, "FarmHouse", inner.X, inner.Y, false);
        else if (location.Name == "FarmHouse" && !location.warps.Any(w => w.TargetName == "Farm"))
            yield return new Warp(inner.X, inner.Y, "Farm", outer.X, outer.Y + 1, false);
    }

    // The Node bridge accepts only bounded coordinates and simple map identifiers.
    // Some map warps are off-map placeholders and must not poison the entire snapshot.
    private static bool ValidMapName(string? name) =>
        !string.IsNullOrEmpty(name) && name.Length <= 80 &&
        name.All(c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '_' || c == '-');

    private static bool ValidNavigableExit(Warp warp) =>
        warp.X >= 0 && warp.Y >= 0 && warp.X < 256 && warp.Y < 256 &&
        ValidMapName(warp.TargetName);

    private static string? DebrisKind(SObject obj)
    {
        if (obj.IsSpawnedObject || obj.bigCraftable.Value) return null;
        if (obj.IsBreakableStone()) return "stone";
        if (obj.IsTwig()) return "twig";
        if (obj.IsWeeds()) return "weed";
        return null;
    }

    private static readonly HashSet<string> CollectibleDropIds =
        new() { "(O)388", "(O)390", "(O)771", "(O)382", "(O)92" };
    private static string? ResourceDropId(Debris debris)
    {
        if (debris.debrisType.Value != Debris.DebrisType.OBJECT &&
            debris.debrisType.Value != Debris.DebrisType.RESOURCE) return null;
        var id = debris.item?.QualifiedItemId ?? debris.itemId.Value;
        return id != null && CollectibleDropIds.Contains(id) ? id : null;
    }
    private static Point? DropPosition(Debris debris)
    {
        if (debris.Chunks.Count == 0) return null;
        var pos = debris.Chunks[0].position.Value;
        if (!float.IsFinite(pos.X) || !float.IsFinite(pos.Y)) return null;
        return new Point((int)Math.Floor(pos.X / 64f), (int)Math.Floor(pos.Y / 64f));
    }

    private static bool SafeResourceTree(Tree tree) =>
        tree.growthStage.Value >= 5 && !tree.tapped.Value &&
        !tree.stump.Value && tree.health.Value > 0;

    private object Snapshot()
    {
        var player = Game1.player;
        var loc = player.currentLocation;
        var crops = new List<object>();
        var waterSources = new List<object>();
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
            // Scan the farm map only once per game day, and only if the can is empty.
            // Nearby-only scanning would deadlock when ponds are farther than ten tiles.
            var can = player.Items.OfType<WateringCan>().FirstOrDefault();
            if (can != null && can.WaterLeft == 0)
            {
                if (cachedWaterSources == null)
                {
                    cachedWaterSources = new List<Point>();
                    for (int x = 0; x < 160; x++)
                    for (int y = 0; y < 160; y++)
                        if (loc.isTileOnMap(x, y) && loc.CanRefillWateringCanOnTile(x, y))
                            cachedWaterSources.Add(new Point(x, y));
                }
                foreach (var spot in cachedWaterSources
                    .OrderBy(t => Math.Abs(t.X - player.TilePoint.X) + Math.Abs(t.Y - player.TilePoint.Y))
                    .Take(60))
                    waterSources.Add(new { x = spot.X, y = spot.Y });
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
        // Bounded farm resource scan: no placed machines, paths, buildings, crops,
        // fruit trees, tapper trees, young trees, stumps or map-specific setpieces.
        var resources = new List<object>();
        if (loc.Name == "Farm")
        {
            foreach (var pair in loc.terrainFeatures.Pairs
                .OrderBy(p => Math.Abs(p.Key.X - player.TilePoint.X) +
                    Math.Abs(p.Key.Y - player.TilePoint.Y)))
            {
                if (pair.Value is not Tree tree || !SafeResourceTree(tree)) continue;
                if (pair.Key.X < 0 || pair.Key.Y < 0 ||
                    pair.Key.X >= 150 || pair.Key.Y >= 150) continue;
                resources.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y,
                    kind = "tree", health = (double)tree.health.Value });
                if (resources.Count >= 90) break;
            }
            foreach (var pair in loc.objects.Pairs
                .OrderBy(p => Math.Abs(p.Key.X - player.TilePoint.X) +
                    Math.Abs(p.Key.Y - player.TilePoint.Y)))
            {
                if (resources.Count >= 120) break;
                var kind = pair.Value is SObject obj ? DebrisKind(obj) : null;
                if (kind == null || pair.Key.X < 0 || pair.Key.Y < 0 ||
                    pair.Key.X >= 150 || pair.Key.Y >= 150) continue;
                // Scythe swings have an area of effect; never target weeds close to crops.
                if (kind == "weed" && loc.terrainFeatures.Pairs.Any(p =>
                    p.Value is HoeDirt dirt && dirt.crop != null &&
                    Math.Abs(p.Key.X - pair.Key.X) <= 2 &&
                    Math.Abs(p.Key.Y - pair.Key.Y) <= 2)) continue;
                resources.Add(new { x = (int)pair.Key.X, y = (int)pair.Key.Y,
                    kind, health = (double)Math.Max(0, pair.Value.MinutesUntilReady) });
            }
        }
        // Only spawned forage objects are collectible. Never infer rocks, machines, or
        // player-placed objects to be pickups just because they share an object type.
        var forage = loc.objects.Pairs
            .Where(pair => pair.Value is SObject obj && obj.IsSpawnedObject &&
                !obj.bigCraftable.Value && obj.QualifiedItemId.StartsWith("(O)") &&
                pair.Key.X >= 0 && pair.Key.Y >= 0 &&
                pair.Key.X < 256 && pair.Key.Y < 256)
            .Take(80)
            .Select(pair => new { x = (int)pair.Key.X, y = (int)pair.Key.Y,
                itemId = pair.Value.QualifiedItemId })
            .ToArray();
        var drops = loc.debris
            .Select(d => new { debris = d, pos = DropPosition(d), id = ResourceDropId(d) })
            .Where(d => d.pos.HasValue && d.id != null &&
                d.pos.Value.X >= 0 && d.pos.Value.Y >= 0 &&
                d.pos.Value.X < 150 && d.pos.Value.Y < 150)
            .OrderBy(d => Math.Abs(d.pos!.Value.X - player.TilePoint.X) +
                Math.Abs(d.pos!.Value.Y - player.TilePoint.Y))
            .Take(80)
            .Select(d => new { x = d.pos!.Value.X, y = d.pos!.Value.Y, itemId = d.id! })
            .ToArray();
        var seeds = player.Items.Where(i => i != null && i.Category == -74 && i.QualifiedItemId.StartsWith("(O)"))
            .GroupBy(i => i!.QualifiedItemId)
            .Take(60)
            .Select(g => new { id = g.Key, count = g.Sum(i => i!.Stack) })
            .ToArray();
        var rawExits = Exits(loc).Take(100).ToArray();
        if (reportedInvalidExitLocations.Add(loc.Name))
        {
            for (int index = 0; index < rawExits.Length; index++)
            {
                var warp = rawExits[index];
                if (!ValidNavigableExit(warp))
                    Monitor.Log("Skipping warp " + loc.Name + "[" + index + "] at (" +
                        warp.X + "," + warp.Y + ") to '" +
                        (warp.TargetName?.Length > 80 ? warp.TargetName.Substring(0, 80) : warp.TargetName) +
                        "' (invalid coordinate or target name)", LogLevel.Warn);
            }
        }
        var exits = rawExits.Where(ValidNavigableExit)
            .Take(50).Select(w => new { x = w.X, y = w.Y, target = w.TargetName }).ToArray();
        var links = Game1.locations.Where(l => ValidMapName(l.Name))
            .SelectMany(l => Exits(l).Where(ValidNavigableExit)
                .Select(w => new { from = l.Name, to = w.TargetName }))
            .Take(300).ToArray();
        Point? bed = loc is FarmHouse home && home.GetPlayerBed() != null ? home.GetPlayerBedSpot() : null;
        // Only real, beneficial edible objects. Stardrop/quest objects are protected.
        var food = player.Items.OfType<SObject>()
            .Where(o => o.Edibility > 0 && o.staminaRecoveredOnConsumption() > 0 &&
                !o.questItem.Value && o.QualifiedItemId != "(O)434" &&
                o.QualifiedItemId.StartsWith("(O)"))
            .GroupBy(o => o.QualifiedItemId).Take(48)
            .Select(g => new { id = g.Key, count = g.Sum(o => o.Stack),
                restoreEnergy = Math.Min(500, g.First().staminaRecoveredOnConsumption()) })
            .ToArray();
        var bag = player.Items.Where(i => i != null && i.QualifiedItemId.StartsWith("(O)"))
            .GroupBy(i => i!.QualifiedItemId).Take(60)
            .Select(g => new { id = g.Key, count = g.Sum(i => i!.Stack),
                category = g.First()!.Category,
                sellable = g.First() is SObject o && o.canBeShipped() }).ToArray();
        var chests = loc.objects.Pairs.Where(p => p.Value is Chest chest && chest.playerChest.Value)
            .Take(40)
            .Select(p => new { x = (int)p.Key.X, y = (int)p.Key.Y,
                items = ((Chest)p.Value).GetItemsForPlayer()
                    .Where(i => i != null && i.QualifiedItemId.StartsWith("(O)"))
                    .Take(100)
                    .Select(i => new { id = i!.QualifiedItemId, count = i.Stack,
                        category = i.Category, sellable = i is SObject obj && obj.canBeShipped() }).ToArray()
            }).ToArray();
        var bin = loc is Farm farmLoc ? farmLoc.GetStarterShippingBinLocation() : (Vector2?)null;
        var pierre = loc.Name == "SeedShop" ? Game1.getCharacterFromName("Pierre") : null;
        bool shopOpen = loc.Name == "SeedShop" && pierre != null && pierre.currentLocation == loc &&
            Game1.timeOfDay >= 900 && Game1.timeOfDay < 1700 && Game1.dayOfMonth % 7 != 3;
        object[] offers = shopOpen ? ShopBuilder.GetShopStock("SeedShop")
            .Where(entry => entry.Key is SObject obj && obj.Category == -74 && entry.Value.Price > 0 &&
                entry.Value.TradeItem == null && entry.Value.Stock != 0)
            .Take(100).Select(entry => new { id = ((SObject)entry.Key).QualifiedItemId,
                price = entry.Value.Price, stock = entry.Value.Stock > 9999 ? -1 : entry.Value.Stock }).ToArray()
            : Array.Empty<object>();
        object? shop = shopOpen ? new {
            keeper = new { x = pierre!.TilePoint.X, y = pierre.TilePoint.Y },
            open = true, offers
        } : null;
        var hoeTool = player.Items.OfType<Hoe>().FirstOrDefault();
        var waterTool = player.Items.OfType<WateringCan>().FirstOrDefault();
        var axeTool = player.Items.OfType<Axe>().FirstOrDefault();
        var pickaxeTool = player.Items.OfType<Pickaxe>().FirstOrDefault();
        var scytheTool = player.Items.OfType<MeleeWeapon>().FirstOrDefault(w => w.isScythe());
        var tools = new { hoe = hoeTool != null, wateringCan = waterTool != null,
            axe = axeTool != null, pickaxe = pickaxeTool != null, scythe = scytheTool != null,
            equipped = player.CurrentTool is Hoe ? "hoe" :
                player.CurrentTool is WateringCan ? "watering_can" :
                player.CurrentTool is Axe ? "axe" :
                player.CurrentTool is Pickaxe ? "pickaxe" :
                player.CurrentTool is MeleeWeapon mw && mw.isScythe() ? "scythe" : "other",
            waterLeft = waterTool?.WaterLeft ?? 0 };
        var economy = new {
            gold = player.Money, bag, chests,
            shippingBin = bin.HasValue ? new { x = (int)bin.Value.X, y = (int)bin.Value.Y } : null,
            shop, tools
        };
        var pauseReason = Game1.activeClickableMenu != null ? "menu" :
            Game1.eventUp ? "event" :
            !Game1.shouldTimePass() ? "time_stopped" : "none";
        return new
        {
            economy,
            saveId = Game1.uniqueIDForThisGame.ToString(),
            location = loc.Name,
            day = Game1.dayOfMonth, season = Game1.currentSeason, time = Game1.timeOfDay,
            energy = (double)player.Stamina, x = player.TilePoint.X, y = player.TilePoint.Y,
            paused = pauseReason != "none", pauseReason,
            crops, emptyPlots, tillable, seeds, food, forage, resources, drops, exits, worldLinks = links, waterSources,
            bed = bed.HasValue ? new { x = bed.Value.X, y = bed.Value.Y } : null,
            inventoryFree = player.freeSpotsInInventory()
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
                    .Where(w => ValidNavigableExit(w) && w.TargetName == cmd.Target)
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
            if (cmd.Type == "pickup_drop")
            {
                if (cmd.X < 0 || cmd.Y < 0 || cmd.X >= 150 || cmd.Y >= 150 ||
                    !CollectibleDropIds.Contains(cmd.ItemId) || player.freeSpotsInInventory() < 1)
                { Finish(cmd, false, "invalid drop or full backpack"); return; }
                var target = loc.debris.Select(d => new { debris = d, pos = DropPosition(d) })
                    .FirstOrDefault(d => ResourceDropId(d.debris) == cmd.ItemId &&
                        d.pos.HasValue &&
                        Math.Abs(d.pos.Value.X - cmd.X) <= 2 &&
                        Math.Abs(d.pos.Value.Y - cmd.Y) <= 2);
                if (target == null)
                { Finish(cmd, false, "matching world drop not present"); return; }
                dropItemId = cmd.ItemId;
                dropBagBefore = player.Items
                    .Where(i => i?.QualifiedItemId == cmd.ItemId).Sum(i => i!.Stack);
                dropStartedAt = DateTime.UtcNow;
                active = cmd;
                var point = target.pos!.Value;
                // Native debris attraction/pickup runs in GameLocation.Update;
                // approaching it is enough. Never invoke Debris.collect() manually.
                var candidates = new List<Point> { point };
                for (int dx = -1; dx <= 1; dx++)
                for (int dy = -1; dy <= 1; dy++)
                {
                    if (dx == 0 && dy == 0) continue;
                    candidates.Add(new Point(point.X + dx, point.Y + dy));
                }
                bool pathFound = false;
                // The engine computes a real collision-aware route. Limit candidate
                // searches per command so distant debris cannot stall the game thread.
                foreach (var candidate in candidates.OrderBy(c =>
                    Math.Abs(c.X - player.TilePoint.X) + Math.Abs(c.Y - player.TilePoint.Y))
                    .Take(4))
                {
                    if (candidate.X < 0 || candidate.Y < 0 ||
                        !loc.isTileOnMap(candidate.X, candidate.Y)) continue;
                    if (candidate == player.TilePoint)
                    {
                        movementDestination = candidate;
                        movementStarted = DateTime.UtcNow;
                        player.controller = null;
                        pathFound = true;
                        break;
                    }
                    var controller = new PathFindController(player, loc, candidate, 2, false);
                    if (controller.pathToEndPoint == null || controller.pathToEndPoint.Count == 0)
                        continue;
                    movementDestination = candidate;
                    movementStarted = DateTime.UtcNow;
                    player.controller = controller;
                    pathFound = true;
                    break;
                }
                if (!pathFound)
                { Finish(cmd, false, "no reachable drop pickup position"); return; }
                Monitor.Log("Approaching native drop " + cmd.ItemId +
                    " at (" + point.X + "," + point.Y + ")", LogLevel.Info);
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
            if (cmd.Type == "collect_forage")
            {
                if (cmd.X < 0 || cmd.Y < 0 || cmd.X >= 256 || cmd.Y >= 256)
                { Finish(cmd, false, "invalid forage tile"); return; }
                if (!Near(player.TilePoint, cmd.X, cmd.Y))
                { Finish(cmd, false, "approach forage tile first"); return; }
                var position = new Vector2(cmd.X, cmd.Y);
                if (!loc.objects.TryGetValue(position, out var forageObject) ||
                    forageObject is not SObject spawned || !spawned.IsSpawnedObject ||
                    spawned.bigCraftable.Value || !spawned.QualifiedItemId.StartsWith("(O)"))
                { Finish(cmd, false, "no collectible forage at tile"); return; }
                if (!player.couldInventoryAcceptThisItem(spawned))
                { Finish(cmd, false, "backpack cannot hold forage"); return; }
                // Trigger native interaction logic; never inject an inventory item.
                // Require BOTH ground object removal and a measured bag increment.
                var beforeCount = player.Items
                    .Where(item => item?.QualifiedItemId == spawned.QualifiedItemId)
                    .Sum(item => item!.Stack);
                loc.checkAction(new xTile.Dimensions.Location(cmd.X, cmd.Y), Game1.viewport, player);
                var afterCount = player.Items
                    .Where(item => item?.QualifiedItemId == spawned.QualifiedItemId)
                    .Sum(item => item!.Stack);
                var removed = !loc.objects.TryGetValue(position, out var remaining) ||
                    remaining != forageObject;
                var collected = removed && afterCount > beforeCount;
                Finish(cmd, collected, collected ? "forage collected" :
                    "native pickup lacked object removal or inventory increase");
                return;
            }
            if (cmd.Type == "eat_food")
            {
                if (player.Stamina >= player.MaxStamina - 12 || player.isEating)
                { Finish(cmd, false, "not hungry or already eating"); return; }
                var index = player.Items.ToList().FindIndex(i =>
                    i is SObject o && o.QualifiedItemId == cmd.ItemId &&
                    o.Edibility > 0 && o.staminaRecoveredOnConsumption() > 0 &&
                    !o.questItem.Value && o.QualifiedItemId != "(O)434");
                if (index < 0)
                { Finish(cmd, false, "safe edible item unavailable"); return; }
                player.CurrentToolIndex = index;
                foodItemId = cmd.ItemId;
                foodItemCountBefore = player.Items
                    .Where(i => i?.QualifiedItemId == cmd.ItemId).Sum(i => i!.Stack);
                foodEnergyBefore = player.Stamina;
                foodStartedAt = DateTime.UtcNow;
                // Eat via the normal farmer method to retain actual consumption and animation.
                player.eatHeldObject();
                var countAfter = player.Items
                    .Where(i => i?.QualifiedItemId == cmd.ItemId).Sum(i => i!.Stack);
                if (countAfter >= foodItemCountBefore || !player.isEating)
                { Finish(cmd, false, "native eating did not consume one item"); return; }
                active = cmd;
                return;
            }
            if (cmd.Type == "equip_tool")
            {
                var index = player.Items.ToList().FindIndex(i => cmd.Tool switch
                {
                    "hoe" => i is Hoe,
                    "watering_can" => i is WateringCan,
                    "axe" => i is Axe,
                    "pickaxe" => i is Pickaxe,
                    "scythe" => i is MeleeWeapon weapon && weapon.isScythe(),
                    _ => false
                });
                if (index < 0) { Finish(cmd, false, "tool not found"); return; }
                player.CurrentToolIndex = index;
                Finish(cmd, true, "equipped " + cmd.Tool);
                return;
            }
            if (cmd.Type == "clear_resource")
            {
                if (loc.Name != "Farm" || player.Stamina < 45 ||
                    cmd.X < 0 || cmd.Y < 0 || cmd.X >= 150 || cmd.Y >= 150 ||
                    !Near(player.TilePoint, cmd.X, cmd.Y))
                { Finish(cmd, false, "unsafe resource action: farm, energy or proximity"); return; }
                var resourceTile = new Vector2(cmd.X, cmd.Y);
                if (cmd.Kind == "tree")
                {
                    if (!loc.terrainFeatures.TryGetValue(resourceTile, out var feature) ||
                        feature is not Tree tree || !SafeResourceTree(tree) ||
                        player.CurrentTool is not Axe axe)
                    { Finish(cmd, false, "tree absent, protected or axe not equipped"); return; }
                    var previousHealth = tree.health.Value;
                    axe.DoFunction(loc, cmd.X * 64 + 32, cmd.Y * 64 + 32, 1, player);
                    var progress = !loc.terrainFeatures.TryGetValue(resourceTile, out var now) ||
                        now is not Tree grown || grown.stump.Value ||
                        grown.health.Value < previousHealth;
                    Finish(cmd, progress, progress ? "tree hit confirmed" : "tree did not take damage");
                    return;
                }
                if (!loc.objects.TryGetValue(resourceTile, out var item) ||
                    item is not SObject debris || DebrisKind(debris) != cmd.Kind)
                { Finish(cmd, false, "resource not present or kind changed"); return; }
                if (cmd.Kind == "weed" &&
                    loc.terrainFeatures.Pairs.Any(p => p.Value is HoeDirt dirt &&
                        dirt.crop != null && Math.Abs(p.Key.X - cmd.X) <= 2 &&
                        Math.Abs(p.Key.Y - cmd.Y) <= 2))
                { Finish(cmd, false, "weed too close to planted crops"); return; }
                var requiredTool = cmd.Kind switch
                {
                    "stone" => player.CurrentTool is Pickaxe,
                    "twig" => player.CurrentTool is Axe,
                    "weed" => player.CurrentTool is MeleeWeapon w && w.isScythe(),
                    _ => false
                };
                if (!requiredTool)
                { Finish(cmd, false, "matching resource tool not equipped"); return; }
                var previousDurability = debris.MinutesUntilReady;
                player.CurrentTool!.DoFunction(loc, cmd.X * 64 + 32, cmd.Y * 64 + 32, 1, player);
                var changed = !loc.objects.TryGetValue(resourceTile, out var next) ||
                    next != item || next.MinutesUntilReady < previousDurability;
                Finish(cmd, changed, changed ? "resource tool strike confirmed" :
                    "resource unchanged by tool strike");
                return;
            }
            if (HandleEconomy(cmd, player, loc)) return;
            if (loc.Name != "Farm" || cmd.X < 0 || cmd.Y < 0 || cmd.X > 150 || cmd.Y > 150)
            {
                Finish(cmd, false, "farm tile required");
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
            if (cmd.Type == "refill_watering_can")
            {
                var can = player.CurrentTool as WateringCan;
                if (can == null || !loc.CanRefillWateringCanOnTile(cmd.X, cmd.Y))
                { Finish(cmd, false, "equip can and approach refillable water source"); return; }
                can.DoFunction(loc, cmd.X * 64, cmd.Y * 64, 0, player);
                Finish(cmd, can.WaterLeft > 0, "water refilled");
                return;
            }
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
                var hoe = player.CurrentTool as Hoe;
                if (hoe == null) { Finish(cmd, false, "equip hoe first"); return; }
                hoe.DoFunction(loc, cmd.X * 64, cmd.Y * 64, 0, player);
                Finish(cmd, loc.terrainFeatures.ContainsKey(tile), "hoe used");
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
                var wateringCan = player.CurrentTool as WateringCan;
                if (wateringCan == null) { Finish(cmd, false, "equip watering can first"); return; }
                if (wateringCan.WaterLeft <= 0) { Finish(cmd, false, "watering can empty"); return; }
                wateringCan.DoFunction(loc, cmd.X * 64, cmd.Y * 64, 0, player);
                Finish(cmd, dirt.state.Value == 1, "watering can used");
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
                bool stillReady = dirt.crop == crop && !crop.dead.Value &&
                    crop.currentPhase.Value >= crop.phaseDays.Count - 1 &&
                    (!crop.fullyGrown.Value || crop.dayOfCurrentPhase.Value <= 0);
                Finish(cmd, consumed || !stillReady, consumed || !stillReady ? "crop harvested" : "harvest did not complete");
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

    private bool HandleEconomy(RemoteCommand cmd, Farmer player, GameLocation loc)
    {
        if (cmd.Type == "ship_item")
        {
            if (loc is not Farm farm) { Finish(cmd, false, "shipping only on farm"); return true; }
            var bin = farm.GetStarterShippingBinLocation();
            if (!Near(player.TilePoint, (int)bin.X, (int)bin.Y)) { Finish(cmd, false, "approach shipping bin"); return true; }
            var item = player.Items.FirstOrDefault(i => i?.QualifiedItemId == cmd.ItemId);
            if (item is not SObject obj || !obj.canBeShipped() || obj.Category == -74)
            { Finish(cmd, false, "item cannot be shipped"); return true; }
            farm.shipItem(item, player);
            Finish(cmd, true, "shipped " + cmd.ItemId);
            return true;
        }
        if (cmd.Type == "buy_seed")
        {
            var pierre = loc.Name == "SeedShop" ? Game1.getCharacterFromName("Pierre") : null;
            if (pierre == null || pierre.currentLocation != loc || !Near(player.TilePoint, pierre.TilePoint.X, pierre.TilePoint.Y) ||
                Game1.timeOfDay < 900 || Game1.timeOfDay >= 1700 || Game1.dayOfMonth % 7 == 3)
            { Finish(cmd, false, "Pierre is not available for purchase"); return true; }
            if (cmd.Count < 1 || cmd.Count > 12) { Finish(cmd, false, "invalid count"); return true; }
            var offer = ShopBuilder.GetShopStock("SeedShop").FirstOrDefault(pair =>
                pair.Key is SObject o && o.Category == -74 && o.QualifiedItemId == cmd.ItemId &&
                pair.Value.TradeItem == null && pair.Value.Price > 0 &&
                (pair.Value.Stock < 0 || pair.Value.Stock >= cmd.Count));
            if (offer.Key is not SObject seed || offer.Value.Price <= 0)
            { Finish(cmd, false, "seed not in actual shop stock"); return true; }
            long price = (long)offer.Value.Price * cmd.Count;
            if (price > player.Money) { Finish(cmd, false, "not enough money"); return true; }
            var purchased = ItemRegistry.Create(cmd.ItemId);
            purchased.Stack = cmd.Count;
            if (!player.couldInventoryAcceptThisItem(purchased))
            { Finish(cmd, false, "backpack cannot hold seeds"); return true; }
            var remaining = player.addItemToInventory(purchased);
            int accepted = cmd.Count - (remaining?.Stack ?? 0);
            if (accepted <= 0) { Finish(cmd, false, "inventory insertion failed"); return true; }
            player.Money -= offer.Value.Price * accepted;
            Finish(cmd, accepted == cmd.Count,
                "purchased " + accepted + "/" + cmd.Count + " seeds for " + offer.Value.Price * accepted + "g");
            return true;
        }
        if (cmd.Type == "store_item" || cmd.Type == "withdraw_item")
        {
            if (cmd.Count < 1 || cmd.Count > 9999 || !Near(player.TilePoint, cmd.X, cmd.Y) ||
                !loc.objects.TryGetValue(new Vector2(cmd.X, cmd.Y), out var objectAtTile) ||
                objectAtTile is not Chest chest || !chest.playerChest.Value ||
                chest.GetMutex().IsLocked() && !chest.GetMutex().IsLockHeld())
            { Finish(cmd, false, "accessible player chest required"); return true; }
            var slots = chest.GetItemsForPlayer();
            if (cmd.Type == "store_item")
            {
                var from = player.Items.FirstOrDefault(i => i?.QualifiedItemId == cmd.ItemId && i.Stack >= cmd.Count);
                if (from == null || from is Tool) { Finish(cmd, false, "item not available to store"); return true; }
                var move = from.getOne();
                move.Stack = cmd.Count;
                if (slots.Count >= chest.GetActualCapacity() && !slots.Any(i => i != null && i.canStackWith(move)))
                { Finish(cmd, false, "chest full"); return true; }
                var remainder = chest.addItem(move);
                int stored = cmd.Count - (remainder?.Stack ?? 0);
                if (stored > 0)
                {
                    from.Stack -= stored;
                    if (from.Stack <= 0) player.removeItemFromInventory(from);
                }
                Finish(cmd, stored == cmd.Count, "stored " + stored + "/" + cmd.Count + " items");
                return true;
            }
            var inside = slots.FirstOrDefault(i => i?.QualifiedItemId == cmd.ItemId && i.Stack >= cmd.Count);
            if (inside == null) { Finish(cmd, false, "chest has insufficient items"); return true; }
            var take = inside.getOne(); take.Stack = cmd.Count;
            if (!player.couldInventoryAcceptThisItem(take))
            { Finish(cmd, false, "backpack cannot accept item"); return true; }
            var pending = player.addItemToInventory(take);
            int transferred = cmd.Count - (pending?.Stack ?? 0);
            if (transferred > 0)
            {
                inside.Stack -= transferred;
                if (inside.Stack <= 0) slots.Remove(inside);
            }
            Finish(cmd, transferred == cmd.Count, "withdrew " + transferred + "/" + cmd.Count + " items");
            return true;
        }
        return false;
    }

    private void BeginMovement(Point destination)
    {
        var player = Game1.player;
        movementOrigin = player.TilePoint;
        movementDestination = destination;
        movementStarted = DateTime.UtcNow;
        lastMovementDiagnostic = movementStarted;
        if (Near(movementOrigin, destination.X, destination.Y) &&
            (active?.Type == "travel_to" || active?.Type == "sleep"))
        {
            Monitor.Log("Already near " + active?.Type + " target (" +
                destination.X + "," + destination.Y + ") at (" +
                movementOrigin.X + "," + movementOrigin.Y + ")", LogLevel.Info);
            return;
        }

        var controller = new PathFindController(player, player.currentLocation, destination, 2, false);
        Point chosen = destination;
        // A door/bed may be impassable even if a neighboring tile is reachable.
        // Only these two actions can complete from an adjacent tile.
        if ((controller.pathToEndPoint == null || controller.pathToEndPoint.Count == 0) &&
            (active?.Type == "travel_to" || active?.Type == "sleep"))
        {
            var candidates = new List<Point>();
            for (int dx = -1; dx <= 1; dx++)
            for (int dy = -1; dy <= 1; dy++)
            {
                if (dx == 0 && dy == 0) continue;
                candidates.Add(new Point(destination.X + dx, destination.Y + dy));
            }
            foreach (var candidate in candidates.OrderBy(p =>
                Math.Abs(p.X - movementOrigin.X) + Math.Abs(p.Y - movementOrigin.Y)))
            {
                if (!player.currentLocation.isTileOnMap(new Vector2(candidate.X, candidate.Y)))
                    continue;
                var alternate = new PathFindController(player, player.currentLocation, candidate, 2, false);
                if (alternate.pathToEndPoint == null || alternate.pathToEndPoint.Count == 0)
                    continue;
                chosen = candidate;
                controller = alternate;
                break;
            }
        }
        if (controller.pathToEndPoint == null || controller.pathToEndPoint.Count == 0)
        {
            if (active != null)
                Finish(active, false, "no path from (" + movementOrigin.X + "," +
                    movementOrigin.Y + ") to (" + destination.X + "," + destination.Y + ")");
            return;
        }
        player.controller = controller;
        Monitor.Log("Move " + active?.Type + " from (" + movementOrigin.X + "," +
            movementOrigin.Y + ") toward (" + destination.X + "," + destination.Y +
            ") via (" + chosen.X + "," + chosen.Y + "), path steps=" +
            controller.pathToEndPoint.Count, LogLevel.Info);
    }

    private void Advance()
    {
        if (active == null) return;
        var cmd = active;
        var player = Game1.player;
        if (cmd.Type == "pickup_drop")
        {
            var count = player.Items.Where(i => i?.QualifiedItemId == dropItemId)
                .Sum(i => i!.Stack);
            if (count > dropBagBefore)
            {
                player.controller = null;
                Finish(cmd, true, "native pickup verified by inventory increase");
                return;
            }
            if ((DateTime.UtcNow - dropStartedAt).TotalSeconds > 12)
            {
                player.controller = null;
                Finish(cmd, false, "drop was not collected within 12 seconds");
            }
            return;
        }
        if (cmd.Type == "eat_food")
        {
            if (player.Stamina > foodEnergyBefore)
            {
                Finish(cmd, true, "food consumed and energy recovered");
                return;
            }
            if ((DateTime.UtcNow - foodStartedAt).TotalSeconds > 15)
            {
                Finish(cmd, false, "eating did not restore energy in time");
            }
            return;
        }
        if ((DateTime.UtcNow - lastMovementDiagnostic).TotalSeconds >= 4 &&
            !Near(player.TilePoint, movementDestination.X, movementDestination.Y))
        {
            lastMovementDiagnostic = DateTime.UtcNow;
            Monitor.Log("Move progress " + cmd.Type + ": started=(" + movementOrigin.X + "," +
                movementOrigin.Y + "), now=(" + player.TilePoint.X + "," +
                player.TilePoint.Y + "), target=(" + movementDestination.X + "," +
                movementDestination.Y + "), controller=" + (player.controller != null),
                LogLevel.Info);
        }
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
            Finish(cmd, false, "movement or warp timed out: from (" +
                movementOrigin.X + "," + movementOrigin.Y + ") now (" +
                player.TilePoint.X + "," + player.TilePoint.Y + ") target (" +
                movementDestination.X + "," + movementDestination.Y + ")" +
                " controller=" + (player.controller != null));
        }
    }

    private void Finish(RemoteCommand cmd, bool ok, string message)
    {
        if (!ok) Monitor.Log("Command " + cmd.Type + " failed: " + message, LogLevel.Warn);
        if (active?.Id == cmd.Id)
        {
            active = null;
            activeExit = null;
            sleeping = false;
        }
        // Enqueue on the game thread; do not lose a completed command on transient HTTP errors.
        outboundResults.Enqueue(new CommandReceipt(cmd.Id, ok, message));
    }

    private async Task PostStateAsync(object snapshot)
    {
        try
        {
            using var res = await client!.PostAsJsonAsync("/state", snapshot);
            if (!res.IsSuccessStatusCode)
            {
                var details = await res.Content.ReadAsStringAsync();
                Monitor.Log("State sync rejected (HTTP " + (int)res.StatusCode + "): " +
                    details.Substring(0, Math.Min(details.Length, 1200)), LogLevel.Warn);
            }
        }
        catch (Exception ex) { Monitor.Log("State sync failed: " + ex, LogLevel.Warn); }
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
            if (cmd == null || string.IsNullOrWhiteSpace(cmd.Id)) return;
            lock (seenCommandIds)
            {
                if (!seenCommandIds.Add(cmd.Id)) return;
                seenCommandOrder.Enqueue(cmd.Id);
                while (seenCommandOrder.Count > 256)
                    seenCommandIds.Remove(seenCommandOrder.Dequeue());
            }
            incoming.Enqueue(cmd);
        }
        catch (Exception ex) { Monitor.Log("Poll: " + ex.Message, LogLevel.Trace); }
        finally { polling = false; }
    }
    private async Task FlushResultsAsync()
    {
        try
        {
            if (!outboundResults.TryPeek(out var receipt)) return;
            using var res = await client!.PostAsJsonAsync("/result",
                new { id = receipt.Id, ok = receipt.Ok, message = receipt.Message });
            if (res.IsSuccessStatusCode)
            {
                outboundResults.TryDequeue(out _);
                return;
            }
            if (res.StatusCode == System.Net.HttpStatusCode.Conflict)
            {
                // The controller may have restarted and no longer know this command ID.
                // Do not block future receipts forever, but make the loss visible.
                Monitor.Log("Controller rejected stale result for " + receipt.Id +
                    " (HTTP 409); verify game state before continuing", LogLevel.Warn);
                outboundResults.TryDequeue(out _);
                return;
            }
            Monitor.Log("Result delivery rejected (HTTP " + (int)res.StatusCode +
                "); will retry", LogLevel.Warn);
        }
        catch (Exception ex)
        {
            Monitor.Log("Result delivery failed; will retry: " + ex.Message, LogLevel.Trace);
        }
        finally { Interlocked.Exchange(ref resultPosting, 0); }
    }
}
