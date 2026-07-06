-- =====================================================================
-- 3000词 · 高考拔高 —— Supabase 云同步建表脚本
-- 在 Supabase 控制台 → SQL Editor 里整段运行一次即可。
-- 数据模型：每个「学习码」一行，进度整体存成 JSON。
-- =====================================================================

create table if not exists public.learners (
  code       text primary key,                 -- 学习码，如 XD-4821
  name       text,                             -- 学生昵称
  data       jsonb not null default '{}'::jsonb,-- 整份进度 {progress, stats, meta}
  updated_at timestamptz not null default now()
);

alter table public.learners enable row level security;

drop policy if exists "learners_select" on public.learners;
drop policy if exists "learners_insert" on public.learners;
drop policy if exists "learners_update" on public.learners;

-- 默认方案：家庭级「学习码」模型。
-- 注意：这会开放 anon 对 learners 表的读写，适合小范围试用；公开长期使用建议改用下方 RPC 方案。
create policy "learners_select" on public.learners for select using (true);
create policy "learners_insert" on public.learners for insert with check (true);
create policy "learners_update" on public.learners for update using (true) with check (true);

-- =====================================================================
-- 公开部署建议：启用 RPC，只允许按 code 精确读写，避免 anon 直接枚举整表。
-- 当前 app.js 已优先调用 learner_get / learner_upsert；如 RPC 不存在会临时回退旧表访问。
-- 若要强制只走 RPC，请在 Supabase SQL Editor 运行以下加固段。
-- =====================================================================

create or replace function public.learner_get(p_code text)
  returns public.learners
  language sql
  security definer
  set search_path = public
as $$
  select *
  from public.learners
  where code = p_code
  limit 1
$$;

create or replace function public.learner_upsert(
  p_code text,
  p_name text,
  p_data jsonb,
  p_updated timestamptz
)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  insert into public.learners(code, name, data, updated_at)
  values (p_code, p_name, p_data, p_updated)
  on conflict (code) do update
    set name = excluded.name,
        data = excluded.data,
        updated_at = excluded.updated_at
$$;

grant usage on schema public to anon;
grant execute on function public.learner_get(text) to anon;
grant execute on function public.learner_upsert(text, text, jsonb, timestamptz) to anon;

-- 运行到这里并确认 RPC 可用后，再收紧表级权限。
revoke all on public.learners from anon;
drop policy if exists "learners_select" on public.learners;
drop policy if exists "learners_insert" on public.learners;
drop policy if exists "learners_update" on public.learners;
