-- Migration: Add KYC fields to users table
-- Run this in Supabase SQL Editor for existing environments

ALTER TABLE users
ADD COLUMN IF NOT EXISTS kyc_status TEXT DEFAULT 'not_started';

ALTER TABLE users
ADD COLUMN IF NOT EXISTS credit_application_form_url TEXT,
ADD COLUMN IF NOT EXISTS trade_licence_url TEXT,
ADD COLUMN IF NOT EXISTS trn_licence_url TEXT;

ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_kyc_status_check;

ALTER TABLE users
ADD CONSTRAINT users_kyc_status_check
CHECK (kyc_status IN ('not_started', 'pending', 'completed'));

UPDATE users
SET kyc_status = 'not_started'
WHERE kyc_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users(kyc_status);
