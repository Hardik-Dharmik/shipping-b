-- Create organizations and users tables for registration
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_code TEXT NOT NULL UNIQUE CHECK (organization_code ~ '^ORG-[0-9]{6}$'),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  company_name TEXT NOT NULL,
  organization_ref UUID REFERENCES organizations(id) ON DELETE SET NULL,
  organization_code TEXT,
  organization_role TEXT NOT NULL DEFAULT 'primary' CHECK (organization_role IN ('primary', 'employee')),
  kyc_required BOOLEAN NOT NULL DEFAULT TRUE,
  file_url TEXT,
  file_name TEXT,
  kyc_status TEXT DEFAULT 'not_started' CHECK (kyc_status IN ('not_started', 'pending', 'completed')),
  credit_application_form_url TEXT,
  trade_licence_url TEXT,
  trn_licence_url TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role to access all (for server-side operations)
CREATE POLICY "Service role can access all" ON users
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can access all organizations" ON organizations
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status);
CREATE INDEX IF NOT EXISTS idx_users_kyc_required ON users(kyc_required);
CREATE INDEX IF NOT EXISTS idx_users_organization_ref ON users(organization_ref);
CREATE INDEX IF NOT EXISTS idx_users_organization_code ON users(organization_code);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_organizations_code ON organizations(organization_code);
CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(normalized_name);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc', NOW());
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to update updated_at on row update
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  order_data JSONB NOT NULL,
  status TEXT DEFAULT 'CREATED',
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE orders
ADD COLUMN awb_number TEXT UNIQUE,
ADD COLUMN awb_pdf_url TEXT,
ADD COLUMN invoice_urls JSONB DEFAULT '[]'::jsonb,
ADD COLUMN packing_list_urls JSONB DEFAULT '[]'::jsonb;

ALTER TABLE orders
ADD COLUMN carrier JSONB NOT NULL;

-- Apply the same pickup schema in migrations/add-pickups.sql to existing databases.
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_pickups_active_user_carrier_awb
  ON pickups(user_id, carrier, awb_number) WHERE status = 'SCHEDULED';

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),

  awb_number text not null,

  order_id uuid not null,
  -- add FK later if needed
  -- references orders(id) on delete cascade,

  user_id uuid not null
    references users(id)
    on delete cascade,

  -- ticket classification
  category text not null,
  subcategory text not null,

  status text not null default 'open'
    check (status in ('open', 'pending', 'closed')),

  -- messages stored as JSON array
  messages jsonb not null default '[]'::jsonb,

  -- who created the ticket (admin or user)
  created_by_id uuid
    references users(id)
    on delete set null,

  created_by_role text not null default 'user'
    check (created_by_role in ('user', 'admin')),

  created_at timestamp with time zone
    default timezone('utc', now()) not null,

  updated_at timestamp with time zone
    default timezone('utc', now()) not null
);

create index if not exists tickets_awb_idx
on tickets (awb_number);

create index if not exists tickets_user_idx
on tickets (user_id);

create index if not exists tickets_category_idx
on tickets (category);

create index if not exists tickets_status_idx
on tickets (status);

create index if not exists tickets_created_by_role_idx
on tickets (created_by_role);

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create trigger update_tickets_updated_at
before update on tickets
for each row
execute function update_updated_at_column();

ALTER TABLE tickets
ADD COLUMN unread_user_count INTEGER DEFAULT 0,
ADD COLUMN unread_admin_count INTEGER DEFAULT 0;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_awb_number_key;

ALTER TABLE tickets
ADD COLUMN IF NOT EXISTS ticket_number TEXT UNIQUE;

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS invoice_urls JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS packing_list_urls JSONB DEFAULT '[]'::jsonb;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_role text NOT NULL DEFAULT 'user'
    CHECK (created_by_role IN ('user', 'admin'));

CREATE INDEX IF NOT EXISTS tickets_created_by_role_idx
  ON tickets (created_by_role);

-- Billing uploads (admin-only uploads tied to AWB)
CREATE TABLE IF NOT EXISTS billing_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  awb_number TEXT NOT NULL,
  billing_type TEXT NOT NULL CHECK (billing_type IN ('BOE', 'DO', 'INVOICE')),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  file_url TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS billing_uploads_awb_idx ON billing_uploads(awb_number);
CREATE INDEX IF NOT EXISTS billing_uploads_type_idx ON billing_uploads(billing_type);
CREATE INDEX IF NOT EXISTS billing_uploads_user_idx ON billing_uploads(user_id);
CREATE INDEX IF NOT EXISTS billing_uploads_created_at_idx ON billing_uploads(created_at);

-- Notifications (polling)
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications(created_at);

-- 1) Add column with unique constraint
ALTER TABLE tickets
ADD COLUMN IF NOT EXISTS ticket_number TEXT UNIQUE;

-- 2) Backfill existing rows with unique 6-digit numbers
DO $$
DECLARE
  v_id uuid;
  v_num text;
BEGIN
  FOR v_id IN
    SELECT id FROM tickets WHERE ticket_number IS NULL
  LOOP
    LOOP
      v_num := lpad((floor(random() * 1000000))::int::text, 6, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM tickets WHERE ticket_number = v_num
      );
    END LOOP;

    UPDATE tickets
    SET ticket_number = v_num
    WHERE id = v_id;
  END LOOP;
END $$;

-- 3) Enforce NOT NULL after backfill
ALTER TABLE tickets
ALTER COLUMN ticket_number SET NOT NULL;

-- Create table for shareable pickup/destination form links
CREATE TABLE IF NOT EXISTS order_address_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code CHAR(6) NOT NULL UNIQUE CHECK (code ~ '^[0-9]{6}$'),
  pickup_address JSONB,
  destination_address JSONB,
  products JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ordered')),
  is_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (TIMEZONE('utc', NOW()) + INTERVAL '30 days'),
  submitted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

ALTER TABLE order_address_forms
ADD COLUMN IF NOT EXISTS products JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';

ALTER TABLE order_address_forms
DROP CONSTRAINT IF EXISTS order_address_forms_status_check;

ALTER TABLE order_address_forms
ADD CONSTRAINT order_address_forms_status_check
CHECK (status IN ('open', 'ordered'));

CREATE INDEX IF NOT EXISTS idx_order_address_forms_user_id
  ON order_address_forms(user_id);

CREATE INDEX IF NOT EXISTS idx_order_address_forms_code
  ON order_address_forms(code);

CREATE INDEX IF NOT EXISTS idx_order_address_forms_submitted
  ON order_address_forms(is_submitted, submitted_at DESC);

-- Order-link forms retain the order fields entered by the account user.  The
-- recipient only supplies pickup and destination details through the public link.
ALTER TABLE order_address_forms
  ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT 'address'
    CHECK (form_type IN ('address', 'order')),
  ADD COLUMN IF NOT EXISTS order_data JSONB,
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS awb_number TEXT;

CREATE INDEX IF NOT EXISTS idx_order_address_forms_order_id
  ON order_address_forms(order_id);

-- Create table for saved box details with retrievable prefixed code
CREATE TABLE IF NOT EXISTS box_details (
  box_detail_code TEXT PRIMARY KEY CHECK (box_detail_code ~ '^BOX-[0-9]{6}$'),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  details JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_box_details_user_id
  ON box_details(user_id);

CREATE INDEX IF NOT EXISTS idx_box_details_created_at
  ON box_details(created_at DESC);

-- Create table for saved contact details used in create-order autofill
CREATE TABLE IF NOT EXISTS contact_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  normalized_company_name TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  CONSTRAINT contact_details_user_company_unique
    UNIQUE (user_id, normalized_company_name)
);

CREATE INDEX IF NOT EXISTS idx_contact_details_user_type_updated
  ON contact_details(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_details_company_name
  ON contact_details(company_name);

