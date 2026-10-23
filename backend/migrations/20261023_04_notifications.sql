-- Migration date: 2026-10-23
--
-- In-app notifications, with email delivery per person.
--
-- Mike told nobody anything: an invitation waited in Settings, a task had no
-- way to reach its owner, an approval went unnoticed. Each notification is a
-- row addressed to one person; the backend writes it when something happens
-- to them and, according to their preference, emails it at once, in a daily
-- digest, or not at all.
--
--   notifications
--     user_id       the person it is for; goes with the account
--     org_id        the organization it happened in, when any (no foreign
--                   key, like audit_events: the row outlives the organization)
--     kind          what happened, e.g. 'task.assigned', 'project.shared'
--     title, body   the sentence and its detail, both short
--     href          a path in the web app to open
--     subject_type, subject_id
--                   what it is about ('task', 'project', 'document_version'),
--                   so reminders about the same thing can be rate-limited
--     read_at       when the person saw it in the app
--     emailed_at    when it went out by email (at once or in a digest)
--
--   user_profiles.notification_email_mode
--     'immediate' | 'daily' | 'off'  (default immediate; email only goes out
--     when the deployment has SMTP configured)
--
-- Only the backend reads or writes these rows. Safe to re-run.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid,
  kind text not null,
  title text not null,
  body text,
  href text,
  project_id uuid,
  document_id uuid,
  subject_type text,
  subject_id text,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_kind_check check (char_length(kind) between 1 and 64),
  constraint notifications_title_check check (char_length(title) between 1 and 300),
  constraint notifications_body_check check (body is null or char_length(body) <= 2000),
  constraint notifications_href_check check (href is null or char_length(href) <= 500)
);

create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc)
  where read_at is null;
create index if not exists notifications_unemailed_idx
  on public.notifications(user_id, created_at)
  where emailed_at is null;
create index if not exists notifications_subject_idx
  on public.notifications(user_id, kind, subject_id, created_at desc)
  where subject_id is not null;

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select, insert, update, delete on public.notifications to service_role;

alter table public.user_profiles
  add column if not exists notification_email_mode text not null default 'immediate';
alter table public.user_profiles
  drop constraint if exists user_profiles_notification_email_mode_check;
alter table public.user_profiles
  add constraint user_profiles_notification_email_mode_check
  check (notification_email_mode in ('immediate', 'daily', 'off'));
