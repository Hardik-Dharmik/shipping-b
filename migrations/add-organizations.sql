-- Migration: Add organizations and link users to them

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_code TEXT NOT NULL UNIQUE CHECK (organization_code ~ '^ORG-[0-9]{6}$'),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can access all organizations" ON organizations;

CREATE POLICY "Service role can access all organizations" ON organizations
  FOR ALL
  USING (true)
  WITH CHECK (true);

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_code ON organizations(organization_code);
CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(normalized_name);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS organization_ref UUID REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organization_code TEXT,
  ADD COLUMN IF NOT EXISTS organization_role TEXT NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS kyc_required BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_organization_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_organization_role_check
  CHECK (organization_role IN ('primary', 'employee'));

CREATE INDEX IF NOT EXISTS idx_users_organization_ref ON users(organization_ref);
CREATE INDEX IF NOT EXISTS idx_users_organization_code ON users(organization_code);
CREATE INDEX IF NOT EXISTS idx_users_kyc_required ON users(kyc_required);

WITH missing_organizations AS (
  SELECT DISTINCT
    company_name AS name,
    LOWER(TRIM(company_name)) AS normalized_name
  FROM users
  WHERE company_name IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM organizations
      WHERE organizations.normalized_name = LOWER(TRIM(users.company_name))
    )
),
numbered_organizations AS (
  SELECT
    name,
    normalized_name,
    ROW_NUMBER() OVER (ORDER BY normalized_name) AS row_num
  FROM missing_organizations
),
existing_count AS (
  SELECT COUNT(*) AS total
  FROM organizations
)
INSERT INTO organizations (organization_code, name, normalized_name)
SELECT
  'ORG-' || LPAD((100000 + existing_count.total + numbered_organizations.row_num - 1)::TEXT, 6, '0'),
  numbered_organizations.name,
  numbered_organizations.normalized_name
FROM numbered_organizations
CROSS JOIN existing_count
ON CONFLICT (normalized_name) DO NOTHING;

UPDATE users
SET
  organization_ref = organizations.id,
  organization_code = organizations.organization_code,
  company_name = organizations.name,
  organization_role = COALESCE(users.organization_role, 'primary'),
  kyc_required = COALESCE(users.kyc_required, TRUE)
FROM organizations
WHERE organizations.normalized_name = LOWER(TRIM(users.company_name))
  AND (
    users.organization_ref IS NULL
    OR users.organization_code IS NULL
  );

DROP TRIGGER IF EXISTS update_organizations_updated_at ON organizations;

CREATE TRIGGER update_organizations_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
