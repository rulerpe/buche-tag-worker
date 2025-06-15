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

### POST `/tag-queue` (🌟 Recommended - Durable Object Powered)
Queue ALL untagged snippets for AI processing using Durable Objects and Cloudflare Queues.

**Request Body:** (empty)
```json
{}
```

**Response:**
```json
{
  "success": true,
  "message": "Started queuing all untagged snippets in background",
  "note": "Use getProgress() to check status"
}
```

**How it works:**
- Uses **Durable Object** for persistent background processing
- **No API rate limits** - processes snippets in small batches with delays
- **Fire-and-forget** - starts immediately and runs independently
- **Real-time progress tracking** via separate endpoints

### GET `/tag-queue/progress` (🆕 Real-time Progress)
Get detailed progress from the Durable Object queue manager.

**Response:**
```json
{
  "total": 1942,
  "queued": 1763,
  "failed": 2,
  "status": "processing",
  "startedAt": "2025-06-14T23:30:00Z",
  "lastProcessedId": "snippet_abc_123"
}
```

**Status values:**
- `idle` - No processing active
- `processing` - Currently queuing snippets
- `completed` - All snippets queued successfully
- `error` - Encountered an error

### POST `/tag-queue/retry` (🔧 Troubleshooting)
Retry queuing any remaining untagged snippets (useful for recovery).

**Response:**
```json
{
  "success": true,
  "message": "Restarted queuing process for remaining untagged snippets"
}
```

### POST `/tag-queue/stop` (⏹️ Control)
Stop the current Durable Object queuing process.

**Response:**
```json
{
  "success": true,
  "message": "Stop signal sent. Processing will halt after current batch."
}
```

### GET `/queue-status` (📊 Enhanced Monitoring)
Comprehensive queue and database status with diagnostics.

**Response:**
```json
{
  "database": {
    "totalSnippets": 1942,
    "taggedSnippets": 1763,
    "untaggedSnippets": 179,
    "totalTags": 571,
    "processingProgress": "90.8%"
  },
  "queue": {
    "isConfigured": true,
    "pendingSnippets": 179,
    "processingMode": "queue-based",
    "consumerSettings": {
      "maxBatchSize": 25,
      "maxBatchTimeout": "15 seconds",
      "maxRetries": 5,
      "retryDelay": "30 seconds"
    }
  },
  "durableObject": {
    "total": 1942,
    "queued": 1763,
    "failed": 0,
    "status": "completed"
  },
  "recommendations": [
    "Run POST /tag-queue/retry to retry queuing remaining snippets",
    "Check dead letter queue in Cloudflare dashboard for failed messages"
  ],
  "status": "processing",
  "timestamp": "2025-06-14T23:41:58Z"
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

### 1. Durable Object-Powered Queue Processing (Production) 🆕

**High-Level Architecture:**
```
Main Worker → Durable Object → Cloudflare Queue → Queue Consumers
     ↓              ↓               ↓                ↓
  API Calls    Background       Message         AI Processing
              Processing        Storage         & Tagging
```

**Durable Object Processing Flow:**
1. **`POST /tag-queue`**: Main worker calls Durable Object via RPC
2. **Background Queuing**: DO processes ALL untagged snippets in background
3. **Batched Rate Limiting**: DO queues snippets in batches of 10 with 300ms delays
4. **Persistent State**: DO tracks progress in durable storage
5. **Fire-and-Forget**: Returns immediately while DO continues working

**Durable Object Benefits:**
- ✅ **No API Rate Limits**: Processes in small batches with proper delays
- ✅ **Persistent Progress**: Survives worker restarts and timeouts
- ✅ **Real-time Monitoring**: Check progress anytime with `/tag-queue/progress`
- ✅ **Error Recovery**: Use `/tag-queue/retry` to handle stuck processing
- ✅ **Scalable**: Handles unlimited snippets without timeout issues

**Queue Consumer Processing:**
1. **Automatic Processing**: Queue consumers process snippets in batches of 25
2. **Rate Limiting**: Maximum 5 concurrent AI requests with 1-second delays
3. **Error Handling**: Automatic retry with exponential backoff (30s → 60s → 120s)
4. **Dead Letter Queue**: Failed messages after max retries go to DLQ

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
    "producers": [
      {
        "binding": "TAGGING_QUEUE",
        "queue": "content-tagging-queue"
      }
    ],
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

### Durable Object Configuration 🆕
```json
{
  "durable_objects": {
    "bindings": [
      {
        "name": "QUEUE_MANAGER",
        "class_name": "QueueManager"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["QueueManager"]
    }
  ]
}
```

### Constants
- `SIMILARITY_THRESHOLD`: 0.8 (text similarity threshold for tag matching)
- `MAX_TAGS`: 3000 (maximum number of global tags)
- `CONCURRENT_LIMIT`: 5 (max concurrent AI requests per batch)
- `BATCH_DELAY`: 1000ms (delay between processing batches)

## Usage Example

### Complete Workflow (Durable Object + Queue-Based) 🆕

1. **Initialize Schema**:
```bash
curl -X POST https://your-worker.workers.dev/init-schema
```

2. **🚀 Start Durable Object Queue Processing**:
```bash
curl -X POST https://your-worker.workers.dev/tag-queue
# Response: {"success": true, "message": "Started queuing all untagged snippets in background"}
```

3. **📊 Real-time Progress Monitoring**:
```bash
# Check Durable Object progress (detailed)
curl https://your-worker.workers.dev/tag-queue/progress

# Check overall system status (comprehensive)
curl https://your-worker.workers.dev/queue-status

# Check basic database status
curl https://your-worker.workers.dev/status
```

**Sample Progress Response:**
```json
{
  "total": 1942,
  "queued": 1763,
  "failed": 2,
  "status": "processing",
  "startedAt": "2025-06-14T23:30:00Z",
  "lastProcessedId": "snippet_abc_123"
}
```

4. **🔧 Troubleshooting (if needed)**:
```bash
# If processing gets stuck at 90%, retry remaining snippets
curl -X POST https://your-worker.workers.dev/tag-queue/retry

# Stop processing if needed
curl -X POST https://your-worker.workers.dev/tag-queue/stop
```

5. **Preview Consolidation Plan**:
```bash
curl -X POST https://your-worker.workers.dev/consolidate \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

6. **Execute Consolidation**:
```bash
curl -X POST https://your-worker.workers.dev/consolidate \
  -H "Content-Type: application/json" \
  -d '{}'
```

7. **Check Final Results**:
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

## Advantages of Durable Object + Queue Architecture 🆕

### Durable Object Benefits
- **🚀 No API Rate Limits**: Processes snippets in small batches with proper delays
- **💾 Persistent State**: Survives worker restarts, timeouts, and deployments
- **🔄 Background Processing**: Fire-and-forget operation with real-time progress tracking
- **🛡️ Error Recovery**: Built-in retry mechanisms and manual recovery options
- **📊 Real-time Monitoring**: Check progress anytime without interrupting processing
- **⚡ Instant Response**: API calls return immediately while processing continues
- **🎯 Precision Control**: Stop, retry, or monitor processing at any time

### Production Benefits
- **🚀 No Timeouts**: Queue processing eliminates worker timeout limits
- **⚡ Automatic Scaling**: Cloudflare automatically scales queue consumers based on backlog
- **🔄 Built-in Retry**: Automatic retry logic with exponential backoff for failed messages
- **📊 Comprehensive Monitoring**: Detailed queue metrics, DO progress, and diagnostics
- **🛡️ Rate Limit Protection**: Built-in rate limiting prevents AI API quota exhaustion

### Two-Phase Processing Benefits
- **Fast Initial Processing**: Simple text similarity for immediate results
- **Intelligent Final Cleanup**: AI-powered semantic grouping for quality
- **Best of Both Worlds**: Speed during tagging + intelligence during consolidation
- **Cost Effective**: Minimal AI usage during high-volume tagging phase
- **Reviewable**: Dry-run mode lets you preview consolidations before applying

### Architecture Comparison
| Aspect | Legacy Batch | Queue-Based | **Durable Object + Queue** |
|--------|--------------|-------------|-------------------------|
| **API Rate Limits** | ❌ Hits limits | ❌ Hits limits | ✅ **No limits** |
| **Timeout Issues** | ❌ Worker limits | ✅ Asynchronous | ✅ **Background processing** |
| **Progress Tracking** | ❌ Basic | ✅ Queue metrics | ✅ **Real-time + persistent** |
| **Error Recovery** | ❌ Manual retry | ✅ Auto retry | ✅ **Smart recovery + manual control** |
| **Scalability** | ❌ Limited | ✅ Auto-scaling | ✅ **Unlimited + persistent** |
| **Production Ready** | ❌ No | ✅ Yes | ✅ **Enterprise-grade** |

### RPC vs HTTP Communication 🆕
- **Type Safety**: Direct method calls with TypeScript support
- **Performance**: No HTTP serialization overhead
- **Simplicity**: Clean method calls instead of URL routing
- **Reliability**: Direct RPC calls are more reliable than HTTP requests

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