-- Database schema for erotic content metadata
CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    source_url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tags TEXT -- JSON array of tag IDs assigned to this snippet
);

-- Table to store the global tag list (simplified - no embeddings)
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    usage_count INTEGER DEFAULT 0 -- How many snippets use this tag
);

-- Junction table for many-to-many relationship between snippets and tags
CREATE TABLE IF NOT EXISTS snippet_tags (
    snippet_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (snippet_id, tag_id),
    FOREIGN KEY (snippet_id) REFERENCES snippets(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_snippets_title ON snippets(title);
CREATE INDEX IF NOT EXISTS idx_snippets_author ON snippets(author);
CREATE INDEX IF NOT EXISTS idx_snippets_created_at ON snippets(created_at);
CREATE INDEX IF NOT EXISTS idx_snippets_source_url ON snippets(source_url);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_snippet_tags_snippet_id ON snippet_tags(snippet_id);
CREATE INDEX IF NOT EXISTS idx_snippet_tags_tag_id ON snippet_tags(tag_id); 