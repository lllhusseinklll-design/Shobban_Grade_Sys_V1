-- ============================================================
--  تشديد صلاحيات grade_cells (المستوى 2): لا قراءة ولا كتابة إلا لحساب سحابي فعّال ضمن مراحله.
--
--  ⚠️ لا تشغّل هذا الملف قبل أن يمتلك كل من يرصد حسابًا سحابيًا (Supabase Auth)!
--  من يدخل بالرقم السري المحلي دون حساب سحابي لا يملك جلسة، فستُرفض كتاباته وقراءاته فورًا
--  (تظهر له شارة «حدث خطأ أثناء آخر مزامنة»، وتبقى درجاته على جهازه ولا تُفقد).
--
--  القواعد:
--   • superadmin: كل المراحل (قراءة وكتابة).
--   • stageadmin و teacher: المراحل الموجودة في profiles.stage_ids فقط (قراءة وكتابة).
--   • أي دور آخر (مثل مراقب): قراءة مراحله فقط.
--   • الحساب غير الفعّال (is_active = false) أو بلا ملف في profiles: لا شيء.
--   • مفتاح anon العام: لا قراءة ولا كتابة على الجدول إطلاقًا.
--  ملاحظة: التقييد عند مستوى المرحلة. تقييد «فصول ومواد المعلم» يحتاج جدول تعيينات مستقلًا.
--
--  للرجوع فورًا إلى الصلاحيات المفتوحة: شغّل grade_cells_rls_rollback.sql
-- ============================================================

create or replace function public.gc_can_read(p_stage text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true)
      and (p.role = 'superadmin' or p_stage = any (coalesce(p.stage_ids, '{}')))
  )
$$;

create or replace function public.gc_can_write(p_stage text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true)
      and (
        p.role = 'superadmin'
        or (p.role in ('stageadmin', 'teacher') and p_stage = any (coalesce(p.stage_ids, '{}')))
      )
  )
$$;

revoke all on function public.gc_can_read(text)  from public;
revoke all on function public.gc_can_write(text) from public;
grant execute on function public.gc_can_read(text)  to authenticated;
grant execute on function public.gc_can_write(text) to authenticated;

drop policy if exists grade_cells_select on public.grade_cells;
drop policy if exists grade_cells_insert on public.grade_cells;
drop policy if exists grade_cells_update on public.grade_cells;

create policy grade_cells_select on public.grade_cells for select to authenticated
  using (public.gc_can_read(stage_id));
create policy grade_cells_insert on public.grade_cells for insert to authenticated
  with check (public.gc_can_write(stage_id));
create policy grade_cells_update on public.grade_cells for update to authenticated
  using (public.gc_can_write(stage_id)) with check (public.gc_can_write(stage_id));

revoke all on public.grade_cells from anon;
grant select, insert, update on public.grade_cells to authenticated;
revoke execute on function public.upsert_grade_cells(jsonb) from anon;
grant  execute on function public.upsert_grade_cells(jsonb) to authenticated;
-- get_server_time تبقى متاحة للجميع (لا تكشف بيانات)
