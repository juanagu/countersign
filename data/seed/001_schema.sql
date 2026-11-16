-- Mock bank schema. Re-runnable: `make seed` drops and recreates everything.
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS bank CASCADE;
CREATE SCHEMA bank;
SET search_path TO bank;

CREATE TABLE customers (
  id         text PRIMARY KEY,
  full_name  text NOT NULL
);

CREATE TABLE accounts (
  id           text PRIMARY KEY,
  customer_id  text NOT NULL REFERENCES customers (id),
  kind         text NOT NULL CHECK (kind IN ('savings', 'checking')),
  currency     text NOT NULL CHECK (currency IN ('ARS', 'USD')),
  alias        text NOT NULL,
  number       text NOT NULL UNIQUE,
  balance      numeric(18, 2) NOT NULL
);
CREATE INDEX accounts_customer_idx ON accounts (customer_id);

CREATE TABLE transactions (
  id           bigserial PRIMARY KEY,
  account_id   text NOT NULL REFERENCES accounts (id),
  booked_at    timestamptz NOT NULL,
  amount       numeric(18, 2) NOT NULL, -- negative = debit
  category     text NOT NULL,
  merchant     text NOT NULL,
  memo         text
);
CREATE INDEX transactions_account_date_idx ON transactions (account_id, booked_at DESC);

CREATE TABLE beneficiaries (
  id           text PRIMARY KEY,
  customer_id  text NOT NULL REFERENCES customers (id),
  full_name    text NOT NULL,
  bank_name    text NOT NULL,
  account_ref  text NOT NULL, -- CBU/alias of the destination, masked when shown
  currency     text NOT NULL CHECK (currency IN ('ARS', 'USD'))
);
CREATE INDEX beneficiaries_customer_idx ON beneficiaries (customer_id);

CREATE TABLE transfer_drafts (
  id                 text PRIMARY KEY,
  customer_id        text NOT NULL REFERENCES customers (id),
  source_account_id  text NOT NULL REFERENCES accounts (id),
  beneficiary_id     text NOT NULL REFERENCES beneficiaries (id),
  amount             numeric(18, 2) NOT NULL CHECK (amount > 0),
  currency           text NOT NULL,
  fee                numeric(18, 2) NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending', 'executed', 'expired', 'cancelled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);

-- Single-use step-up tokens. A token is spent inside the transaction that evaluates its draft,
-- so a row here with no transfer naming it means the attempt moved no money.
CREATE TABLE used_jtis (
  jti        text PRIMARY KEY,
  draft_id   text NOT NULL REFERENCES transfer_drafts (id),
  used_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id               text PRIMARY KEY,
  draft_id         text NOT NULL UNIQUE REFERENCES transfer_drafts (id), -- one execution per draft
  step_up_jti      text NOT NULL UNIQUE REFERENCES used_jtis (jti),      -- the token that executed it
  executed_at      timestamptz NOT NULL DEFAULT now(),
  reference        text NOT NULL
);
