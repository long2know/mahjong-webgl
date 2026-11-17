using System.Text.Json;
using Mahjong.Autotable.Api.Autotable;
using Mahjong.Autotable.Api.Changsha;
using Mahjong.Autotable.Api.Changsha.Replay;
using Mahjong.Autotable.Api.Tests.RulesQualification;

namespace Mahjong.Autotable.Api.Tests.Autotable;

public sealed class BotDisplayNameTests
{
    [Fact]
    public void BotRosterNames_AreDistinctAndStableAcrossViewersAndSnapshotRecovery()
    {
        var (state, _) = ChangshaGameStateMachine.CreateGame(42, [0, 1, 2, 3]);
        var original = ChangshaReplayStateCodec.Serialize(state);
        var names = Nicknames(ChangshaToAutotableTranslator.Translate(state));
        Assert.Equal(4, names.Values.Distinct(StringComparer.Ordinal).Count());
        Assert.All(names.Values, name => Assert.DoesNotMatch(@"^Bot\s*\d+$", name));

        foreach (var viewer in new int?[] { null, 0, 1, 2, 3 })
        {
            var recovered = ChangshaReplayStateCodec.RoundTrip(state);
            Assert.Equal(names.OrderBy(pair => pair.Key),
                Nicknames(ChangshaToAutotableTranslator.Translate(recovered, viewer)).OrderBy(pair => pair.Key));
            Assert.Equal(original, ChangshaReplayStateCodec.Serialize(recovered));
            Assert.All(recovered.Seats, seat =>
            {
                Assert.True(seat.IsBot);
                Assert.Equal($"bot-{seat.SeatIndex}", seat.PlayerId);
            });
        }
    }

    [Fact]
    public void HumanWithBotLikeIdentity_RemainsHumanAndKeepsExistingHumanNaming()
    {
        var (state, _) = ChangshaGameStateMachine.CreateGame(42, [1, 2, 3]);
        state.Seats[0].PlayerId = "bot-custom-human";
        var names = Nicknames(ChangshaToAutotableTranslator.Translate(state));

        Assert.Equal("Seat 0", names["bot-custom-human"]);
        Assert.False(state.Seats[0].IsBot);
        Assert.Equal("bot-custom-human", state.Seats[0].PlayerId);
        Assert.All(state.Seats.Skip(1), seat => Assert.DoesNotMatch(@"^Bot\s*\d+$", names[seat.PlayerId]));
    }

    [Fact]
    public async Task WsRosterAndWinningResult_KeepNamesAcrossRejoin_AndPreserveCustomBotName()
    {
        await using var host = new HudsonOwnTurnWsFixture();
        var room = $"bot-names-{Guid.NewGuid():N}";
        var playerId = $"bot-names-human-{Guid.NewGuid():N}";
        var socket = await host.OpenSocketAsync(
            "variant=changsha&bots=true&botCount=3&dealMode=manual&handCount=1&seed=20260912", playerId);
        await using var peer = new HudsonOwnTurnWsFixture.WsPeer(socket, room, playerId);
        await peer.BarrierAsync();
        await peer.UpdateAsync([new object[] { "nicks", "bot-2", "WillowOtter" }]);
        await peer.BarrierAsync();
        await peer.UpdateAsync([new object[] { "seats", peer.PlayerId, new { seat = 0 } }]);
        await peer.BarrierAsync();
        var id = host.Manager.GetRuntimeGameIdBoundTo(room);
        Assert.NotNull(id);
        var roster = await peer.BarrierAsync();
        var names = Nicknames(roster);
        Assert.Equal("WillowOtter", names["bot-2"]);
        Assert.All(new[] { "bot-1", "bot-3" }, bot => Assert.DoesNotMatch(@"^Bot\s*\d+$", names[bot]));
        Assert.True(host.Runtime.TryGetSnapshot(id, out var state));
        Assert.NotNull(state);

        var table = new HudsonOwnTurnWsFixture.HumanTable(room, id, 1, state, peer);
        var fixture = HudsonOwnTurnWsFixture.ArrangeBeforeDraw(table, "hu-14");
        state.MaxHands = 4;
        await host.Runtime.DiscardAsync(id, 0, 104);
        Assert.Equal(fixture.DrawTile, state.Hands[1].ConcealedTiles[^1]);
        await host.Runtime.DeclareWinAsync(id, 1);
        Assert.Equal(ChangshaPhase.EndHand, state.Phase);
        var resultFrame = await peer.BarrierAsync();
        var result = Entry(resultFrame, "result", "current");
        Assert.Equal(1, result.GetProperty("winner").GetInt32());
        Assert.Equal(names.OrderBy(pair => pair.Key), Nicknames(resultFrame).OrderBy(pair => pair.Key));
        Assert.Equal(names["bot-1"], WinnerName(resultFrame));
        var groups = result.GetProperty("handGroups");
        Assert.Equal(result.GetProperty("hand").EnumerateArray().Select(tile => tile.GetInt32()).Order(),
            groups.EnumerateArray().SelectMany(group => group.GetProperty("tileIds").EnumerateArray())
                .Select(tile => tile.GetInt32()).Order());

        await using var spectator = await host.ConnectAsync(room);
        var rejoined = await spectator.BarrierAsync();
        Assert.Equal(names["bot-1"], WinnerName(rejoined));
        Assert.Equal("WillowOtter", Nicknames(rejoined)["bot-2"]);
        Assert.Equal(groups.GetRawText(), Entry(rejoined, "result", "current").GetProperty("handGroups").GetRawText());
        Assert.All(state.Seats.Skip(1), seat =>
        {
            Assert.True(seat.IsBot);
            Assert.Equal($"bot-{seat.SeatIndex}", seat.PlayerId);
        });
        HudsonOwnTurnWsFixture.AssertInventory(state);
    }

    private static string WinnerName(JsonElement frame)
    {
        var winner = Entry(frame, "result", "current").GetProperty("winner").GetInt32();
        var player = Assert.Single(frame.GetProperty("entries").EnumerateArray(), entry =>
            entry[0].GetString() == "seats" && entry[2].ValueKind == JsonValueKind.Object
            && entry[2].GetProperty("seat").GetInt32() == winner)[1].GetString()!;
        return Nicknames(frame)[player];
    }

    private static Dictionary<string, string> Nicknames(IReadOnlyList<CollectionEntry> entries) =>
        entries.Where(entry => entry.Kind == "nicks")
            .ToDictionary(entry => entry.Key!.ToString()!, entry => Assert.IsType<string>(entry.Value));

    private static Dictionary<string, string> Nicknames(JsonElement frame) =>
        frame.GetProperty("entries").EnumerateArray().Where(entry =>
                entry[0].GetString() == "nicks" && entry[2].ValueKind == JsonValueKind.String)
            .ToDictionary(entry => entry[1].GetString()!, entry => entry[2].GetString()!);

    private static JsonElement Entry(JsonElement frame, string kind, string key) =>
        Assert.Single(frame.GetProperty("entries").EnumerateArray(), entry =>
            entry[0].GetString() == kind && entry[1].ToString() == key)[2];
}
