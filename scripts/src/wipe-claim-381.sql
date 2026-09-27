\echo == before ==
select 'progress' t, count(*) from claim_match_progress where recording_id = 381
union all select 'bindings', count(*) from claim_match_identity_bindings where recording_id = 381
union all select 'offpitch', count(*) from claim_match_off_pitch_spans where recording_id = 381
union all select 'labels', count(*) from claim_chain_labels where recording_id = 381;

begin;
delete from claim_match_off_pitch_spans where recording_id = 381 and user_id in (196,314);
delete from claim_match_identity_bindings where recording_id = 381 and user_id in (196,314);
delete from claim_match_progress where recording_id = 381 and user_id in (196,314);
update recording_tracking_bundles
set manifest = jsonb_set(manifest, '{identities}', coalesce((
      select jsonb_agg(elem)
      from jsonb_array_elements(manifest->'identities') elem
      where elem->>'id' not in ('claim:3e58c775ea64','claim:34b6106318bb')
    ), '[]'::jsonb)),
    updated_at = now()
where recording_id = 381 and manifest ? 'identities';
commit;

\echo == after ==
select 'progress' t, count(*) from claim_match_progress where recording_id = 381
union all select 'bindings', count(*) from claim_match_identity_bindings where recording_id = 381
union all select 'offpitch', count(*) from claim_match_off_pitch_spans where recording_id = 381
union all select 'labels', count(*) from claim_chain_labels where recording_id = 381;
select coalesce(string_agg(elem->>'id', ','), 'none') remaining_claim_ids
from recording_tracking_bundles b, jsonb_array_elements(coalesce(b.manifest->'identities','[]'::jsonb)) elem
where b.recording_id = 381 and elem->>'id' like 'claim:%';