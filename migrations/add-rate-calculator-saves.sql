-- Saved rate-calculator entries can be redeemed by their owner in Create Order.
CREATE TABLE IF NOT EXISTS rate_calculator_saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^RC-[0-9]{6}$'),
  form_data JSONB NOT NULL,
  quote_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_calculator_saves_user_created
  ON rate_calculator_saves(user_id, created_at DESC);

DROP TRIGGER IF EXISTS update_rate_calculator_saves_updated_at ON rate_calculator_saves;

CREATE TRIGGER update_rate_calculator_saves_updated_at
BEFORE UPDATE ON rate_calculator_saves
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
