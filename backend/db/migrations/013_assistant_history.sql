-- AI assistant: chat history. A doctor or patient can see their earlier conversations with the assistant, reopen one, and delete it.
--
-- Additive only: two new tables, nothing existing changes, and nothing here is read by booking, payments or scheduling.
-- What is stored is plain text and the NAMES of the lookups used, never a confirmation token or an action payload. A turn that produced
-- a confirmation card keeps only `had_card`, so history can say "Card expired": a card is never rebuilt from stored data.
-- Deleting a conversation deletes its messages (ON DELETE CASCADE); deleting a user deletes their conversations.

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       varchar(10) NOT NULL CHECK (role IN ('DOCTOR', 'PATIENT')),
  -- The first message of the conversation, shortened.
  title      varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- "My conversations, newest first", paged by (updated_at, id).
CREATE INDEX IF NOT EXISTS idx_assistant_conversations_user ON assistant_conversations (user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  -- The order messages were written in (a user message and its reply are saved together, so a timestamp alone could tie).
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  role            varchar(10) NOT NULL CHECK (role IN ('user', 'assistant')),
  text            text NOT NULL,
  -- Which lookups the assistant used for this reply (names only).
  tool_names      text[] NOT NULL DEFAULT '{}',
  -- True when this reply came with a confirmation card. The card itself is never stored.
  had_card        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation ON assistant_messages (conversation_id, seq);
