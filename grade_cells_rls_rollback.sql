-- الرجوع إلى الصلاحيات المفتوحة (نفس نمط grade_system_state) إن تعطّل الرصد بعد التشديد
drop policy if exists grade_cells_select on public.grade_cells;
drop policy if exists grade_cells_insert on public.grade_cells;
drop policy if exists grade_cells_update on public.grade_cells;
create policy grade_cells_select on public.grade_cells for select to anon, authenticated using (true);
create policy grade_cells_insert on public.grade_cells for insert to anon, authenticated with check (true);
create policy grade_cells_update on public.grade_cells for update to anon, authenticated using (true) with check (true);
grant select, insert, update on public.grade_cells to anon, authenticated;
grant execute on function public.upsert_grade_cells(jsonb) to anon, authenticated;
