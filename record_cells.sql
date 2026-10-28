-- ============================================================
--  جدول السجلات المستقلة (يُشغَّل مرة واحدة من Supabase → SQL Editor)
--  يحفظ كل سجل حضور وغياب الطلاب، وكل تسجيل حضور معلم، وكل بند في سجل تقييم المعلمين
--  كصف مستقل، بدل حفظها داخل صف المرحلة الكبير (الذي يفوز فيه آخر من حفظ).
--  النتيجة: عشرات المعلمين يسجّلون الحضور في اللحظة نفسها دون أن يمسح أحدهم عمل الآخر.
--  قبل تشغيله يستمر النظام بالصيغة القديمة دون أي تغيير.
--  kind: att  = غياب/حضور طالب (rkey = معرّف الطالب|المادة|الفصل|الشهر|التاريخ)
--        pres = حضور معلم   (rkey = معرّف المعلم|التاريخ)
--        fbl  = بند في سجل تقييم المعلم (rkey = معرّف البند)
-- ============================================================

create table if not exists public.record_cells (
  stage_id   text        not null,
  kind       text        not null,
  rkey       text        not null,
  value      jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  updated_by text,
  synced_at  timestamptz not null default clock_timestamp(),
  primary key (stage_id, kind, rkey)
);

create index if not exists record_cells_stage_synced_idx on public.record_cells (stage_id, synced_at);

create or replace function public.upsert_record_cells(p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  insert into public.record_cells as t
    (stage_id, kind, rkey, value, deleted, updated_at, updated_by, synced_at)
  select distinct on (r->>'stage_id', r->>'kind', r->>'rkey')
         r->>'stage_id', r->>'kind', r->>'rkey',
         case when jsonb_typeof(r->'value') = 'null' then null else r->'value' end,
         coalesce((r->>'deleted')::boolean, false),
         least(coalesce((r->>'updated_at')::timestamptz, clock_timestamp()), clock_timestamp()),
         r->>'updated_by', clock_timestamp()
  from jsonb_array_elements(p_rows) r
  order by r->>'stage_id', r->>'kind', r->>'rkey',
           coalesce((r->>'updated_at')::timestamptz, now()) desc
  on conflict (stage_id, kind, rkey)
  do update set
    value      = excluded.value,
    deleted    = excluded.deleted,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by,
    synced_at  = clock_timestamp()
  where t.updated_at <= excluded.updated_at;
  get diagnostics n = row_count;
  return n;
end;
$$;

alter table public.record_cells enable row level security;

drop policy if exists record_cells_select on public.record_cells;
drop policy if exists record_cells_insert on public.record_cells;
drop policy if exists record_cells_update on public.record_cells;
create policy record_cells_select on public.record_cells for select to anon, authenticated using (true);
create policy record_cells_insert on public.record_cells for insert to anon, authenticated with check (true);
create policy record_cells_update on public.record_cells for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.record_cells to anon, authenticated;
grant execute on function public.upsert_record_cells(jsonb) to anon, authenticated;

-- (دالة get_server_time موجودة من ملف grade_cells.sql)
