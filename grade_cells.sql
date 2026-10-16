-- ============================================================
--  جدول الدرجات خانة بخانة (يُشغَّل مرة واحدة من Supabase → SQL Editor)
--  بعد تشغيله يبدأ النظام تلقائياً برفع/سحب الدرجات المتغيّرة فقط بدل صف المرحلة كاملاً،
--  فلا تضيع درجات معلم بسبب معلم آخر حتى مع مئات المعلمين في نفس الوقت.
--  قبل تشغيله يستمر النظام بالصيغة القديمة دون أي تغيير.
-- ============================================================

create table if not exists public.grade_cells (
  stage_id     text        not null,
  student_id   text        not null,
  subject_name text        not null,
  term         text        not null,
  month        int         not null,
  comp_index   int         not null,
  score        text,                                   -- رقم أو «غ» (يُخزَّن كنص)
  deleted      boolean     not null default false,     -- حذف ناعم حتى تصل الحذوفات لباقي الأجهزة
  updated_at   timestamptz not null default now(),     -- وقت التعديل عند المعلم (يُحسم به التعارض)
  updated_by   text,
  edit_count   int         not null default 0,
  synced_at    timestamptz not null default clock_timestamp(),  -- وقت وصوله للخادم (يُستخدم للسحب التفاضلي)
  primary key (stage_id, student_id, subject_name, term, month, comp_index)
);

create index if not exists grade_cells_stage_synced_idx on public.grade_cells (stage_id, synced_at);
create index if not exists grade_cells_stage_subject_idx on public.grade_cells (stage_id, subject_name, term, month);

-- دالة الكتابة الذرّية: تُدخل الخانة أو تحدّثها فقط إذا كان وقت تعديلها ≥ الموجود في الخادم
create or replace function public.upsert_grade_cells(p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  insert into public.grade_cells as t
    (stage_id, student_id, subject_name, term, month, comp_index,
     score, deleted, updated_at, updated_by, edit_count, synced_at)
  select distinct on (r->>'stage_id', r->>'student_id', r->>'subject_name', r->>'term', (r->>'month')::int, (r->>'comp_index')::int)
         r->>'stage_id', r->>'student_id', r->>'subject_name', r->>'term',
         (r->>'month')::int, (r->>'comp_index')::int,
         r->>'score', coalesce((r->>'deleted')::boolean, false),
         least(coalesce((r->>'updated_at')::timestamptz, clock_timestamp()), clock_timestamp()),  -- لا يُقبل ختم من المستقبل (ساعة جهاز متقدمة)
         r->>'updated_by', coalesce((r->>'edit_count')::int, 0), clock_timestamp()
  from jsonb_array_elements(p_rows) r
  order by r->>'stage_id', r->>'student_id', r->>'subject_name', r->>'term', (r->>'month')::int, (r->>'comp_index')::int,
           coalesce((r->>'updated_at')::timestamptz, now()) desc
  on conflict (stage_id, student_id, subject_name, term, month, comp_index)
  do update set
    score      = excluded.score,
    deleted    = excluded.deleted,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by,
    edit_count = excluded.edit_count,
    synced_at  = clock_timestamp()
  where t.updated_at <= excluded.updated_at;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- الصلاحيات: نفس نمط جدول grade_system_state الحالي (مفتاح anon/authenticated).
-- ⚠️ لتشديد الأمان لاحقاً: اربط السياسات بجدول profiles (المعلم يكتب في مرحلته/مواده فقط).
alter table public.grade_cells enable row level security;

drop policy if exists grade_cells_select on public.grade_cells;
drop policy if exists grade_cells_insert on public.grade_cells;
drop policy if exists grade_cells_update on public.grade_cells;
create policy grade_cells_select on public.grade_cells for select to anon, authenticated using (true);
create policy grade_cells_insert on public.grade_cells for insert to anon, authenticated with check (true);
create policy grade_cells_update on public.grade_cells for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.grade_cells to anon, authenticated;
grant execute on function public.upsert_grade_cells(jsonb) to anon, authenticated;

-- وقت الخادم: تستخدمه الواجهة لقياس فرق ساعة كل جهاز وتصحيح أختام التعديل (حماية من ساعة جهاز خاطئة)
create or replace function public.get_server_time()
returns timestamptz
language sql
stable
as $$ select clock_timestamp() $$;
grant execute on function public.get_server_time() to anon, authenticated;

-- (اختياري) بثّ لحظي للتغييرات — النظام لا يحتاجه حالياً لأنه يسحب كل بضع ثوانٍ
-- alter publication supabase_realtime add table public.grade_cells;
