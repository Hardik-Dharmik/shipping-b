-- Run in Supabase SQL Editor before deploying the employee API.
BEGIN;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'employee'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS page_permissions TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_page_permissions_check;
ALTER TABLE users ADD CONSTRAINT users_page_permissions_check CHECK (
  page_permissions <@ ARRAY['customers', 'rate_calculator', 'create_order', 'users', 'home', 'user_orders', 'kyc_requests', 'billing', 'tickets']::TEXT[]
);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_created_by_role_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_created_by_role_check CHECK (created_by_role IN ('user', 'admin', 'employee'));
COMMIT;
