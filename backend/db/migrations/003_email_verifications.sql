-- Sign-up with email verification.
-- A visitor first registers an email and password and verifies the email with a 6-digit code. Only then do they pick a
-- role and fill in a profile, which creates the real users / patients / doctors rows. Until that moment the pending
-- sign-up lives here, so there is never a half-created user.
--  * email:         lower-cased; one pending sign-up per email.
--  * password_hash: scrypt hash, same format as users.password_hash. The password itself is never stored.
--  * code_hash:     HMAC of the 6-digit code, never the code itself.
--  * attempts:      wrong guesses against the current code (capped in the application).

CREATE TABLE email_verifications (
  email         varchar(255) PRIMARY KEY,
  password_hash varchar(255) NOT NULL,
  code_hash     varchar(128) NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  verified_at   timestamptz,
  last_sent_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_email_verification_lowercase CHECK (email = lower(email)),
  CONSTRAINT ck_email_verification_attempts CHECK (attempts >= 0)
);
