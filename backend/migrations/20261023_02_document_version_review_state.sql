-- Migration date: 2026-10-23
--
-- Review state on a document version: Draft, In review, Approved.
--
-- A version's bytes are hashed and its tracked changes are accepted or
-- rejected, but nothing records that a version was signed off: the partner
-- approved the engagement letter, the tax manager approved the return as
-- filed. The state lives on the version, not the document, because approval
-- attaches to specific bytes: a new version (an upload, an assistant edit)
-- starts as a draft again.
--
--   review_state  'draft' | 'in_review' | 'approved'
--   reviewed_by   who set the current state (null until someone does)
--   reviewed_at   when they set it
--   review_note   an optional short note with the decision
--
-- Safe to re-run: add column if not exists, drop-before-create for the
-- constraints.

alter table public.document_versions
  add column if not exists review_state text not null default 'draft';
alter table public.document_versions
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null;
alter table public.document_versions
  add column if not exists reviewed_at timestamptz;
alter table public.document_versions
  add column if not exists review_note text;

alter table public.document_versions
  drop constraint if exists document_versions_review_state_check;
alter table public.document_versions
  add constraint document_versions_review_state_check
  check (review_state in ('draft', 'in_review', 'approved'));

alter table public.document_versions
  drop constraint if exists document_versions_review_note_check;
alter table public.document_versions
  add constraint document_versions_review_note_check
  check (review_note is null or char_length(review_note) <= 2000);
