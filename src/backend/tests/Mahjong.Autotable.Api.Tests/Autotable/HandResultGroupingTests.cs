using System.Text.Json;
using Mahjong.Autotable.Api.Autotable;
using Mahjong.Autotable.Api.Changsha;
using Mahjong.Autotable.Api.Changsha.Replay;
using Mahjong.Autotable.Api.Tables;
using Mahjong.Autotable.Api.Tests.RulesQualification;
using Xunit.Abstractions;

namespace Mahjong.Autotable.Api.Tests.Autotable;

public sealed class HandResultGroupingTests(ITestOutputHelper output)
{
    private static readonly int[] ScreenshotHand = [4, 56, 20, 76, 5, 60, 28, 77, 78, 52, 24, 8, 12, 16];

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ScreenshotWin_UsesValidatedSetsAndPair_WithStablePhysicalCopies(bool heavenly)
    {
        var state = Scored(ScreenshotHand, heavenly: heavenly);
        Assert.Equal(heavenly ? WinPattern.HeavenlyHand : WinPattern.Standard, state.CurrentWin!.Pattern);
        var original = ChangshaReplayStateCodec.Serialize(state);
        var result = Result(state);
        var groups = Groups(state, result);

        Assert.Equal(5, groups.Length);
        Assert.Equal(3, groups.Count(group => Kind(group) == "chow"));
        Assert.Contains(groups, group => Kind(group) == "pung" && Tiles(group).SequenceEqual([76, 77, 78]));
        Assert.Contains(groups, group => Kind(group) == "pair" && Tiles(group).SequenceEqual([4, 5]));
        Assert.All(groups, group => Assert.False(group.GetProperty("exposed").GetBoolean()));
        Assert.Equal(ScreenshotHand, result.GetProperty("hand").EnumerateArray().Select(tile => tile.GetInt32()));
        Assert.Equal(original, ChangshaReplayStateCodec.Serialize(state));

        var recovered = ChangshaReplayStateCodec.RoundTrip(state);
        recovered.Hands[0].ConcealedTiles.Reverse();
        Assert.Equal(result.GetProperty("handGroups").GetRawText(), Result(recovered).GetProperty("handGroups").GetRawText());
        Assert.Equal(result.GetProperty("scoreResult").GetRawText(), Result(recovered).GetProperty("scoreResult").GetRawText());
        output.WriteLine($"Screenshot {state.CurrentWin.Pattern}: {result.GetProperty("handGroups").GetRawText()}");
    }

    [Fact]
    public void FullFlush_UsesItsExistingAnyPairExemption_NotTheStandard258Restriction()
    {
        var state = Scored([0, 4, 8, 12, 16, 20, 24, 28, 32, 5, 9, 13, 33, 34]);
        Assert.Equal(WinPattern.FullFlush, state.CurrentWin!.Pattern);
        var groups = Groups(state, Result(state));

        Assert.Equal(4, groups.Count(group => Kind(group) == "chow"));
        var pair = Assert.Single(groups, group => Kind(group) == "pair");
        Assert.Equal([33, 34], Tiles(pair));
    }

    [Fact]
    public void AllPungs_DoesNotDisplayAnAlternativeChowDecompositionAsItsScoringExplanation()
    {
        var state = Scored([0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17]);
        Assert.Equal(WinPattern.AllPungs, state.CurrentWin!.Pattern);
        var groups = Groups(state, Result(state));

        Assert.Equal(4, groups.Count(group => Kind(group) == "pung"));
        Assert.DoesNotContain(groups, group => Kind(group) == "chow");
        Assert.Single(groups, group => Kind(group) == "pair");
    }

    [Fact]
    public void SevenPairs_FourPhysicalCopiesBecomeTwoPairs_NotAnInventedKong()
    {
        var state = Scored([0, 1, 2, 3, 12, 13, 40, 41, 56, 57, 72, 73, 96, 97]);
        Assert.Equal(WinPattern.SevenPairs, state.CurrentWin!.Pattern);
        var groups = Groups(state, Result(state));

        Assert.Equal(7, groups.Length);
        Assert.All(groups, group =>
        {
            Assert.Equal("pair", Kind(group));
            Assert.Equal(2, Tiles(group).Length);
            Assert.False(group.GetProperty("exposed").GetBoolean());
        });
        Assert.Contains(groups, group => Tiles(group).SequenceEqual([0, 1]));
        Assert.Contains(groups, group => Tiles(group).SequenceEqual([2, 3]));
    }

    [Theory]
    [InlineData(MeldKind.Chow, "chow", true)]
    [InlineData(MeldKind.Pung, "pung", true)]
    [InlineData(MeldKind.ExposedKong, "exposedKong", true)]
    [InlineData(MeldKind.ConcealedKong, "concealedKong", false)]
    [InlineData(MeldKind.AddedKong, "addedKong", true)]
    public void DeclaredMelds_KeepTheirActualKindExposureAndAllKongTiles(MeldKind kind, string wireKind, bool exposed)
    {
        var tiles = kind switch
        {
            MeldKind.Chow => new[] { 0, 4, 8 },
            MeldKind.Pung => [0, 1, 2],
            _ => [0, 1, 2, 3]
        };
        var state = Scored([12, 16, 20, 36, 40, 44, 72, 76, 80, 88, 89],
            new Meld { Kind = kind, TileIds = tiles.ToList(), ClaimedFromSeatIndex = exposed ? 1 : null });
        var result = Result(state);
        var groups = Groups(state, result);
        var declared = Assert.Single(groups, group => Tiles(group).SequenceEqual(tiles));

        Assert.Equal(wireKind, Kind(declared));
        Assert.Equal(exposed, declared.GetProperty("exposed").GetBoolean());
        Assert.Equal(11 + tiles.Length, result.GetProperty("hand").GetArrayLength());
        Assert.Equal(5, groups.Length);
        Assert.Single(groups, group => Kind(group) == "pair");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DiscardAndRobbingKongWins_IncludeTheCapturedPhysicalTileExactlyOnce(bool robbingKong)
    {
        var state = NewState();
        state.Hands[1].ConcealedTiles = [0, 1, 2, 24, 25, 26, 60, 61, 62, 88, 89, 8, 12];
        state.Hands[0].ConcealedTiles = [19, 40, 41, 42, 44, 45, 46, 48, 49, 50, 52];
        if (robbingKong)
            state.Hands[0].Melds.Add(new Meld { Kind = MeldKind.Pung, TileIds = [16, 17, 18], ClaimedFromSeatIndex = 3 });
        else
            state.Hands[0].ConcealedTiles.AddRange([53, 54, 55]);
        ArrangeWall(state);
        if (robbingKong)
            ChangshaGameStateMachine.DeclareAddedKong(state, 0, 19);
        else
            ChangshaGameStateMachine.Discard(state, 0, 19);
        ChangshaGameStateMachine.ResolveClaim(state, 1, TableClaimType.Hu);
        ChangshaGameStateMachine.Score(state);
        var result = Result(state);
        var groups = Groups(state, result);

        Assert.Equal(robbingKong ? WinMethod.RobbingKong : WinMethod.Discard, state.CurrentWin!.Method);
        Assert.Equal(19, result.GetProperty("winResult").GetProperty("winningTileId").GetInt32());
        Assert.Single(groups.SelectMany(Tiles), tile => tile == 19);
        Assert.DoesNotContain(groups.SelectMany(Tiles), tile => tile is 16 or 17 or 18);
        HudsonOwnTurnWsFixture.AssertInventory(state);
    }

    [Fact]
    public void LooseNineTerminals_UsesATruthfulSpecialGroup_NotManufacturedSets()
    {
        var state = Scored([0, 1, 2, 32, 33, 34, 36, 37, 38, 68, 69, 72, 73, 104]);
        Assert.Equal(WinPattern.NineTerminals, state.CurrentWin!.Pattern);
        var special = Assert.Single(Groups(state, Result(state)));

        Assert.Equal("special", Kind(special));
        Assert.False(special.GetProperty("exposed").GetBoolean());
        Assert.Equal(14, Tiles(special).Length);
    }

    [Fact]
    public void InconsistentOrUnavailableGrouping_IsOmitted_WithoutChangingTheLegacyHand()
    {
        var scored = Scored(ScreenshotHand);
        foreach (var inconsistency in new[] { "duplicate", "missing-winning-tile", "unscored", "draw", "false-hu" })
        {
            var state = ChangshaReplayStateCodec.RoundTrip(scored);
            switch (inconsistency)
            {
                case "duplicate": state.Hands[0].ConcealedTiles[0] = state.Hands[0].ConcealedTiles[1]; break;
                case "missing-winning-tile": state.Hands[0].ConcealedTiles.Remove(state.CurrentWin!.WinningTileId); break;
                case "unscored": state.CurrentScore = null; break;
                case "draw": state.CurrentWin = null; break;
                case "false-hu":
                    state.CurrentWin = null;
                    state.FalseHuPenalties.Add(new() { OffendingSeatIndex = 0, PenaltyPerOpponent = 1, Payments = [] });
                    break;
            }
            var result = Result(state);
            Assert.False(result.TryGetProperty("handGroups", out _), inconsistency);
            Assert.Equal(state.CurrentWin is null ? [] : state.Hands[0].ConcealedTiles.ToArray(),
                result.GetProperty("hand").EnumerateArray().Select(tile => tile.GetInt32()));
        }
    }

    [Fact]
    public void Grouping_IsOnlyEmittedWithTheAlreadyPublicEndHandResult()
    {
        var state = Scored(ScreenshotHand);
        foreach (var phase in new[] { ChangshaPhase.AwaitingDiscard, ChangshaPhase.AwaitingClaim, ChangshaPhase.Scoring })
        {
            state.Phase = phase;
            var result = Assert.Single(ChangshaToAutotableTranslator.Translate(state), entry => entry.Kind == "result");
            Assert.Null(result.Value);
            Assert.False(Result(state).TryGetProperty("handGroups", out _));
        }
        state.Phase = ChangshaPhase.EndHand;
        var visible = Assert.Single(ChangshaToAutotableTranslator.Translate(state), entry => entry.Kind == "result");
        Assert.NotEmpty(JsonSerializer.SerializeToElement(visible.Value, AutotableJson.Options)
            .GetProperty("handGroups").EnumerateArray());
    }

    private static ChangshaGameState Scored(int[] tiles, Meld? meld = null, bool heavenly = false)
    {
        var state = NewState();
        state.DiscardsThisHand = heavenly ? 0 : 1;
        state.Hands[0].ConcealedTiles = tiles.ToList();
        if (meld is not null) state.Hands[0].Melds.Add(meld);
        ArrangeWall(state);
        ChangshaGameStateMachine.DeclareSelfDrawWin(state, 0);
        Assert.Equal(ChangshaPhase.Scoring, state.Phase);
        ChangshaGameStateMachine.Score(state);
        Assert.Equal(ChangshaPhase.EndHand, state.Phase);
        return state;
    }

    private static ChangshaGameState NewState()
    {
        var (state, _) = ChangshaGameStateMachine.CreateGame(42, []);
        ChangshaGameStateMachine.StartGame(state);
        ChangshaGameStateMachine.RollDice(state, new DiceService(42));
        ChangshaGameStateMachine.Deal(state);
        foreach (var hand in state.Hands)
        {
            hand.ConcealedTiles.Clear();
            hand.Melds.Clear();
        }
        state.Phase = ChangshaPhase.AwaitingDiscard;
        state.ActiveSeatIndex = 0;
        state.LastDrawSeatIndex = 0;
        state.DiscardsThisHand = 1;
        return state;
    }

    private static void ArrangeWall(ChangshaGameState state)
    {
        var used = state.Hands.SelectMany(hand =>
            hand.ConcealedTiles.Concat(hand.Melds.SelectMany(meld => meld.TileIds))).ToArray();
        Assert.Equal(used.Length, used.Distinct().Count());
        state.Wall = Enumerable.Range(0, 108).Except(used).ToList();
        state.WallBackIndex = state.Wall.Count - 1;
        HudsonOwnTurnWsFixture.AssertInventory(state);
    }

    private static JsonElement Result(ChangshaGameState state) =>
        JsonSerializer.SerializeToElement(ChangshaToAutotableTranslator.BuildHandResult(state), AutotableJson.Options);

    private static JsonElement[] Groups(ChangshaGameState state, JsonElement result)
    {
        var groups = result.GetProperty("handGroups").EnumerateArray().ToArray();
        var tiles = groups.SelectMany(Tiles).ToArray();
        Assert.Equal(result.GetProperty("hand").EnumerateArray().Select(tile => tile.GetInt32()).Order(), tiles.Order());
        Assert.Equal(tiles.Length, tiles.Distinct().Count());
        Assert.Single(tiles, tile => tile == state.CurrentWin!.WinningTileId);
        return groups;
    }

    private static string Kind(JsonElement group) => group.GetProperty("kind").GetString()!;
    private static int[] Tiles(JsonElement group) => group.GetProperty("tileIds").EnumerateArray().Select(tile => tile.GetInt32()).ToArray();
}
