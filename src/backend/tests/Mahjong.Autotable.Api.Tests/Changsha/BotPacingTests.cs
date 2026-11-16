using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Threading.Channels;
using Mahjong.Autotable.Api.Changsha;
using Mahjong.Autotable.Api.Changsha.Bot;
using Mahjong.Autotable.Api.Changsha.Runtime;
using Mahjong.Autotable.Api.Tables;
using Mahjong.Autotable.Api.Tests.RulesQualification;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit.Abstractions;

namespace Mahjong.Autotable.Api.Tests.Changsha;

public sealed class BotPacingTests(ITestOutputHelper output)
{
    [Fact, Trait("Category", "Changsha")]
    public async Task ProductionDefaults_PaceDealerAndConsecutiveDrawDiscards()
    {
        await using var harness = new RuntimeHarness();
        await harness.CreateAsync([0, 1, 2]);

        var dealt = await harness.NextAsync(state =>
            state.Phase == ChangshaPhase.AwaitingDiscard && state.ActiveSeatIndex == 0);
        var discarded = await harness.NextEventAsync("tile-discarded", 0);
        AssertDwell(dealt, discarded, 1000, "dealer turn");

        foreach (var seat in new[] { 1, 2 })
        {
            var drawn = await harness.NextEventAsync("tile-drawn", seat);
            Assert.Equal(14, drawn.State.Hands[seat].ConcealedTiles.Count);
            Assert.DoesNotContain(drawn.State.DiscardPile, discard => discard.SeatIndex == seat);
            discarded = await harness.NextEventAsync("tile-discarded", seat);
            AssertDwell(drawn, discarded, 1000, $"seat {seat} draw -> discard");
            Assert.Equal(14, drawn.State.Hands[seat].ConcealedTiles.Count);
            Assert.Equal(13, discarded.State.Hands[seat].ConcealedTiles.Count);
            HudsonOwnTurnWsFixture.AssertInventory(discarded.State);
        }
    }

    [Theory, Trait("Category", "Changsha")]
    [InlineData(TableClaimType.Chow, null, null)]
    [InlineData(TableClaimType.Kong, null, null)]
    [InlineData(TableClaimType.Chow, 80, 60)]
    public async Task ConfiguredPacing_PacesBotClaimAndFollowingDiscard(
        TableClaimType claim, int? turnDelay, int? claimDelay)
    {
        await using var harness = new RuntimeHarness(turnDelay, claimDelay);
        var instance = await harness.CreateAsync([1], new ScriptedStrategy(claim: claim));
        Arrange(instance.State, new()
        {
            [0] = [19],
            [1] = claim == TableClaimType.Chow
                ? [8, 12, 20, 24, 40, 41, 42, 44, 45, 46, 72, 76, 88]
                : [16, 17, 18, 40, 41, 42, 44, 45, 46, 48, 49, 50, 52]
        });

        await harness.Runtime.DiscardAsync(instance.GameId, 0, 19);
        var opened = await harness.NextEventAsync("claim-window-open", 0);
        Assert.All(opened.State.ClaimWindow!.Opportunities,
            opportunity => Assert.Equal(1, opportunity.SeatIndex));
        Assert.Contains(opened.State.ClaimWindow.Opportunities, opportunity => opportunity.ClaimType == claim);

        var claimed = await harness.NextEventAsync("claim-resolved", 1);
        AssertDwell(opened, claimed, claimDelay ?? 650, "discard -> bot claim");
        Assert.Equal(ChangshaPhase.AwaitingDiscard, claimed.State.Phase);
        Assert.Equal(1, claimed.State.ActiveSeatIndex);
        Assert.DoesNotContain(claimed.State.EventLog, entry => entry.EventType == "tile-drawn");
        Assert.Equal(claim == TableClaimType.Kong, claimed.State.LastDrawWasKongReplacement);

        var discarded = await harness.NextEventAsync("tile-discarded", 1);
        AssertDwell(claimed, discarded, turnDelay ?? 1000, "claim/replacement -> discard");
        HudsonOwnTurnWsFixture.AssertInventory(discarded.State);
        if (turnDelay.HasValue)
        {
            var elapsed = Stopwatch.GetElapsedTime(opened.At, discarded.At);
            Assert.True(elapsed < TimeSpan.FromMilliseconds(850),
                $"Explicit fast configuration was not honoured: {elapsed.TotalMilliseconds:F1}ms.");
        }
    }

    [Theory, Trait("Category", "Changsha")]
    [InlineData(MeldKind.ConcealedKong)]
    [InlineData(MeldKind.AddedKong)]
    public async Task ProductionDefaults_PaceKongAndReplacementDiscard(MeldKind kind)
    {
        await using var harness = new RuntimeHarness();
        var strategy = new ScriptedStrategy(turn: (state, seat) =>
            state.Hands[seat].Melds.Any(meld => meld.Kind == kind)
                ? DiscardUnclaimable(state, seat)
                : kind == MeldKind.ConcealedKong
                    ? BotAction.DeclareConcealedKong(4)
                    : BotAction.DeclareAddedKong(19));
        var instance = await harness.CreateAsync([1], strategy);
        Arrange(instance.State, new()
        {
            [0] = [104],
            [1] = kind == MeldKind.ConcealedKong
                ? [16, 17, 18, 40, 41, 42, 44, 45, 46, 48, 49, 50, 52]
                : [40, 41, 42, 44, 45, 46, 48, 49, 50, 52]
        }, frontTile: 19, pung: kind == MeldKind.AddedKong);
        var replacementTile = instance.State.Wall[^1];
        Assert.Empty(new ClaimAdjudicator().GetOpportunities(0, 104, instance.State.Hands));

        await harness.Runtime.DiscardAsync(instance.GameId, 0, 104);
        var drawn = await harness.NextEventAsync("tile-drawn", 1);
        var replacement = await harness.NextEventAsync("kong-replacement-drawn", 1);
        AssertDwell(drawn, replacement, 1000, $"draw -> {kind}");
        Assert.Equal(kind, Assert.Single(replacement.State.Hands[1].Melds).Kind);
        Assert.Equal(replacementTile, replacement.State.Hands[1].ConcealedTiles[^1]);
        Assert.Equal(drawn.State.Wall.Count - 1, replacement.State.Wall.Count);
        Assert.True(replacement.State.LastDrawWasKongReplacement);

        var discarded = await harness.NextEventAsync("tile-discarded", 1);
        AssertDwell(replacement, discarded, 1000, $"{kind} replacement -> discard");
        Assert.Equal(2, strategy.InvocationCount);
        HudsonOwnTurnWsFixture.AssertInventory(discarded.State);
    }

    [Fact, Trait("Category", "Changsha")]
    public async Task PendingBotClaim_DoesNotDelayHigherPriorityHumanHu()
    {
        await using var harness = new RuntimeHarness(claimDelay: 2000);
        var strategy = new ScriptedStrategy(claim: TableClaimType.Kong);
        var instance = await harness.CreateAsync([1], strategy);
        Arrange(instance.State, new()
        {
            [0] = [19],
            [1] = [16, 17, 18, 40, 41, 42, 44, 45, 46, 48, 49, 50, 52],
            [2] = [0, 1, 2, 24, 25, 26, 60, 61, 62, 88, 89, 8, 12]
        });
        await harness.Runtime.DiscardAsync(instance.GameId, 0, 19);
        var opened = await harness.NextEventAsync("claim-window-open", 0);
        Assert.Contains(opened.State.ClaimWindow!.Opportunities,
            opportunity => opportunity.SeatIndex == 1 && opportunity.ClaimType == TableClaimType.Kong);
        Assert.Contains(opened.State.ClaimWindow.Opportunities,
            opportunity => opportunity.SeatIndex == 2 && opportunity.ClaimType == TableClaimType.Hu);

        var timer = Stopwatch.StartNew();
        await harness.Runtime.ClaimAsync(instance.GameId, 2, "hu", null)
            .WaitAsync(TimeSpan.FromSeconds(1));
        output.WriteLine($"Human Hu accepted in {timer.Elapsed.TotalMilliseconds:F1}ms while bot waited 2000ms.");
        Assert.Equal(2, instance.State.CurrentWin!.WinningSeatIndex);
        Assert.Equal(0, strategy.InvocationCount);
        Assert.True(instance.ClaimWindowCts!.IsCancellationRequested);
    }

    [Fact, Trait("Category", "Changsha")]
    public async Task PendingBotTurn_HumanTakeoverCanDiscardImmediately_WithoutLateBotAction()
    {
        await using var harness = new RuntimeHarness(turnDelay: 500);
        var strategy = new ScriptedStrategy();
        var instance = await harness.CreateAsync([0], strategy);
        await harness.NextAsync(state => state.Phase == ChangshaPhase.AwaitingDiscard);
        var tile = DiscardUnclaimable(instance.State, 0).TileId!.Value;

        var timer = Stopwatch.StartNew();
        Assert.Equal(0, await harness.Runtime.TakeSeatAsync(instance.GameId, "pacing-human", "pacing-connection", 0)
            .WaitAsync(TimeSpan.FromMilliseconds(400)));
        await harness.Runtime.DiscardAsync(instance.GameId, 0, tile)
            .WaitAsync(TimeSpan.FromMilliseconds(400));
        output.WriteLine($"Human takeover/discard accepted in {timer.Elapsed.TotalMilliseconds:F1}ms.");
        var discarded = await harness.NextEventAsync("tile-discarded", 0);
        var version = instance.State.StateVersion;

        await Task.Delay(650);
        Assert.Equal(0, strategy.InvocationCount);
        Assert.Equal(version, instance.State.StateVersion);
        Assert.Single(instance.State.EventLog.Where(entry => entry.EventType == "tile-discarded"));
        Assert.False(discarded.State.Seats[0].IsBot);
    }

    [Theory, Trait("Category", "Changsha")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Removal_CancelsPendingBotTurnOrClaim_WithoutLateMutation(bool duringClaim)
    {
        await using var harness = new RuntimeHarness(turnDelay: 400, claimDelay: 400);
        var strategy = new ScriptedStrategy(claim: TableClaimType.Chow);
        var instance = await harness.CreateAsync(duringClaim ? [1] : [0], strategy);
        if (duringClaim)
        {
            Arrange(instance.State, new()
            {
                [0] = [19],
                [1] = [8, 12, 20, 24, 40, 41, 42, 44, 45, 46, 72, 76, 88]
            });
            await harness.Runtime.DiscardAsync(instance.GameId, 0, 19);
            await harness.NextEventAsync("claim-window-open", 0);
        }
        else
        {
            await harness.NextAsync(state => state.Phase == ChangshaPhase.AwaitingDiscard);
        }
        var lifecycle = instance.LifecycleCts.Token;
        var timer = Stopwatch.StartNew();
        await harness.Runtime.RemoveGameAsync(instance.GameId).WaitAsync(TimeSpan.FromSeconds(2));
        var version = instance.State.StateVersion;
        var eventCount = instance.State.EventLog.Count;
        await Task.Delay(550);

        output.WriteLine($"Removed pending bot {(duringClaim ? "claim" : "turn")}; observed for {timer.Elapsed.TotalMilliseconds:F1}ms.");
        Assert.True(lifecycle.IsCancellationRequested);
        Assert.False(harness.Runtime.TryGetSnapshot(instance.GameId, out _));
        Assert.Equal(0, strategy.InvocationCount);
        Assert.Equal(version, instance.State.StateVersion);
        Assert.Equal(eventCount, instance.State.EventLog.Count);
    }

    [Fact, Trait("Category", "Changsha")]
    public async Task SupersededClaimWindow_CannotMakeTheNextBotResponseEarly()
    {
        await using var harness = new RuntimeHarness(turnDelay: 2000, claimDelay: 400);
        var strategy = new ScriptedStrategy(claim: TableClaimType.Pung);
        var instance = await harness.CreateAsync([2], strategy);
        Arrange(instance.State, new() { [0] = [19], [1] = [16], [2] = [17, 18] });
        await harness.Runtime.DiscardAsync(instance.GameId, 0, 19);
        var first = await harness.NextEventAsync("claim-window-open", 0);
        Assert.All(first.State.ClaimWindow!.Opportunities, opportunity => Assert.Equal(2, opportunity.SeatIndex));
        var oldWindowCancellation = instance.ClaimWindowCts!.Token;

        await Task.Delay(200);
        await harness.Runtime.PassAsync(instance.GameId, 2);
        Assert.True(oldWindowCancellation.IsCancellationRequested);
        Assert.Equal(1, instance.State.ActiveSeatIndex);
        await harness.Runtime.DiscardAsync(instance.GameId, 1, 16);
        var second = await harness.NextEventAsync("claim-window-open", 1);
        Assert.All(second.State.ClaimWindow!.Opportunities, opportunity => Assert.Equal(2, opportunity.SeatIndex));

        var claimed = await harness.NextEventAsync("claim-resolved", 2);
        AssertDwell(second, claimed, 400, "superseding window -> bot claim");
        Assert.Equal(1, strategy.InvocationCount);
        Assert.Equal(16, Assert.Single(claimed.State.Hands[2].Melds).TileIds.Single(tile => tile == 16));
        Assert.Contains(claimed.State.DiscardPile, discard => discard.TileId == 19);
        HudsonOwnTurnWsFixture.AssertInventory(claimed.State);
    }

    private void AssertDwell(ObservedSnapshot before, ObservedSnapshot after, int minimumMs, string action)
    {
        var elapsed = Stopwatch.GetElapsedTime(before.At, after.At);
        output.WriteLine($"{action}: {elapsed.TotalMilliseconds:F1}ms (configured minimum {minimumMs}ms).");
        Assert.True(elapsed >= TimeSpan.FromMilliseconds(minimumMs - 20),
            $"{action} published after {elapsed.TotalMilliseconds:F1}ms; expected at least {minimumMs}ms (20ms timer tolerance).");
    }

    private static BotAction DiscardUnclaimable(ChangshaGameState state, int seat)
    {
        var adjudicator = new ClaimAdjudicator();
        return BotAction.Discard(state.Hands[seat].ConcealedTiles.First(tile =>
            adjudicator.GetOpportunities(seat, tile, state.Hands).Count == 0));
    }

    private static void Arrange(ChangshaGameState state, Dictionary<int, int[]> hands,
        int? frontTile = null, bool pung = false)
    {
        foreach (var hand in state.Hands)
        {
            hand.ConcealedTiles.Clear();
            hand.Melds.Clear();
            if (hands.TryGetValue(hand.SeatIndex, out var tiles)) hand.ConcealedTiles.AddRange(tiles);
        }
        if (pung)
            state.Hands[1].Melds.Add(new Meld
            {
                Kind = MeldKind.Pung, TileIds = [16, 17, 18], ClaimedFromSeatIndex = 3
            });
        var assigned = state.Hands.SelectMany(hand =>
            hand.ConcealedTiles.Concat(hand.Melds.SelectMany(meld => meld.TileIds))).ToArray();
        var used = assigned.ToHashSet();
        Assert.Equal(assigned.Length, used.Count);
        if (frontTile.HasValue) Assert.True(used.Add(frontTile.Value));
        // Conserved physical tiles, with no incidental Wan-5 or Tiao-9 claims from filler hands.
        int[] fillerKinds = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22];
        var filler = Enumerable.Range(0, 4)
            .SelectMany(copy => fillerKinds.Select(kind => kind * 4 + copy)).ToArray();
        foreach (var hand in state.Hands)
        {
            var count = (hand.SeatIndex == 0 ? 14 : 13) - 3 * hand.Melds.Count;
            foreach (var tile in filler.Where(tile => !used.Contains(tile)))
            {
                if (hand.ConcealedTiles.Count == count) break;
                Assert.True(used.Add(tile));
                hand.ConcealedTiles.Add(tile);
            }
            Assert.Equal(count, hand.ConcealedTiles.Count);
        }
        state.Wall = (frontTile.HasValue ? new[] { frontTile.Value } : [])
            .Concat(Enumerable.Range(0, 108).Where(tile => !used.Contains(tile))).ToList();
        state.WallDrawIndex = state.WallBackDrawn = 0;
        state.WallBackIndex = state.Wall.Count - 1;
        state.DiscardPile.Clear();
        state.LastDrawSeatIndex = null;
        state.LastDrawWasKongReplacement = false;
        state.TurnNumber = 3;
        state.DiscardsThisHand = 1;
        HudsonOwnTurnWsFixture.AssertInventory(state);
    }

    private sealed record ObservedSnapshot(long At, ChangshaGameState State);

    private sealed class RuntimeHarness : IAsyncDisposable
    {
        private readonly WebApplicationFactory<Program> _factory;
        private readonly string _database;
        private readonly Channel<ObservedSnapshot> _snapshots = Channel.CreateUnbounded<ObservedSnapshot>();
        public IChangshaGameRuntime Runtime { get; }

        public RuntimeHarness(int? turnDelay = null, int? claimDelay = null)
        {
            var directory = Path.Combine(AppContext.BaseDirectory, "test-data");
            Directory.CreateDirectory(directory);
            _database = Path.Combine(directory, $"bot-pacing-{Guid.NewGuid():N}.db");
            _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            {
                builder.UseEnvironment("Development");
                builder.UseSetting("Persistence:Provider", "Sqlite");
                builder.UseSetting("ConnectionStrings:Sqlite", $"Data Source={_database};Pooling=False");
                if (turnDelay.HasValue)
                    builder.UseSetting("ChangshaRuntime:BotTurnDelayMs", turnDelay.Value.ToString(CultureInfo.InvariantCulture));
                if (claimDelay.HasValue)
                    builder.UseSetting("ChangshaRuntime:BotClaimDelayMs", claimDelay.Value.ToString(CultureInfo.InvariantCulture));
                builder.ConfigureLogging(logging => logging.ClearProviders());
                builder.ConfigureServices(services =>
                    services.Configure<ChangshaRuntimeOptions>(options => options.PersistSnapshots = false));
            });
            Runtime = _factory.Services.GetRequiredService<IChangshaGameRuntime>();
            Runtime.StateChanged += OnChanged;
        }

        public async Task<ChangshaGameInstance> CreateAsync(int[] bots, ScriptedStrategy? strategy = null)
        {
            var id = await Runtime.CreateGameAsync(42, bots, null, null, maxHands: 1);
            var instances = Assert.IsType<ConcurrentDictionary<string, ChangshaGameInstance>>(
                typeof(ChangshaGameRuntime).GetField("_games", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .GetValue(Runtime));
            var instance = instances[id];
            instance.State.DealMode = DealMode.Auto;
            instance.BotStrategy = strategy ?? new ScriptedStrategy();
            await Runtime.StartGameAsync(id);
            return instance;
        }

        private void OnChanged(string _, ChangshaGameState state) =>
            _snapshots.Writer.TryWrite(new(Stopwatch.GetTimestamp(), state));

        public Task<ObservedSnapshot> NextEventAsync(string type, int seat) =>
            NextAsync(state => state.EventLog.Any(entry => entry.EventType == type && entry.SeatIndex == seat));

        public async Task<ObservedSnapshot> NextAsync(Func<ChangshaGameState, bool> predicate)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (true)
            {
                var snapshot = await _snapshots.Reader.ReadAsync(timeout.Token);
                if (predicate(snapshot.State)) return snapshot;
            }
        }

        public async ValueTask DisposeAsync()
        {
            Runtime.StateChanged -= OnChanged;
            await _factory.DisposeAsync();
            foreach (var file in new[] { _database, _database + "-wal", _database + "-shm" })
                if (File.Exists(file)) File.Delete(file);
        }
    }

    private sealed class ScriptedStrategy(
        Func<ChangshaGameState, int, BotAction>? turn = null, TableClaimType? claim = null) : IChangshaBotStrategy
    {
        private int _invocationCount;
        public int InvocationCount => Volatile.Read(ref _invocationCount);
        public string Difficulty => "pacing-test";
        public BotAction OnTurnStart(ChangshaGameState state, int seat) => DecideAction(state, seat);
        public BotAction OnSelfDraw(ChangshaGameState state, int seat) => DecideAction(state, seat);
        public BotAction OnOtherDiscard(ChangshaGameState state, int seat, int discarder, int tile) => DecideAction(state, seat);
        public BotAction OnPickupCue(ChangshaGameState state, int seat) => BotAction.Wait();

        public BotAction DecideAction(ChangshaGameState state, int seat)
        {
            Interlocked.Increment(ref _invocationCount);
            return state.Phase == ChangshaPhase.AwaitingClaim
                ? claim.HasValue ? BotAction.Claim(claim.Value) : BotAction.Pass()
                : (turn ?? DiscardUnclaimable)(state, seat);
        }
    }
}
