-- Player accounts (relay/auth.js). Times are ms since epoch.

-- One row per sign-in identity: a Google or GitHub account (or the dev player).
-- email, name and avatar are refreshed from the provider on every sign-in.
CREATE TABLE users (
  id TEXT PRIMARY KEY,                 -- crypto.randomUUID()
  provider TEXT NOT NULL,              -- 'google' | 'github' | 'dev'
  provider_id TEXT NOT NULL,           -- the provider's stable account id
  email TEXT,
  name TEXT,
  avatar TEXT,
  plan TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'paid'
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

-- Signed-in browsers. Only the SHA-256 of each bearer token is kept.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at); -- the expired-session sweep

-- Sign-ins in flight: written by /auth/start, consumed by /auth/callback.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT,                       -- PKCE code verifier
  return_to TEXT NOT NULL,             -- the site page to send the player back to
  expires_at INTEGER NOT NULL
);
