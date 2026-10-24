/**
 * Forward-only schema migrations. Each runs once, inside a transaction.
 * Statements are separated by a semicolon at the end of a line.
 * Runs against PostgreSQL 13+ (gen_random_uuid is built in).
 */
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial schema",
    sql: `
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  org_type TEXT NOT NULL DEFAULT 'Other',
  plan TEXT NOT NULL DEFAULT 'free',
  plan_expires_at TIMESTAMPTZ,
  suspended BOOLEAN NOT NULL DEFAULT false,
  branding JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE org_members (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','officer','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members(user_id);
CREATE TABLE org_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','officer','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT 'custom',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused','closed','archived')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  results_published BOOLEAN NOT NULL DEFAULT false,
  cover_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_org_idx ON events(org_id);
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'single' CHECK (method IN ('single','multiple','ranked')),
  max_choices INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX categories_event_idx ON categories(event_id);
CREATE TABLE options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','pending','rejected')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  submitted_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);
CREATE INDEX options_category_idx ON options(category_id);
CREATE TABLE voters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  ref TEXT,
  weight NUMERIC(18,4) NOT NULL DEFAULT 1,
  access_code TEXT NOT NULL,
  invited_at TIMESTAMPTZ,
  voted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, access_code)
);
CREATE INDEX voters_event_idx ON voters(event_id);
CREATE UNIQUE INDEX voters_event_email_uq ON voters(event_id, lower(email)) WHERE email IS NOT NULL;
CREATE TABLE ballots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  receipt TEXT NOT NULL UNIQUE,
  weight NUMERIC(18,4) NOT NULL DEFAULT 1,
  voter_id UUID REFERENCES voters(id) ON DELETE SET NULL,
  choices JSONB NOT NULL,
  voter_info JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ballots_event_idx ON ballots(event_id);
CREATE TABLE participants (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, identity_hash)
);
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'votes' CHECK (kind IN ('votes','plan')),
  provider TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  provider_ref TEXT,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  platform_fee_minor BIGINT NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  option_id UUID REFERENCES options(id) ON DELETE SET NULL,
  plan_id TEXT,
  payer_name TEXT,
  payer_email TEXT,
  payer_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX payments_event_idx ON payments(event_id);
CREATE INDEX payments_org_idx ON payments(org_id);
CREATE TABLE votes (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  quantity NUMERIC(18,4) NOT NULL,
  rank INTEGER,
  source TEXT NOT NULL CHECK (source IN ('ballot','free','paid','manual')),
  ballot_id UUID REFERENCES ballots(id) ON DELETE CASCADE,
  payment_id UUID UNIQUE REFERENCES payments(id) ON DELETE SET NULL,
  identity_hash TEXT,
  voter_info JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX votes_event_option_idx ON votes(event_id, option_id);
CREATE INDEX votes_identity_idx ON votes(event_id, category_id, identity_hash);
CREATE TABLE email_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_codes_lookup_idx ON email_codes(event_id, email);
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_log(org_id, created_at DESC);
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
`,
  },
  {
    id: 2,
    name: "advanced voting, groups, proxies, passes, api keys",
    sql: `
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_method_check;
ALTER TABLE categories ADD CONSTRAINT categories_method_check CHECK (method IN ('single','multiple','ranked','stv','borda','score','cumulative'));
ALTER TABLE categories ADD COLUMN points INTEGER NOT NULL DEFAULT 10;
ALTER TABLE categories ADD COLUMN allow_write_in BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE categories ADD COLUMN threshold_percent NUMERIC(6,3);
ALTER TABLE categories ADD COLUMN voter_groups TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE options DROP CONSTRAINT IF EXISTS options_status_check;
ALTER TABLE options ADD CONSTRAINT options_status_check CHECK (status IN ('approved','pending','rejected','writein'));
ALTER TABLE voters ADD COLUMN group_name TEXT;
ALTER TABLE voters ADD COLUMN proxy_voter_id UUID REFERENCES voters(id) ON DELETE SET NULL;
ALTER TABLE voters ADD COLUMN voted_by_proxy BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE voters ADD COLUMN last_reminded_at TIMESTAMPTZ;
ALTER TABLE ballots ADD COLUMN comment TEXT;
ALTER TABLE events ADD COLUMN pass_voters INTEGER;
ALTER TABLE events ADD COLUMN access_password_hash TEXT;
ALTER TABLE events ADD COLUMN reminder_sent_at TIMESTAMPTZ;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('votes','plan','pass'));
ALTER TABLE payments ADD COLUMN pass_id TEXT;
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX api_keys_org_idx ON api_keys(org_id);
`,
  },
  {
    id: 3,
    name: "self-serve subscriptions",
    sql: `
ALTER TABLE organizations ADD COLUMN plan_reminded_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN plan_started_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN months INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    id: 4,
    name: "auto-renewing subscriptions, legal acceptance, ads",
    sql: `
CREATE TABLE subscriptions (
  org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  months INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','past_due','canceled')),
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  auth_enc TEXT,
  card_last4 TEXT,
  card_brand TEXT,
  card_exp TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_charged_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at TIMESTAMPTZ;
CREATE TABLE ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  image_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  link_url TEXT NOT NULL,
  cta TEXT NOT NULL DEFAULT 'Learn more',
  placements TEXT[] NOT NULL DEFAULT '{voting_page,dashboard}',
  plan_ids TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  weight INTEGER NOT NULL DEFAULT 1,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];
