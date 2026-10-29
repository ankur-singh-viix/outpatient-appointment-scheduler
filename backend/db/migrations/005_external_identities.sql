-- Links an outside sign-in (Clerk) to a CareSlot user, without touching the users table.
--  * One external identity belongs to exactly one user (the primary key), and a user has at most one identity per
--    provider (the unique constraint), so a link can never be ambiguous.
--  * Nothing here replaces or changes an existing user, password hash or appointment. The legacy password login keeps
--    working exactly as before for every existing account.
--  * A link is only ever created after the person proves who they are (see the Clerk account service): a verified
--    Clerk identity plus either a brand-new profile or the existing account's own password. Never by email alone.

CREATE TABLE external_identities (
  provider    varchar(32)  NOT NULL,
  external_id varchar(255) NOT NULL,
  user_id     uuid         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  linked_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id),
  CONSTRAINT uq_external_identities_user_provider UNIQUE (user_id, provider)
);
