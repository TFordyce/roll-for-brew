namespace RollForBrew.Tests.Harness;

/// <summary>What a write announced on its room's channel, read from <c>realtime.messages</c>,
/// where Postgres puts a send only if the transaction commits.</summary>
public static class Broadcasts
{
    /// <summary>The <c>version</c> each <c>room-changed</c> sent to <paramref name="room"/> carried, oldest first.</summary>
    public static async Task<long[]> RoomChangedVersions(this TestDatabase db, Guid room) =>
        (await db.Scalar<long[]>($$"""
            select coalesce(array_agg((payload ->> 'version')::bigint order by seq), '{}')
              from realtime.messages where topic = 'room:{{room}}' and event = 'room-changed'
            """))!;

    public static async Task<long> Messages(this TestDatabase db) =>
        await db.Scalar<long>("select count(*) from realtime.messages");

    /// <summary>Makes every later transaction that sends a broadcast fail at commit. The send has
    /// already run by then, so a rollback has to undo a message that was really sent.</summary>
    public static Task FailCommitsThatBroadcast(this TestDatabase db) => db.Execute("""
        create function realtime.fail_on_commit() returns trigger language plpgsql as $f$
        begin raise exception 'commit failed'; end $f$;
        create constraint trigger fail_on_commit after insert on realtime.messages
          deferrable initially deferred for each row execute function realtime.fail_on_commit();
        """);
}
