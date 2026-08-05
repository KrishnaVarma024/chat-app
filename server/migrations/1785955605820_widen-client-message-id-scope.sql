-- Up Migration

-- Idempotency was scoped to (room_id, client_message_id), which lets any
-- member of a room collide with any OTHER member's client_message_id — the
-- second sender's request returns 201 but silently gets back the FIRST
-- sender's message instead of creating their own. Scoping to
-- (room_id, sender_id, client_message_id) makes idempotency mean what it
-- should: "did THIS sender already send this," not "has anyone."
ALTER TABLE messages DROP CONSTRAINT messages_room_id_client_message_id_key;
ALTER TABLE messages ADD CONSTRAINT messages_room_id_sender_id_client_message_id_key
  UNIQUE (room_id, sender_id, client_message_id);

-- Down Migration

ALTER TABLE messages DROP CONSTRAINT messages_room_id_sender_id_client_message_id_key;
ALTER TABLE messages ADD CONSTRAINT messages_room_id_client_message_id_key
  UNIQUE (room_id, client_message_id);