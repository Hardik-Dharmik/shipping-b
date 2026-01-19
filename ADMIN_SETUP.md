# Admin User Setup Guide

There are multiple ways to create an admin user. Choose the method that works best for you.

## Method 1: Using the Node.js Script (Recommended)

This is the easiest method - it will prompt you for all the details and handle password hashing automatically.

### Steps:

1. **Run the script:**
   ```bash
   npm run create-admin
   ```

2. **Follow the prompts:**
   - Enter admin name
   - Enter admin email
   - Enter admin password (will be hashed automatically)
   - Enter company name

3. **Done!** The admin user will be created with `approval_status: 'approved'`

### Example:
```bash
$ npm run create-admin
=== Create Admin User ===

Enter admin name: John Admin
Enter admin email: admin@company.com
Enter admin password: securePassword123
Enter company name: Admin Company

Hashing password...
Creating admin user...

✅ Admin user created successfully!

User details:
{
  "id": "uuid-here",
  "name": "John Admin",
  "email": "admin@company.com",
  "company_name": "Admin Company",
  "approval_status": "approved"
}

You can now use this email to login.
```

---

## Method 2: Using SQL Directly

If you prefer to use SQL directly in Supabase SQL Editor:

### Step 1: Generate Password Hash

Run this command in your terminal to generate the bcrypt hash:

```bash
node -e "const bcrypt=require('bcrypt');bcrypt.hash('YOUR_PASSWORD',10).then(h=>console.log(h))"
```

Replace `YOUR_PASSWORD` with your desired password. This will output a hash like:
```
$2b$10$abcdefghijklmnopqrstuvwxyz...
```

### Step 2: Run SQL in Supabase

1. Go to Supabase Dashboard → **SQL Editor**
2. Copy and paste the SQL from `scripts/create-admin-sql.sql`
3. Replace the placeholders:
   - `'Admin User'` - Admin name
   - `'admin@example.com'` - Admin email
   - `'$2b$10$YOUR_HASHED_PASSWORD'` - The hash from Step 1
   - `'Admin Company'` - Company name
4. Execute the SQL

### Example SQL:
```sql
INSERT INTO users (
  name,
  email,
  password_hash,
  company_name,
  approval_status,
  file_url,
  file_name
) VALUES (
  'John Admin',
  'admin@company.com',
  '$2b$10$abc123...', -- Replace with your generated hash
  'Admin Company',
  'approved',
  NULL,
  NULL
);
```

---

## Method 3: Update Existing User to Admin

If you have an existing user that you want to make an admin:

### Option A: Using SQL
```sql
-- Update existing user to approved status
UPDATE users
SET approval_status = 'approved'
WHERE email = 'existing@user.com';
```

### Option B: Using Admin API (if user is already approved)
```bash
curl -X PATCH http://localhost:5000/api/admin/approve/USER_ID \
  -H "x-admin-token: your_admin_token"
```

---

## Quick Password Hash Generator

If you need to generate a password hash quickly, you can create a simple script:

**Create `scripts/hash-password.js`:**
```javascript
const bcrypt = require('bcrypt');
const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

bcrypt.hash(password, 10).then(hash => {
  console.log('Password hash:', hash);
});
```

**Usage:**
```bash
node scripts/hash-password.js myPassword123
```

---

## Verify Admin User

After creating the admin, verify it exists:

```sql
SELECT id, name, email, company_name, approval_status, created_at 
FROM users 
WHERE email = 'admin@example.com';
```

Or use the admin API:

```bash
curl -X GET http://localhost:5000/api/admin/users?status=approved \
  -H "x-admin-token: your_admin_token"
```

---

## Notes

1. **Admin users** are created with `approval_status: 'approved'` so they can login immediately
2. **No file required** - Admin users don't need to upload a file
3. **Password security** - Use a strong password for admin accounts
4. **Environment variables** - Make sure your `.env` has `SUPABASE_SERVICE_ROLE_KEY` set for the script to work

---

## Troubleshooting

**Error: "User with email already exists"**
- The email is already in use. Use a different email or update the existing user.

**Error: "Missing Supabase environment variables"**
- Check your `.env` file has `SUPABASE_SERVICE_ROLE_KEY` set.

**Error: "bcrypt is not found"**
- Run `npm install` to ensure all dependencies are installed.

