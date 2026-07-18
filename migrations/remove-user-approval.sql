-- Migration: Remove user approval system

UPDATE users
SET updated_at = TIMEZONE('utc', NOW())
WHERE updated_at IS NULL;

ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_approval_status_check;

DROP INDEX IF EXISTS idx_users_approval_status;

ALTER TABLE users
DROP COLUMN IF EXISTS approval_status;
