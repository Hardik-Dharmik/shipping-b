-- Upgrade the initial FedEx-only schema if it was applied before this generic
-- pickup model was introduced.
DO $$
BEGIN
  IF to_regclass('public.fedex_pickups') IS NOT NULL
     AND to_regclass('public.pickups') IS NULL THEN
    ALTER TABLE fedex_pickups RENAME TO pickups;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pickups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  awb_number TEXT NOT NULL,
  carrier TEXT NOT NULL,
  carrier_confirmation_code TEXT NOT NULL,
  carrier_location_code TEXT,
  scheduled_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'CANCELLED', 'REPLACED')),
  request_data JSONB NOT NULL,
  carrier_transaction_id TEXT,
  cancelled_at TIMESTAMPTZ,
  replaced_by_pickup_id UUID REFERENCES pickups(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pickups' AND column_name = 'confirmation_code') THEN
    ALTER TABLE pickups RENAME COLUMN confirmation_code TO carrier_confirmation_code;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pickups' AND column_name = 'location_code') THEN
    ALTER TABLE pickups RENAME COLUMN location_code TO carrier_location_code;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pickups' AND column_name = 'fedex_transaction_id') THEN
    ALTER TABLE pickups RENAME COLUMN fedex_transaction_id TO carrier_transaction_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pickups' AND column_name = 'carrier_code') THEN
    ALTER TABLE pickups RENAME COLUMN carrier_code TO carrier;
  END IF;
END $$;

ALTER TABLE pickups DROP CONSTRAINT IF EXISTS fedex_pickups_carrier_code_check;
ALTER TABLE pickups DROP CONSTRAINT IF EXISTS pickups_carrier_code_check;
UPDATE pickups SET carrier = 'FedEx' WHERE carrier IN ('FDXE', 'FDXG');
DROP INDEX IF EXISTS uq_fedex_pickups_active_user_awb;
DROP TRIGGER IF EXISTS update_fedex_pickups_updated_at ON pickups;

CREATE INDEX IF NOT EXISTS idx_pickups_user_created ON pickups(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pickups_order ON pickups(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pickups_active_user_carrier_awb
  ON pickups(user_id, carrier, awb_number) WHERE status = 'SCHEDULED';

DROP TRIGGER IF EXISTS update_pickups_updated_at ON pickups;
CREATE TRIGGER update_pickups_updated_at
  BEFORE UPDATE ON pickups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
