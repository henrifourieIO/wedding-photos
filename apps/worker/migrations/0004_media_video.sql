ALTER TABLE media ADD COLUMN poster_url TEXT;
ALTER TABLE media ADD COLUMN hls_url TEXT;
ALTER TABLE media ADD COLUMN dash_url TEXT;

CREATE UNIQUE INDEX idx_media_stream_uid ON media(stream_uid) WHERE stream_uid IS NOT NULL;
