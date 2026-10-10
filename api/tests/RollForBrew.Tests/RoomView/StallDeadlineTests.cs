using RollForBrew.Domain.RoomView;

namespace RollForBrew.Tests.RoomView;

public class StallDeadlineTests
{
    private static readonly DateTimeOffset T = new(2026, 10, 9, 12, 0, 0, TimeSpan.Zero);
    private static DateTimeOffset At(int min, int sec = 0) => T.AddMinutes(min).AddSeconds(sec);

    private static StallClockInput Input(
        string? status, int now = 1, DateTimeOffset? started = null, DateTimeOffset? closed = null, int layer = 0,
        DateTimeOffset? layerEntered = null, bool stepWaiting = false, DateTimeOffset? stepEnded = null,
        DateTimeOffset? windowClosed = null, DateTimeOffset? poll = null, DateTimeOffset? replay = null) =>
        new(At(now), status, started, closed, layer, layerEntered, stepWaiting, stepEnded, windowClosed, poll, replay);

    public static IEnumerable<object?[]> Golden() =>
    [
        ["no round, no replay: no clock", Input(null), null],
        ["open round counts from started_at", Input("open", now: 2, started: At(0)), At(5)],
        ["open round already past its deadline: nothing to offer", Input("open", now: 6, started: At(0)), null],
        ["closed layer 0 counts from closed_at", Input("closed", now: 3, closed: At(1)), At(6)],
        ["compelled step holding rolling counts from closed_at", Input("closed", now: 3, closed: At(1), stepWaiting: true, stepEnded: At(2)), At(6)],
        ["compelled step ended: clock restarts at the step end", Input("closed", now: 3, closed: At(1), stepEnded: At(2)), At(7)],
        ["reaction window closed after closing: clock restarts there", Input("closed", now: 4, closed: At(1), windowClosed: At(3)), At(8)],
        ["window closed before the step end: the step end wins", Input("closed", now: 4, closed: At(1), stepEnded: At(3), windowClosed: At(2)), At(8)],
        ["tie layer counts from when it became current", Input("closed", now: 4, closed: At(1), layer: 2, layerEntered: At(3)), At(8)],
        ["tie layer with no participants rows: no layer clock", Input("closed", now: 4, closed: At(1), layer: 1), null],
        ["skip vote backstop counts from the poll round start and wins when earlier",
            Input("closed", now: 4, closed: At(0), poll: At(1), windowClosed: At(3)), At(6)],
        ["layer clock overdue but the poll round is fresh: only the poll clock remains",
            Input("closed", now: 7, closed: At(0), poll: At(6)), At(11)],
        ["poll clock is ignored above layer 0", Input("closed", now: 2, closed: At(0), layer: 1, layerEntered: At(1), poll: At(0, 30)), At(6)],
        ["pending round replay counts from its creation", Input(null, now: 3, replay: At(1)), At(6)],
        ["earliest of replay and round wins", Input("closed", now: 3, closed: At(2), replay: At(0, 30)), At(5, 30)],
        ["exactly at the deadline is already due, not offered", Input("open", now: 5, started: At(0)), null],
    ];

    [Theory]
    [MemberData(nameof(Golden))]
    public void Golden_deadlines(string name, StallClockInput input, DateTimeOffset? expected)
    {
        Assert.True(expected == StallDeadline.Next(input), name);
    }

    [Fact]
    public void Timeout_matches_the_ts_constant()
    {
        Assert.Equal(TimeSpan.FromMilliseconds(5 * 60 * 1000), StallDeadline.Timeout);
    }
}
