-- _compelled_cast_step_open
--
-- Whether the Compelled Cast step is still holding rolling: some compelled
-- Action cast is still owed.
--
-- plpgsql, not sql: a sql body is checked at create time, and the generated
-- migration emits functions alphabetically, before the helpers this calls.
create or replace function public._compelled_cast_step_open(p_round_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public._compelled_outstanding(p_round_id) o
     where o.casting_time = 'A'
  );
end;
$$;

revoke execute on function public._compelled_cast_step_open(uuid) from public, anon, authenticated;
grant execute on function public._compelled_cast_step_open(uuid) to service_role;
