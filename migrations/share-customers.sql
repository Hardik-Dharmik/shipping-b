-- Apply after add-customers.sql, including on databases that already use customers.
BEGIN;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_customer_owner_fkey;
ALTER TABLE order_address_forms DROP CONSTRAINT IF EXISTS order_address_forms_customer_owner_fkey;
-- user_id records the creator only; deleting a creator must not delete shared customers.
ALTER TABLE customers ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_user_id_fkey;
ALTER TABLE customers ADD CONSTRAINT customers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
COMMENT ON COLUMN customers.user_id IS 'Creator for audit only; customers are shared by all authenticated users';
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_name, id);
COMMIT;
