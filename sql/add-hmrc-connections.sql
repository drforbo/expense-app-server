-- HMRC MTD OAuth connection storage
-- Stores OAuth tokens and HMRC business details for MTD submissions

CREATE TABLE IF NOT EXISTS hmrc_connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- OAuth tokens
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read:self-assessment write:self-assessment',

  -- HMRC business details (fetched after initial connection)
  hmrc_business_id TEXT,          -- from Business Details API
  nino TEXT,                       -- National Insurance Number (encrypted at rest by Supabase)
  business_type TEXT DEFAULT 'self-employment',  -- self-employment, uk-property, foreign-property
  trading_name TEXT,
  quarterly_period_type TEXT,      -- standard or calendar

  -- Connection metadata
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_refreshed_at TIMESTAMPTZ,
  last_submission_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  environment TEXT DEFAULT 'sandbox',  -- sandbox or production

  -- Ensure one connection per user
  UNIQUE(user_id)
);

-- Row Level Security
ALTER TABLE hmrc_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own HMRC connection"
  ON hmrc_connections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own HMRC connection"
  ON hmrc_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own HMRC connection"
  ON hmrc_connections FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own HMRC connection"
  ON hmrc_connections FOR DELETE
  USING (auth.uid() = user_id);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_hmrc_connections_user_id ON hmrc_connections(user_id);

-- OAuth state storage (temporary, for CSRF protection during auth flow)
CREATE TABLE IF NOT EXISTS hmrc_oauth_states (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Auto-cleanup expired states
CREATE INDEX IF NOT EXISTS idx_hmrc_oauth_states_expires ON hmrc_oauth_states(expires_at);

-- Add NINO field to user_profiles (needed for HMRC API calls)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS nino TEXT;
