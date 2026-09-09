-- Run in Supabase SQL Editor before deploying the customer endpoints.
BEGIN;

-- NO CYCLE prevents reuse; nextval is safe for concurrent customer creation.
CREATE SEQUENCE IF NOT EXISTS customer_id_seq
  AS INTEGER START WITH 100000 MINVALUE 100000 MAXVALUE 999999 NO CYCLE;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY DEFAULT nextval('customer_id_seq')::text
    CHECK (id ~ '^[0-9]{6}$'),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL CHECK (length(trim(company_name)) BETWEEN 1 AND 200),
  email TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (user_id, id)
);

ALTER SEQUENCE customer_id_seq OWNED BY customers.id;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
-- Only the server's service role accesses customers (it bypasses RLS).
REVOKE ALL ON customers FROM anon, authenticated;
REVOKE ALL ON SEQUENCE customer_id_seq FROM anon, authenticated;
GRANT ALL ON customers TO service_role;
GRANT USAGE, SELECT ON SEQUENCE customer_id_seq TO service_role;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id TEXT;
ALTER TABLE order_address_forms ADD COLUMN IF NOT EXISTS customer_id TEXT;

-- Single-column FKs enable customer embedding in PostgREST responses.
-- Composite FKs additionally enforce that each customer belongs to the owner.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_customer_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_customer_owner_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_customer_owner_fkey
  FOREIGN KEY (user_id, customer_id) REFERENCES customers(user_id, id);
ALTER TABLE order_address_forms DROP CONSTRAINT IF EXISTS order_address_forms_customer_id_fkey;
ALTER TABLE order_address_forms ADD CONSTRAINT order_address_forms_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE order_address_forms DROP CONSTRAINT IF EXISTS order_address_forms_customer_owner_fkey;
ALTER TABLE order_address_forms ADD CONSTRAINT order_address_forms_customer_owner_fkey
  FOREIGN KEY (user_id, customer_id) REFERENCES customers(user_id, id);

CREATE INDEX IF NOT EXISTS idx_customers_user_company ON customers(user_id, company_name, id);
CREATE INDEX IF NOT EXISTS idx_orders_user_customer ON orders(user_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_address_forms_customer ON order_address_forms(user_id, customer_id);
COMMIT;
