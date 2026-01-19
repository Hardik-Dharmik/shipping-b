-- SQL script to create an admin user manually
-- Run this in Supabase SQL Editor after generating the password hash

-- Step 1: Generate password hash using Node.js
-- Run this command in terminal:
-- node -e "const bcrypt=require('bcrypt');bcrypt.hash('YOUR_PASSWORD',10).then(h=>console.log(h))"
-- OR use the create-admin.js script

-- Step 2: Insert admin user with the generated hash
-- Replace the values below:
INSERT INTO users (
  name,
  email,
  password_hash,
  company_name,
  role,
  approval_status,
  file_url,
  file_name
) VALUES (
  'Admin User',                    -- Admin name
  'admin@example.com',             -- Admin email
  '$2b$10$YOUR_HASHED_PASSWORD',   -- Replace with bcrypt hash from step 1
  'Admin Company',                 -- Company name
  'admin',                         -- Set role as admin
  'approved',                      -- Auto-approve admin
  NULL,                            -- No file needed for admin
  NULL
);

-- Verify the admin was created
SELECT id, name, email, company_name, approval_status, created_at 
FROM users 
WHERE email = 'admin@example.com';

