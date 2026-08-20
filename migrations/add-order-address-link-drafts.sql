-- Run this migration before deploying the order-address-link feature.
ALTER TABLE order_address_forms
  ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT 'address'
    CHECK (form_type IN ('address', 'order')),
  ADD COLUMN IF NOT EXISTS order_data JSONB,
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS awb_number TEXT;

CREATE INDEX IF NOT EXISTS idx_order_address_forms_order_id
  ON order_address_forms(order_id);
