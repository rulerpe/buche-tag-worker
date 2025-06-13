# Buche Tag Worker

The Buche Tag Worker is a Cloudflare Worker that automatically discovers and assigns tags to content snippets using AI text analysis and text similarity matching, with intelligent tag consolidation and **queue-based processing** for production scalability.

## Features

- **🚀 Queue-Based Processing**: Production-ready scalable processing without timeouts
- **⚡ Rate Limit Protection**: Built-in rate limiting and retry logic for AI API calls
- **🔄 Automatic Retry**: Smart error handling with exponential backoff
- **📊 Real-time Monitoring**: Detailed queue status and progress tracking
- **🤖 AI Tag Discovery**: Uses AI to analyze content and propose meaningful tags
- **🔀 Smart Tag Merging**: Employs text similarity to merge similar tags during processing
- **🧠 Intelligent Consolidation**: AI-powered post-processing to group semantically similar tags
- **🎯 Limited Tag Set**: Maintains a curated set of 20-30 global tags to prevent tag explosion
- **💾 Efficient Storage**: Stores relationships in D1 database with proper indexing
- **📈 Scalable Architecture**: Handles unlimited snippets with Cloudflare Queues

## API Endpoints

### POST `/tag-queue` (🌟 Recommended)
Queue all untagged snippets for AI processing using Cloudflare Queues.

**Request Body:** (empty)
```json
{}
```

**Response:**
```json
{
  "success": true,
  "message": "Queued 1,247 snippets for AI tagging",
  "queuedSnippets": 1247,
  "totalUntagged": 1247,
  "processingNote": "Snippets will be processed asynchronously by queue consumers"
}
```

### GET `/queue-status` (🆕 Queue Monitoring)
Monitor queue processing progress and status.

**Response:**
```json
{
  "database": {
    "totalSnippets": 5000,
    "taggedSnippets": 3750,
    "untaggedSnippets": 1250,
    "totalTags": 45,
    "processingProgress": "75.0%"
  },
  "queue": {
    "isConfigured": true,
    "pendingSnippets": 1250,
    "processingMode": "queue-based",
    "consumerSettings": {
      "maxBatchSize": 25,
      "maxBatchTimeout": "15 seconds",
      "maxRetries": 5,
      "retryDelay": "30 seconds"
    }
  },
  "status": "processing",
  "timestamp": "2025-01-08T10:30:00.000Z"
}
```

### POST `/tag` (Legacy)
Legacy batch processing mode for testing or small datasets.

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

### 1. Queue-Based Tag Processing (Production)

**Queue Processing Flow:**
1. **Queue All Snippets**: `/tag-queue` endpoint queues all untagged snippets
2. **Automatic Processing**: Queue consumers process snippets in batches of 25
3. **Rate Limiting**: Maximum 5 concurrent AI requests with 1-second delays
4. **Error Handling**: Automatic retry with exponential backoff (30s → 60s → 120s)
5. **Monitoring**: Real-time progress tracking via `/queue-status`

**For each snippet in the queue:**
1. **Fetches Content**: Retrieves snippet content from R2 storage
2. **AI Analysis**: Uses LLaMA 4 Scout to analyze content and propose 5-8 descriptive tags
3. **Text Similarity Check**: Compares proposed tags against existing tags using text similarity
4. **Tag Matching**: Uses normalized edit distance (threshold: 0.8) to find similar tags
5. **Tag Assignment**: Either assigns existing similar tag or creates new one (if under 3000-tag limit)
6. **Acknowledgment**: Message acknowledged on success or retried on failure

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

### Queue Configuration
```json
{
  "queues": {
    "consumers": [
      {
        "queue": "content-tagging-queue",
        "max_batch_size": 25,
        "max_batch_timeout": 15,
        "max_retries": 5,
        "dead_letter_queue": "content-tagging-dlq",
        "retry_delay": 30
      }
    ]
  }
}
```

### Constants
- `SIMILARITY_THRESHOLD`: 0.8 (text similarity threshold for tag matching)
- `MAX_TAGS`: 3000 (maximum number of global tags)
- `CONCURRENT_LIMIT`: 5 (max concurrent AI requests per batch)
- `BATCH_DELAY`: 1000ms (delay between processing batches)

## Usage Example

### Complete Workflow (Queue-Based)

1. **Initialize Schema**:
```bash
curl -X POST https://your-worker.workers.dev/init-schema
```

2. **🚀 Queue All Snippets for Processing**:
```bash
curl -X POST https://your-worker.workers.dev/tag-queue
```

3. **📊 Monitor Processing Progress**:
```bash
# Check detailed queue status
curl https://your-worker.workers.dev/queue-status

# Check general status
curl https://your-worker.workers.dev/status
```

4. **Preview Consolidation Plan**:
```bash
curl -X POST https://your-worker.workers.dev/consolidate \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

5. **Execute Consolidation**:
```bash
curl -X POST https://your-worker.workers.dev/consolidate \
  -H "Content-Type: application/json" \
  -d '{}'
```

6. **Check Final Results**:
```bash
curl https://your-worker.workers.dev/status
curl https://your-worker.workers.dev/tags
```

### Legacy Workflow (Batch Processing)

For testing or small datasets, you can still use the legacy batch mode:

```bash
# Legacy: Process in batches (may timeout on large datasets)
curl -X POST https://your-worker.workers.dev/tag \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 20}'
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

## Advantages of Queue-Based Architecture

### Production Benefits
- **🚀 No Timeouts**: Queue processing eliminates worker timeout limits
- **⚡ Automatic Scaling**: Cloudflare automatically scales queue consumers based on backlog
- **🔄 Built-in Retry**: Automatic retry logic with exponential backoff for failed messages
- **📊 Real-time Monitoring**: Detailed queue metrics and processing progress
- **🛡️ Rate Limit Protection**: Built-in rate limiting prevents AI API quota exhaustion

### Two-Phase Processing Benefits
- **Fast Initial Processing**: Simple text similarity for immediate results
- **Intelligent Final Cleanup**: AI-powered semantic grouping for quality
- **Best of Both Worlds**: Speed during tagging + intelligence during consolidation
- **Cost Effective**: Minimal AI usage during high-volume tagging phase
- **Reviewable**: Dry-run mode lets you preview consolidations before applying

### Queue vs Legacy Comparison
| Aspect | Legacy Batch Mode | Queue-Based Processing |
|--------|-------------------|------------------------|
| **Timeout Issues** | Yes (worker limits) | No (asynchronous) |
| **Rate Limiting** | Manual management | Automatic with retry |
| **Scalability** | Limited by batch size | Unlimited (auto-scaling) |
| **Error Handling** | Manual retry required | Automatic retry with backoff |
| **Monitoring** | Basic progress tracking | Detailed queue metrics |
| **Production Ready** | No (timeouts on large datasets) | Yes (any dataset size) |

## Error Handling

The worker includes comprehensive error handling:

### Queue-Based Error Handling
- **Rate Limit Errors**: Automatic retry with 60-second delay for `429` errors
- **Temporary Errors**: Standard retry for network timeouts and `503` errors
- **Permanent Errors**: Skip processing for `not found` errors to avoid infinite loops
- **Dead Letter Queue**: Failed messages after max retries go to DLQ for analysis
- **Explicit Acknowledgment**: Messages only acknowledged after successful processing

### General Error Handling
- Individual snippet processing errors are logged but don't stop batch processing
- AI model failures are gracefully handled with fallback behavior
- Database constraints prevent duplicate tags and maintain referential integrity
- Consolidation failures don't corrupt existing data
- Detailed error reporting in response statistics and queue metrics

### Monitoring Failed Processing
```bash
# Check queue status for error information
curl https://your-worker.workers.dev/queue-status

# Messages that fail max retries will be in the dead letter queue
# Check Cloudflare dashboard for DLQ messages
``` 