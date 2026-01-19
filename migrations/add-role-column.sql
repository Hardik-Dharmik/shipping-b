-- Migration: Add role column to existing users table
-- Run this in Supabase SQL Editor if you already have the users table

-- Add role column with default value 'user'
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin'));

-- Update existing users to have role 'user' if they don't have one
UPDATE users 
SET role = 'user' 
WHERE role IS NULL;

-- Create index for role column
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Verify the changes
SELECT id, name, email, role, approval_status 
FROM users 
LIMIT 5;

