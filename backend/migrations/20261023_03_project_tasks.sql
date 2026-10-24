-- Migration date: 2026-10-23
--
-- Tasks on a project: a title, an owner, a due date and a status, optionally
-- tied to one document. A matter's court deadline, a signing date, a partner
-- sign-off, a filing deadline: the dates a team works to had no home in Mike.
--
--   status            'open' | 'in_progress' | 'done' | 'cancelled'
--   assignee_user_id  the person responsible, who must already have access
--                     to the project; null when unassigned
--   assignee_email    the recorded email of that person (lower-cased), kept
--                     so a task stays legible after the account is gone
--   due_on            a calendar date, no time zone
--   created_by        provenance only, like projects.user_id
--
-- Only the backend reads or writes these rows; they go with their project.
-- Safe to re-run: create if not exists, drop-before-create for policies.

create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'open',
  assignee_user_id uuid references auth.users(id) on delete set null,
  assignee_email text,
  due_on date,
  created_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_tasks_title_check
    check (char_length(title) between 1 and 300),
  constraint project_tasks_description_check
    check (description is null or char_length(description) <= 4000),
  constraint project_tasks_status_check
    check (status in ('open', 'in_progress', 'done', 'cancelled')),
  constraint project_tasks_assignee_email_check
    check (assignee_email is null or assignee_email = lower(assignee_email))
);

create index if not exists project_tasks_project_status_due_idx
  on public.project_tasks(project_id, status, due_on);
create index if not exists project_tasks_assignee_open_idx
  on public.project_tasks(assignee_user_id, due_on)
  where status in ('open', 'in_progress');
create index if not exists project_tasks_document_idx
  on public.project_tasks(document_id)
  where document_id is not null;

alter table public.project_tasks enable row level security;
revoke all on public.project_tasks from anon, authenticated;
grant select, insert, update, delete on public.project_tasks to service_role;
