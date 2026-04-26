CREATE TABLE IF NOT EXISTS media_library (
  id TEXT PRIMARY KEY,
  title_en TEXT NOT NULL,
  title_ar TEXT,
  title_ur TEXT,
  title_tr TEXT,
  title_translation TEXT,
  type TEXT NOT NULL DEFAULT 'unknown',
  language TEXT NOT NULL DEFAULT 'Other',
  year INTEGER,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source_urls TEXT NOT NULL DEFAULT '[]',
  islamic_finance_relevance TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'New',
  source_prompt TEXT,
  notes TEXT,
  youtube_url TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  title TEXT,
  source_type TEXT,
  source_url TEXT,
  video_id TEXT,
  transcript_text TEXT,
  transcript_source TEXT,
  segment_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  has_timestamps INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Queued',
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  title TEXT,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_time REAL,
  end_time REAL,
  word_count INTEGER,
  embedding TEXT
);
