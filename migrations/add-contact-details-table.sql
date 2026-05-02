CREATE TABLE IF NOT EXISTS contact_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL DEFAULT 'pickup' CHECK (contact_type IN ('pickup', 'destination')),
  company_name TEXT NOT NULL,
  normalized_company_name TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  CONSTRAINT contact_details_user_company_unique
    UNIQUE (user_id, contact_type, normalized_company_name)
);

CREATE INDEX IF NOT EXISTS idx_contact_details_user_type_updated
  ON contact_details(user_id, contact_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_details_company_name
  ON contact_details(company_name);

DROP TRIGGER IF EXISTS update_contact_details_updated_at ON contact_details;

CREATE TRIGGER update_contact_details_updated_at
BEFORE UPDATE ON contact_details
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
