-- Create users table for registration
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  company_name TEXT NOT NULL,
  file_url TEXT,
  file_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  approval_status TEXT DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Policy: Allow service role to access all (for server-side operations)
CREATE POLICY "Service role can access all" ON users
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_users_approval_status ON users(approval_status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

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

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  order_data JSONB NOT NULL,
  status TEXT DEFAULT 'CREATED',
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE orders
ADD COLUMN awb_number TEXT UNIQUE,
ADD COLUMN awb_pdf_url TEXT;

ALTER TABLE orders
ADD COLUMN carrier JSONB NOT NULL;

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),

  awb_number text not null unique,

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
