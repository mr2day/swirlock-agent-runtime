-- Layered summaries for long-context sessions.
--
-- The compactor's job is to keep each session under the active
-- model's effective context window without ever dropping data. It
-- does this by summarising the OLDEST uncompacted chunk of messages
-- into a `session_summaries` row that covers seq=start_seq..end_seq
-- of the original messages. The originals stay in `messages`
-- untouched - we keep them for:
--   - the Fragmenter (future: extracts entities / preferences /
--     topical recall from raw turns; needs original signal),
--   - the UI's "expand summary" affordance (user clicks a collapsed
--     summary block to see the underlying verbatim turns),
--   - any future need to re-summarise older blocks under a smarter
--     summariser.
--
-- The model's per-turn message history is built by walking the
-- summaries in seq order, emitting one synthetic system message per
-- block, then appending the still-uncompacted recent messages
-- verbatim. Summaries accumulate; they are NOT re-merged into a
-- single grand summary (that's the Fragmenter's job).

CREATE TABLE session_summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Inclusive range of messages.seq this summary covers. The
  -- compactor only ever extends forward — newer summaries cover
  -- higher seq ranges; ranges never overlap within a session.
  start_seq       bigint NOT NULL,
  end_seq         bigint NOT NULL,
  -- The summary text, in the original language of the conversation.
  -- Injected back into the agent's context as a synthetic system
  -- message labelled "[Summary of earlier turns]".
  summary_text    text NOT NULL,
  -- Char-count / 4 estimate of summary_text tokens. Stored so the
  -- compaction-trigger calculation doesn't have to re-count on every
  -- scan. Refreshed if the row is ever rewritten.
  token_count     integer NOT NULL,
  -- Which model produced this summary (e.g. claude-haiku-4-5-20251001,
  -- ministral-14b-latest, ministral-3:14b). Useful for debugging
  -- "why did this summary lose detail X" by seeing which family
  -- handled it.
  summary_model   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT session_summaries_seq_range CHECK (end_seq >= start_seq)
);

-- Most common query: "give me every summary for this session in
-- chronological order so I can build the message history."
CREATE INDEX session_summaries_session_id_start_seq_idx
  ON session_summaries (session_id, start_seq);

-- Compactor's "what's the latest seq covered by a summary?" query.
CREATE INDEX session_summaries_session_id_end_seq_idx
  ON session_summaries (session_id, end_seq DESC);
