# Buche Tag Worker

The Buche Tag Worker is a Cloudflare Worker that automatically discovers and assigns tags to content snippets using AI text analysis and simple text similarity matching, with intelligent tag consolidation.

## Features

- **AI Tag Discovery**: Uses AI to analyze content and propose meaningful tags
- **Smart Tag Merging**: Employs text similarity to merge similar tags during processing
- **Intelligent Consolidation**: AI-powered post-processing to group semantically similar tags
- **Limited Tag Set**: Maintains a curated set of 20-30 global tags to prevent tag explosion
- **Efficient Storage**: Stores relationships in D1 database with proper indexing
- **Batch Processing**: Can process snippets individually or in batches
- **Simple & Fast**: No embedding calculations during tagging - uses efficient text similarity

## API Endpoints

### POST `/tag`
Start the tagging process for snippets.

**Request Body:**
```json
{
  "snippetId": "specific-snippet-id",  // Optional: process specific snippet
  "batchSize": 10,                     // Optional: number of snippets per batch (default: 10)
  "startFromId": "snippet-id"          // Optional: resume from specific snippet
}
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "processedSnippets": 5,
    "newTagsCreated": 2,
    "existingTagsUsed": 8,
    "totalTags": 15,
    "errors": []
  }
}
```

### POST `/consolidate`
Consolidate similar tags using AI analysis (run after tagging is complete).

**Request Body:**
```json
{
  "dryRun": true  // Optional: preview consolidations without executing (default: false)
}
```

**Response:**
```json
{
  "success": true,
  "dryRun": false,
  "totalTags": 25,
  "consolidationGroups": 3,
  "consolidationsPerformed": 3,
  "consolidations": [
    {
      "primaryTag": {
        "id": 1,
        "name": "romantic encounter",
        "usageCount": 15
      },
      "mergedTags": [
        {"id": 5, "name": "intimate moment"},
        {"id": 12, "name": "passionate scene"}
      ],
      "snippetsUpdated": 8,
      "reason": "All refer to romantic scenes"
    }
  ]
}
```

### GET `/status`
Check current tagging status and database statistics.

**Response:**
```json
{
  "totalSnippets": 100,
  "totalTags": 25,
  "taggedSnippets": 75,
  "untaggedSnippets": 25,
  "status": "active"
}
```

### GET `/tags`
List all discovered tags with usage statistics.

**Response:**
```json
{
  "success": true,
  "tags": [
    {
      "id": 1,
      "name": "romantic encounter",
      "created_at": "2024-01-15T10:30:00Z",
      "usage_count": 25
    }
  ],
  "totalTags": 15
}
```

### POST `/init-schema`
Initialize the database schema with required tables.

## Workflow

### 1. Tag Discovery Process (Fast)

For each snippet, the worker:

1. **Fetches Content**: Retrieves snippet content from R2 storage
2. **AI Analysis**: Uses LLaMA 3.1 to analyze content and propose 1-2 descriptive tags
3. **Text Similarity Check**: Compares proposed tags against existing tags using text similarity
4. **Tag Matching**: Uses normalized edit distance (threshold: 0.8) to find similar tags
5. **Tag Assignment**: Either assigns existing similar tag or creates new one (if under 30-tag limit)

### 2. Tag Consolidation Process (Smart)

After tagging is complete, run consolidation:

1. **AI Analysis**: Analyzes all existing tags for semantic similarity
2. **Grouping**: Groups tags like "romantic encounter", "intimate moment", "passionate scene"
3. **Primary Selection**: Chooses most popular tag in each group as primary
4. **Relationship Update**: Updates all snippet relationships to use primary tags
5. **Cleanup**: Removes redundant tags and updates usage counts

## Two-Phase Approach Benefits

| Phase | Method | Benefits |
|-------|--------|----------|
| **Tagging** | Text similarity | Fast processing, simple logic, handles obvious duplicates |
| **Consolidation** | AI semantic analysis | Intelligent grouping, catches semantic similarity, clean final tag set |

## Database Schema

The worker uses three main tables:

**snippets**: Stores snippet metadata and assigned tag IDs
```sql
CREATE TABLE snippets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    source_url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tags TEXT -- JSON array of tag IDs
);
```

**tags**: Global tag repository (simplified - no embeddings)
```sql
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    usage_count INTEGER DEFAULT 0
);
```

**snippet_tags**: Junction table for many-to-many relationships
```sql
CREATE TABLE snippet_tags (
    snippet_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (snippet_id, tag_id),
    FOREIGN KEY (snippet_id) REFERENCES snippets(id),
    FOREIGN KEY (tag_id) REFERENCES tags(id)
);
```

## AI Models Used

- **Text Generation**: `@cf/meta/llama-3.1-8b-instruct` for tag proposal and consolidation analysis
- **Text Similarity**: Levenshtein distance algorithm for tag matching

## Configuration

### Environment Variables
Configure in `wrangler.jsonc`:

```json
{
  "r2_buckets": [
    {
      "binding": "CONTENT_BUCKET",
      "bucket_name": "erotic-content-snippets"
    }
  ],
  "d1_databases": [
    {
      "binding": "CONTENT_DB", 
      "database_name": "erotic-content-metadata",
      "database_id": "your-database-id"
    }
  ],
  "ai": {
    "binding": "AI"
  }
}
```

### Constants
- `SIMILARITY_THRESHOLD`: 0.8 (text similarity threshold for tag matching)
- `MAX_TAGS`: 30 (maximum number of global tags)

## Usage Example

### Complete Workflow

1. **Initialize Schema**:
```bash
curl -X POST https://your-worker.workers.dev/init-schema
```

2. **Process All Snippets (Fast)**:
```bash
curl -X POST https://your-worker.workers.dev/tag \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 20}'
```

3. **Preview Consolidation Plan**:
```bash
curl -X POST https://your-worker.workers.dev/consolidate \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

4. **Execute Consolidation**:
```bash
curl -X POST https://your-worker.workers.dev/consolidate \
  -H "Content-Type: application/json" \
  -d '{}'
```

5. **Check Final Results**:
```bash
curl https://your-worker.workers.dev/status
curl https://your-worker.workers.dev/tags
```

### Example Consolidation

**Before Consolidation:**
- "romantic encounter" (used 10 times)
- "intimate moment" (used 5 times)  
- "passionate scene" (used 3 times)
- "tender embrace" (used 8 times)
- "loving embrace" (used 2 times)

**After Consolidation:**
- "romantic encounter" (used 18 times) ← merged with "intimate moment", "passionate scene"
- "tender embrace" (used 10 times) ← merged with "loving embrace"

## Development

1. Install dependencies:
```bash
npm install
```

2. Run locally:
```bash
npm run dev
```

3. Deploy:
```bash
npm run deploy
```

## Advantages of Two-Phase Approach

- **Fast Initial Processing**: Simple text similarity for immediate results
- **Intelligent Final Cleanup**: AI-powered semantic grouping for quality
- **Best of Both Worlds**: Speed during tagging + intelligence during consolidation
- **Cost Effective**: Minimal AI usage during high-volume tagging phase
- **Reviewable**: Dry-run mode lets you preview consolidations before applying

## Error Handling

The worker includes comprehensive error handling:
- Individual snippet processing errors are logged but don't stop batch processing
- AI model failures are gracefully handled with fallback behavior
- Database constraints prevent duplicate tags and maintain referential integrity
- Consolidation failures don't corrupt existing data
- Detailed error reporting in response statistics 