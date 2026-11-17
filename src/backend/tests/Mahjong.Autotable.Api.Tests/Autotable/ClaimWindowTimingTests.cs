using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Mahjong.Autotable.Api.Autotable;
using Mahjong.Autotable.Api.Changsha;
using Mahjong.Autotable.Api.Changsha.Runtime;
using Mahjong.Autotable.Api.Players;
using Mahjong.Autotable.Api.Tests.RulesQualification;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit.Abstractions;

namespace Mahjong.Autotable.Api.Tests.Autotable;

public sealed class ClaimWindowTimingTests(ITestOutputHelper output)
{
    [Fact, Trait("Category", "Changsha")]
    public async Task DefaultDeadline_IsEightSeconds_RejoinDoesNotExtend_AndHumanPungResolvesEarly()
    {
        await using var harness = new RuntimeHarness();
        await using var table = await harness.OpenWindowAsync("pung-no-draw");
        var openedAt = table.State.ClaimWindow!.OpenedAtUnixMs;
        var prompt = Claim(await table.Peer.BarrierAsync());
        var deadline = prompt.GetProperty("deadline").GetInt64();
        Assert.Equal(openedAt + 8000, deadline);
        Assert.Contains("Pung", prompt.GetProperty("available").EnumerateArray().Select(value => value.GetString()));

        await Task.Delay(200);
        var refreshed = Claim(await table.Peer.BarrierAsync());
        Assert.Equal(deadline, refreshed.GetProperty("deadline").GetInt64());
        Assert.Equal(openedAt, table.State.ClaimWindow!.OpenedAtUnixMs);
        await SendClaimAsync(table, refreshed, "Pung");
        await table.Peer.BarrierAsync();

        var state = await harness.Runtime.TryGetSnapshotCopyAsync(table.GameId);
        Assert.NotNull(state);
        Assert.Null(state.ClaimWindow);
        Assert.Equal(MeldKind.Pung, Assert.Single(state.Hands[0].Melds).Kind);
        Assert.Equal(0, state.ActiveSeatIndex);
        var elapsed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - openedAt;
        output.WriteLine($"Default advertised deadline: {deadline - openedAt}ms; human Pung resolved after {elapsed}ms.");
        Assert.True(elapsed < 5000, $"Early Pung incorrectly waited for the total window: {elapsed}ms.");
        HudsonOwnTurnWsFixture.AssertInventory(state);
    }

    [Fact, Trait("Category", "Changsha")]
    public async Task DefaultWindow_AcceptsEligibleHumanChowAfterOldFiveSecondCutoff()
    {
        await using var harness = new RuntimeHarness();
        await using var table = await harness.OpenWindowAsync("chow-options");
        var openedAt = table.State.ClaimWindow!.OpenedAtUnixMs;
        var prompt = Claim(await table.Peer.BarrierAsync());
        Assert.Contains("Chow", prompt.GetProperty("available").EnumerateArray().Select(value => value.GetString()));

        await DelayUntilAsync(openedAt + 5300);
        await SendClaimAsync(table, prompt, "Chow");
        await table.Peer.BarrierAsync();

        var state = await harness.Runtime.TryGetSnapshotCopyAsync(table.GameId);
        Assert.NotNull(state);
        var chow = Assert.Single(state.Hands[0].Melds);
        Assert.Equal(MeldKind.Chow, chow.Kind);
        Assert.Contains(19, chow.TileIds);
        Assert.Null(state.ClaimWindow);
        Assert.Equal(0, state.ActiveSeatIndex);
        var elapsed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - openedAt;
        output.WriteLine($"Eligible human Chow accepted after {elapsed}ms (old cutoff 5000ms).");
        Assert.InRange(elapsed, 5300L, 7999L);
        HudsonOwnTurnWsFixture.AssertInventory(state);
    }

    [Theory, Trait("Category", "Changsha")]
    [InlineData(800)]
    [InlineData(1800)]
    public async Task ExplicitTimeout_RejoinKeepsOriginalDeadlineAndAutoPassSchedule(int timeoutMs)
    {
        await using var harness = new RuntimeHarness(timeoutMs);
        var passed = new TaskCompletionSource<(long At, ChangshaGameState State)>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        void OnChanged(string _, ChangshaGameState state)
        {
            if (state.EventLog.Any(entry => entry.EventType == "claim-passed"))
                passed.TrySetResult((DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state));
        }
        harness.Runtime.StateChanged += OnChanged;
        try
        {
            await using var table = await harness.OpenWindowAsync("chow-options");
            var openedAt = table.State.ClaimWindow!.OpenedAtUnixMs;
            var prompt = Claim(await table.Peer.BarrierAsync());
            var deadline = prompt.GetProperty("deadline").GetInt64();
            Assert.Equal(openedAt + timeoutMs, deadline);

            await DelayUntilAsync(openedAt + timeoutMs / 2);
            var refreshed = Claim(await table.Peer.BarrierAsync());
            Assert.Equal(deadline, refreshed.GetProperty("deadline").GetInt64());
            Assert.Equal(openedAt, table.State.ClaimWindow!.OpenedAtUnixMs);

            var resolved = await passed.Task.WaitAsync(TimeSpan.FromSeconds(4));
            output.WriteLine($"Configured {timeoutMs}ms: auto-pass after {resolved.At - openedAt}ms despite mid-window rejoin.");
            Assert.InRange(resolved.At - openedAt, timeoutMs - 20L, timeoutMs + 300L);
            Assert.Null(resolved.State.ClaimWindow);
            Assert.Empty(resolved.State.Hands[0].Melds);
            Assert.Equal(JsonValueKind.Null, Claim(await table.Peer.BarrierAsync()).ValueKind);
            HudsonOwnTurnWsFixture.AssertInventory(resolved.State);
        }
        finally
        {
            harness.Runtime.StateChanged -= OnChanged;
        }
    }

    private static JsonElement Claim(JsonElement frame) =>
        Assert.Single(frame.GetProperty("entries").EnumerateArray().Where(entry =>
            entry[0].GetString() == "claim" && entry[1].ToString() == "0"))[2];

    private static Task SendClaimAsync(HudsonOwnTurnWsFixture.HumanTable table, JsonElement prompt, string type) =>
        table.Peer.UpdateAsync([new object[]
        {
            "claim", table.Seat, new
            {
                action = "claim",
                type,
                gameId = prompt.GetProperty("gameId").GetString(),
                expectedVersion = prompt.GetProperty("stateVersion").GetInt32(),
                tileIds = type == "Chow"
                    ? prompt.GetProperty("chowOptions")[0].EnumerateArray().Select(value => value.GetInt32()).ToArray()
                    : null
            }
        }]);

    private static Task DelayUntilAsync(long unixMs) =>
        Task.Delay(TimeSpan.FromMilliseconds(Math.Max(0, unixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())));

    private sealed class RuntimeHarness : IAsyncDisposable
    {
        private readonly WebApplicationFactory<Program> _factory;
        private readonly string _database;
        public IChangshaGameRuntime Runtime => _factory.Services.GetRequiredService<IChangshaGameRuntime>();

        public RuntimeHarness(int? timeoutMs = null)
        {
            var directory = Path.Combine(AppContext.BaseDirectory, "test-data");
            Directory.CreateDirectory(directory);
            _database = Path.Combine(directory, $"claim-window-timing-{Guid.NewGuid():N}.db");
            var signingKey = Convert.ToBase64String(RandomNumberGenerator.GetBytes(48));
            _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            {
                builder.UseEnvironment("Development");
                builder.UseSetting("Persistence:Provider", "Sqlite");
                builder.UseSetting("ConnectionStrings:Sqlite", $"Data Source={_database};Pooling=False");
                builder.UseSetting("Authentication:JwtSigningKeys:0", signingKey);
                if (timeoutMs.HasValue)
                    builder.UseSetting("ChangshaRuntime:ClaimWindowTimeoutMs", timeoutMs.Value.ToString(CultureInfo.InvariantCulture));
                builder.ConfigureLogging(logging => logging.ClearProviders());
                builder.ConfigureServices(services =>
                    services.Configure<ChangshaRuntimeOptions>(options => options.PersistSnapshots = false));
            });
        }

        public async Task<HudsonOwnTurnWsFixture.HumanTable> OpenWindowAsync(string scenario)
        {
            var playerId = $"claim-timing-{Guid.NewGuid():N}";
            var room = $"claim-window-{Guid.NewGuid():N}";
            var server = _factory.Server;
            var client = server.CreateWebSocketClient();
            var identity = _factory.Services.GetRequiredService<PlayerIdentityService>().Protect(playerId);
            client.ConfigureRequest = request =>
                request.Headers["Cookie"] = $"{PlayerIdentityService.CookieName}={identity}";
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var socket = await client.ConnectAsync(new Uri(server.BaseAddress,
                "ws?variant=changsha&bots=false&botCount=0&dealMode=manual&handCount=1&seed=20260912"), timeout.Token);
            var peer = new HudsonOwnTurnWsFixture.WsPeer(socket, room, playerId);
            try
            {
                await peer.BarrierAsync();
                await peer.UpdateAsync([new object[] { "ephemeral", "claim", true }]);
                await peer.BarrierAsync();
                await peer.UpdateAsync([new object[] { "seats", playerId, new { seat = 0 } }]);
                await peer.BarrierAsync();
                var id = _factory.Services.GetRequiredService<AutotableConnectionManager>()
                    .GetRuntimeGameIdBoundTo(room);
                Assert.NotNull(id);
                Assert.True(Runtime.TryGetSnapshot(id, out var state));
                Assert.NotNull(state);
                var table = new HudsonOwnTurnWsFixture.HumanTable(room, id, 0, state, peer);
                var fixture = HudsonOwnTurnWsFixture.ArrangeBeforeDraw(table, scenario);
                HudsonOwnTurnWsFixture.ArrangeIncomingDiscard(table, fixture);
                await Runtime.DiscardAsync(id, 3, fixture.DrawTile);
                Assert.Equal(ChangshaPhase.AwaitingClaim, state.Phase);
                Assert.All(state.ClaimWindow!.Opportunities, opportunity => Assert.Equal(0, opportunity.SeatIndex));
                return table;
            }
            catch
            {
                await peer.DisposeAsync();
                throw;
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _factory.DisposeAsync();
            foreach (var file in new[] { _database, _database + "-wal", _database + "-shm" })
                if (File.Exists(file)) File.Delete(file);
        }
    }
}
