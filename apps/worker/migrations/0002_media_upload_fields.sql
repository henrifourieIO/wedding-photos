ALTER TABLE media ADD COLUMN content_type TEXT;
ALTER TABLE media ADD COLUMN size_bytes INTEGER;

CREATE INDEX idx_media_guest ON media(guest_id, created_at);
CREATE INDEX idx_guests_event ON guests(event_id);
