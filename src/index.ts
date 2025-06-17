/**
 * Buche Tag Worker - Analyzes content snippets and assigns semantic tags
 * 
 * Features:
 * - Processes snippets to discover and assign tags
 * - Uses text similarity to merge similar tags
 * - Limits global tag set to 20-30 tags
 * - Stores tag relationships in D1 database
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
	CONTENT_BUCKET: R2Bucket;
	CONTENT_DB: D1Database;
	AI: Ai;
	TAGGING_QUEUE: Queue<QueueMessage>;
	QUEUE_MANAGER: DurableObjectNamespace<QueueManager>;
}

interface Tag {
	id: number;
	name: string;
	createdAt: string;
	usageCount: number;
}

interface Snippet {
	id: string;
	title: string;
	author: string;
	chapterIndex: number;
	sourceUrl: string;
	createdAt: string;
	tags?: string; // JSON array of tag IDs
}

interface TaggingRequest {
	snippetId?: string; // Process specific snippet
	batchSize?: number; // Number of snippets to process in batch
	startFromId?: string; // Resume processing from specific snippet
}

interface TaggingStats {
	processedSnippets: number;
	newTagsCreated: number;
	existingTagsUsed: number;
	totalTags: number;
	errors: string[];
	lastProcessedId?: string; // Track the last processed snippet ID
}

interface QueueMessage {
	snippetId: string;
	timestamp: number;
	priority?: 'high' | 'medium' | 'low';
}

interface QueueProgress {
	total: number;
	queued: number;
	failed: number;
	status: 'idle' | 'processing' | 'completed' | 'error';
	startedAt?: string;
	completedAt?: string;
	lastProcessedId?: string;
	errorMessage?: string;
	// Chunked processing fields
	chunkSize: number;
	currentChunk: number;
	totalChunks: number;
	resumeFromId?: string;
	processedChunks: number;
}

const SIMILARITY_THRESHOLD = 0.8; // Text similarity threshold
const MAX_TAGS = 3000;
// Multi-agent prompts for focused tagging
const SEXUAL_ACTS_PROMPT = `分析这段情色内容，专注识别具体的性爱行为和玩法。

请为以下方面生成2个字的中文标签：
- 具体性行为（口交、肛交、指交、舔弄等）
- 性爱体位和技巧
- 前戏活动
- 特殊癖好和恋物

只返回相关的标签名称，每行一个，每个标签2个字。如果内容中没有明确的性爱行为，返回"无"。

内容：`;

const CONTEXT_SETTING_PROMPT = `分析这段情色内容的背景和情境设定。

请为以下方面生成2个字的中文标签：
- 场所环境（卧室、浴室、办公室、户外等）
- 时代背景（现代、古代、民国等）
- 题材类型（都市、玄幻、校园、职场等）
- 角色关系（恋人、夫妻、师生、陌生人等）

只返回相关的标签名称，每行一个，每个标签2个字。如果某方面不明确，可以不生成对应标签。

内容：`;

const INTENSITY_ATTRIBUTES_PROMPT = `分析这段情色内容的强度和情感属性。

请为以下方面生成2个字的中文标签：
- 情感强度（温柔、激情、粗暴、轻柔等）
- 身体强度（缓慢、激烈、狂野、温和等）
- 权力关系（主导、服从、平等、支配等）
- 情感氛围（浪漫、禁忌、刺激、甜蜜等）

只返回相关的标签名称，每行一个，每个标签2个字。重点关注内容的情感色彩和强度特征。

内容：`;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		
		if (url.pathname === '/tag') {
			return handleTagging(request, env);
		}
		
		if (url.pathname === '/tag-queue') {
			return handleQueueTagging(request, env);
		}
		
		if (url.pathname === '/status') {
			return handleStatus(env);
		}
		
		if (url.pathname === '/tags') {
			return handleTagsListing(request, env);
		}

		if (url.pathname === '/init-schema') {
			return handleInitSchema(env);
		}

		if (url.pathname === '/consolidate') {
			return handleTagConsolidation(request, env);
		}

		if (url.pathname === '/clear-tags') {
			return handleClearTags(request, env);
		}
		
		if (url.pathname === '/queue-status') {
			return handleQueueStatus(request, env);
		}
		
		if (url.pathname === '/tag-queue/progress') {
			return handleQueueProgress(request, env);
		}
		
		if (url.pathname === '/tag-queue/stop') {
			return handleQueueStop(request, env);
		}
		
		if (url.pathname === '/tag-queue/retry') {
			return handleQueueRetry(request, env);
		}
		
		if (url.pathname === '/tag-queue/chunk-size') {
			return handleChunkSizeConfig(request, env);
		}
		
		return new Response('Buche Tag Worker\n\nEndpoints:\n- POST /tag - Start tagging process (legacy batch mode)\n- POST /tag-queue - Queue ALL untagged snippets for AI processing via Durable Object\n- GET /tag-queue/progress - Get queue progress from Durable Object\n- POST /tag-queue/stop - Stop queue processing\n- POST /tag-queue/retry - Retry queuing remaining untagged snippets\n- GET/POST /tag-queue/chunk-size - Get or set chunk size for processing\n- GET /status - Check tagging status\n- GET /queue-status - Check queue processing status\n- GET /tags - List all tags\n- POST /init-schema - Initialize database schema\n- POST /consolidate - Consolidate similar tags\n- POST /clear-tags - Clear all tags and reset snippets');
	},

	async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
		return handleQueueBatch(batch, env, ctx);
	}
} satisfies ExportedHandler<Env>;

async function handleTagging(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		const body = await request.json() as TaggingRequest;
		const batchSize = body.batchSize || 10;
		
		await initializeDatabase(env.CONTENT_DB);
		
		let stats: TaggingStats = {
			processedSnippets: 0,
			newTagsCreated: 0,
			existingTagsUsed: 0,
			totalTags: 0,
			errors: []
		};

		if (body.snippetId) {
			// Process specific snippet
			await processSnippet(body.snippetId, env, stats);
		} else {
			// Process batch of untagged snippets
			await processBatch(batchSize, body.startFromId, env, stats);
		}

		// Update total tags count
		const tagsCount = await env.CONTENT_DB.prepare(
			'SELECT COUNT(*) as count FROM tags'
		).first();
		stats.totalTags = tagsCount?.count as number || 0;

		return new Response(JSON.stringify({
			success: true,
			stats,
			lastProcessedId: stats.lastProcessedId, // Return this for next batch
			nextBatchRequest: stats.lastProcessedId ? {
				batchSize,
				startFromId: stats.lastProcessedId
			} : null
		}), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Tagging error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleStatus(env: Env): Promise<Response> {
	try {
		const [snippetsResult, tagsResult, taggedResult] = await Promise.all([
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM snippets').first(),
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM tags').first(),
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM snippets WHERE tags IS NOT NULL AND tags != "[]"').first()
		]);
		const totalSnippets = (snippetsResult?.count as number) || 0;
		const totalTags = (tagsResult?.count as number) || 0;
		const taggedSnippets = (taggedResult?.count as number) || 0;
		
		return new Response(JSON.stringify({
			totalSnippets,
			totalTags,
			taggedSnippets,
			untaggedSnippets: totalSnippets - taggedSnippets,
			status: 'active'
		}), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({
			error: 'Database not initialized',
			status: 'inactive'
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleTagsListing(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'GET') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		let query = 'SELECT id, name, created_at, usage_count FROM tags ORDER BY usage_count DESC';
		const tags = await env.CONTENT_DB.prepare(query).all();
		
		return new Response(JSON.stringify({
			success: true,
			tags: tags.results,
			totalTags: tags.results.length
		}), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		console.error('Error listing tags:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleInitSchema(env: Env): Promise<Response> {
	try {
		await initializeDatabase(env.CONTENT_DB);
		return new Response(JSON.stringify({
			success: true,
			message: 'Database schema initialized successfully'
		}), {
			headers: { 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function processBatch(batchSize: number, startFromId: string | undefined, env: Env, stats: TaggingStats): Promise<void> {
	let query = 'SELECT * FROM snippets WHERE (tags IS NULL OR tags = "[]")';
	let params: any[] = [];
	
	if (startFromId) {
		query += ' AND id > ?';
		params.push(startFromId);
	}
	
	query += ' ORDER BY id LIMIT ?';
	params.push(batchSize);
	
	const snippets = await env.CONTENT_DB.prepare(query).bind(...params).all();
	
	for (const snippet of snippets.results as unknown as Snippet[]) {
		try {
			await processSnippet(snippet.id, env, stats);
			stats.processedSnippets++;
			stats.lastProcessedId = snippet.id; // Track the last processed ID
		} catch (error) {
			console.error(`Error processing snippet ${snippet.id}:`, error);
			stats.errors.push(`Snippet ${snippet.id}: ${error instanceof Error ? error.message : String(error)}`);
			stats.lastProcessedId = snippet.id; // Still update even on error to avoid getting stuck
		}
	}
}

async function processSnippet(snippetId: string, env: Env, stats: TaggingStats): Promise<void> {
	// Get snippet metadata and content
	const snippet = await env.CONTENT_DB.prepare(
		'SELECT * FROM snippets WHERE id = ?'
	).bind(snippetId).first() as Snippet;
	
	if (!snippet) {
		throw new Error(`Snippet ${snippetId} not found`);
	}
	
	// Get content from R2
	const r2Object = await env.CONTENT_BUCKET.get(snippetId);
	if (!r2Object) {
		throw new Error(`Content for snippet ${snippetId} not found in R2`);
	}
	
	const content = await r2Object.text();
	
	// Generate proposed tags using AI
	const proposedTags = await generateProposedTags(content, env.AI);
	
	// Process each proposed tag
	const assignedTagIds: number[] = [];
	
	for (const proposedTag of proposedTags) {
		const tagId = await processProposedTag(proposedTag, env, stats);
		if (tagId) {
			assignedTagIds.push(tagId);
		}
	}
	
	// Update snippet with assigned tags
	await updateSnippetTags(snippetId, assignedTagIds, env);
	
	// Update usage counts for assigned tags
	if (assignedTagIds.length > 0) {
		await updateTagUsageCounts(assignedTagIds, env);
	}
}

// Multi-agent tagging with 3 focused passes
async function generateProposedTags(content: string, ai: Ai): Promise<string[]> {
	try {
		// Truncate content if too long (AI models have token limits)
		const truncatedContent = content.length > 2000 ? content.substring(0, 2000) + '...' : content;
		
		// Run all 3 passes sequentially to prevent AI capacity exceeded errors
		const sexualActsTags = await generateSexualActsTags(truncatedContent, ai);
		await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between AI calls
		
		const contextTags = await generateContextTags(truncatedContent, ai);
		await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between AI calls
		
		const intensityTags = await generateIntensityTags(truncatedContent, ai);
		
		// Combine all tags from the 3 passes
		const allTags = [...sexualActsTags, ...contextTags, ...intensityTags];
		
		// Remove duplicates and limit total tags
		const uniqueTags = [...new Set(allTags)];
		
		// Limit to maximum 12 tags (4 from each pass)
		return uniqueTags.slice(0, 12);
		
	} catch (error) {
		console.error('Error generating proposed tags:', error);
		return [];
	}
}

// Pass 1: Sexual acts and behaviors
async function generateSexualActsTags(content: string, ai: Ai): Promise<string[]> {
	try {
		const response = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
			messages: [
				{
					role: 'user',
					content: SEXUAL_ACTS_PROMPT + content
				}
			],
			max_tokens: 50
		}) as any;
		
		const result = response.response as string;
		return parseTagResponse(result);
		
	} catch (error) {
		console.error('Error generating sexual acts tags:', error);
		return [];
	}
}

// Pass 2: Context and setting
async function generateContextTags(content: string, ai: Ai): Promise<string[]> {
	try {
		const response = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
			messages: [
				{
					role: 'user',
					content: CONTEXT_SETTING_PROMPT + content
				}
			],
			max_tokens: 50
		}) as any;
		
		const result = response.response as string;
		return parseTagResponse(result);
		
	} catch (error) {
		console.error('Error generating context tags:', error);
		return [];
	}
}

// Pass 3: Intensity and attributes
async function generateIntensityTags(content: string, ai: Ai): Promise<string[]> {
	try {
		const response = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
			messages: [
				{
					role: 'user',
					content: INTENSITY_ATTRIBUTES_PROMPT + content
				}
			],
			max_tokens: 50
		}) as any;
		
		const result = response.response as string;
		return parseTagResponse(result);
		
	} catch (error) {
		console.error('Error generating intensity tags:', error);
		return [];
	}
}

// Parse AI response and extract valid tags
function parseTagResponse(result: string): string[] {
	// Parse the response to extract tag names
	const rawTags = result
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.includes(':') && line !== '无')
		.slice(0, 4); // Max 4 tags per pass
	
	// Clean and filter tags
	const cleanedTags = rawTags
		.map(tag => cleanTag(tag))
		.filter(tag => tag.length > 0 && tag.length <= 4)
		.filter(tag => isValidChineseTag(tag));
	
	return cleanedTags;
}

function cleanTag(tag: string): string {
	// Remove all spaces and special characters, keep only Chinese characters, numbers, and basic punctuation
	return tag
		.replace(/[\s\u00A0\u3000]/g, '') // Remove all types of spaces
		.replace(/[^\u4e00-\u9fff\u3400-\u4dbf\u20000-\u2a6df\u2a700-\u2b73f\u2b740-\u2b81f\u2b820-\u2ceaf\u2ceb0-\u2ebef\u30000-\u3134f\u4e00-\u9fff\u3400-\u4dbf0-9]/g, '') // Keep only Chinese characters and numbers
		.trim();
}

function isValidChineseTag(tag: string): boolean {
	// Check if tag contains at least one Chinese character and is not empty
	const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf\u20000-\u2a6df\u2a700-\u2b73f\u2b740-\u2b81f\u2b820-\u2ceaf\u2ceb0-\u2ebef\u30000-\u3134f]/;
	
	// More strict validation: exactly 2 Chinese characters for focused tags
	const isExactlyTwoChars = tag.length === 2;
	const hasOnlyChineseChars = /^[\u4e00-\u9fff]+$/.test(tag);
	
	return isExactlyTwoChars && hasOnlyChineseChars && chineseRegex.test(tag);
}

async function processProposedTag(proposedTag: string, env: Env, stats: TaggingStats): Promise<number | null> {
	// Check if we've reached the tag limit
	const tagsCount = await env.CONTENT_DB.prepare(
		'SELECT COUNT(*) as count FROM tags'
	).first();
	
	const currentTagCount = (tagsCount?.count as number) || 0;
	
	// Get existing tags (no embeddings needed)
	const existingTags = await env.CONTENT_DB.prepare(
		'SELECT id, name FROM tags'
	).all();
	
	// Check for exact match or high text similarity
	let bestMatch: { tagId: number; similarity: number } | null = null;
	
	for (const tag of existingTags.results as unknown as Tag[]) {
		const similarity = textSimilarity(proposedTag.toLowerCase(), tag.name.toLowerCase());
		
		if (similarity >= SIMILARITY_THRESHOLD) {
			if (!bestMatch || similarity > bestMatch.similarity) {
				bestMatch = { tagId: tag.id, similarity };
			}
		}
	}
	
	if (bestMatch) {
		// Use existing tag
		stats.existingTagsUsed++;
		return bestMatch.tagId;
	} else if (currentTagCount < MAX_TAGS) {
		// Create new tag (without embedding)
		const newTag = await createNewTag(proposedTag, env);
		stats.newTagsCreated++;
		return newTag.id;
	} else {
		// Tag limit reached, skip this tag
		console.log(`Tag limit reached (${MAX_TAGS}), skipping tag: ${proposedTag}`);
		return null;
	}
}

// Simple text similarity using normalized edit distance
function textSimilarity(a: string, b: string): number {
	if (a === b) return 1.0;
	
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1.0;
	
	const editDistance = levenshteinDistance(a, b);
	return 1 - (editDistance / maxLen);
}

function levenshteinDistance(a: string, b: string): number {
	const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
	
	for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
	for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
	
	for (let j = 1; j <= b.length; j++) {
		for (let i = 1; i <= a.length; i++) {
			const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[j][i] = Math.min(
				matrix[j][i - 1] + 1, // insertion
				matrix[j - 1][i] + 1, // deletion
				matrix[j - 1][i - 1] + substitutionCost // substitution
			);
		}
	}
	
	return matrix[b.length][a.length];
}

async function createNewTag(name: string, env: Env): Promise<Tag> {
	const now = new Date().toISOString();
	
	const result = await env.CONTENT_DB.prepare(
		'INSERT INTO tags (name, created_at, usage_count) VALUES (?, ?, 0) RETURNING *'
	).bind(name, now).first();
	
	if (!result) {
		throw new Error('Failed to create new tag');
	}
	
	return {
		id: result.id as number,
		name: result.name as string,
		createdAt: result.created_at as string,
		usageCount: result.usage_count as number
	};
}

async function updateSnippetTags(snippetId: string, tagIds: number[], env: Env): Promise<void> {
	const tagsJson = JSON.stringify(tagIds);
	
	// Update snippets table
	await env.CONTENT_DB.prepare(
		'UPDATE snippets SET tags = ? WHERE id = ?'
	).bind(tagsJson, snippetId).run();
	
	// Update junction table
	// First, remove existing relationships
	await env.CONTENT_DB.prepare(
		'DELETE FROM snippet_tags WHERE snippet_id = ?'
	).bind(snippetId).run();
	
	// Then insert new relationships
	for (const tagId of tagIds) {
		await env.CONTENT_DB.prepare(
			'INSERT OR IGNORE INTO snippet_tags (snippet_id, tag_id) VALUES (?, ?)'
		).bind(snippetId, tagId).run();
	}
}

async function updateTagUsageCounts(tagIds: number[], env: Env): Promise<void> {
	for (const tagId of tagIds) {
		await env.CONTENT_DB.prepare(
			'UPDATE tags SET usage_count = usage_count + 1 WHERE id = ?'
		).bind(tagId).run();
	}
}

async function initializeDatabase(db: D1Database): Promise<void> {
	// Execute each statement individually to avoid D1 parsing issues with comments
	const statements = [
		`CREATE TABLE IF NOT EXISTS snippets (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			author TEXT NOT NULL,
			chapter_index INTEGER NOT NULL,
			source_url TEXT NOT NULL,
			created_at TEXT NOT NULL,
			tags TEXT
		)`,
		
		`CREATE TABLE IF NOT EXISTS tags (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			created_at TEXT NOT NULL,
			usage_count INTEGER DEFAULT 0
		)`,
		
		`CREATE TABLE IF NOT EXISTS snippet_tags (
			snippet_id TEXT NOT NULL,
			tag_id INTEGER NOT NULL,
			PRIMARY KEY (snippet_id, tag_id),
			FOREIGN KEY (snippet_id) REFERENCES snippets(id) ON DELETE CASCADE,
			FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
		)`,
		
		`CREATE INDEX IF NOT EXISTS idx_snippets_title ON snippets(title)`,
		`CREATE INDEX IF NOT EXISTS idx_snippets_author ON snippets(author)`,
		`CREATE INDEX IF NOT EXISTS idx_snippets_created_at ON snippets(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_snippets_source_url ON snippets(source_url)`,
		`CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)`,
		`CREATE INDEX IF NOT EXISTS idx_snippet_tags_snippet_id ON snippet_tags(snippet_id)`,
		`CREATE INDEX IF NOT EXISTS idx_snippet_tags_tag_id ON snippet_tags(tag_id)`
	];

	// Execute each statement individually
	for (const statement of statements) {
		await db.prepare(statement).run();
	}
}

async function handleTagConsolidation(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		const body = await request.json() as { dryRun?: boolean };
		const isDryRun = body.dryRun || false;
		
		// Get all existing tags
		const allTags = await env.CONTENT_DB.prepare(
			'SELECT id, name, usage_count FROM tags ORDER BY usage_count DESC'
		).all();
		
		if (allTags.results.length === 0) {
			return new Response(JSON.stringify({
				success: true,
				message: 'No tags found to consolidate',
				consolidations: []
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		// Use AI to group similar tags
		const consolidationPlan = await generateConsolidationPlan(allTags.results as unknown as Tag[], env.AI);
		
		let consolidationsPerformed = 0;
		const consolidationResults = [];
		
		if (!isDryRun) {
			// Execute the consolidation plan
			for (const group of consolidationPlan) {
				if (group.tags.length > 1) {
					const result = await consolidateTagGroup(group, env);
					consolidationsPerformed++;
					consolidationResults.push(result);
				}
			}
		}
		
		return new Response(JSON.stringify({
			success: true,
			dryRun: isDryRun,
			totalTags: allTags.results.length,
			consolidationGroups: consolidationPlan.length,
			consolidationsPerformed,
			consolidations: isDryRun ? consolidationPlan : consolidationResults
		}), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Consolidation error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

interface ConsolidationGroup {
	primaryTag: Tag;
	tags: Tag[];
	reason: string;
}

async function generateConsolidationPlan(tags: Tag[], ai: Ai): Promise<ConsolidationGroup[]> {
	const tagList = tags.map(tag => `${tag.id}:${tag.name} (使用了 ${tag.usageCount} 次)`).join('\n');
	
	const prompt = `分析这些内容标签，将相似的标签分组进行合并。重点关注语义相似性：

${tagList}

指示：
1. 将意思基本相同的标签分组
2. 对于每组，选择**最合适、最准确、最简洁**的标签名称作为主标签
3. 如果现有标签都不够好，可以建议一个更好的标签名称（2个中文字符）
4. 只将真正相似的标签分组 - 不要强制分组
5. 每组最多合并10个标签，优先合并最相似的
6. 为每个分组提供简短的理由（不超过15个字）

将你的回复格式化为JSON，确保JSON完整：
{
  "consolidations": [
    {
      "primary_tag_id": 1,
      "primary_tag_name": "激情",
      "merge_tag_ids": [5, 12],
      "reason": "都指向激烈情感表达"
    }
  ]
}

重要：
- 每组合并的标签数量不要超过10个
- 理由要简洁（不超过15个字）
- 确保JSON格式完整，不要截断

只包含有2个或更多标签的组。如果没有标签应该分组，返回空的consolidations数组。`;

	try {
		const response = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
			messages: [
				{
					role: 'user',
					content: prompt
				}
			],
			max_tokens: 1500 // Increased from 500 to handle larger responses
		}) as any;
		
		const result = response.response as string;
		
		// Parse AI response with improved error handling
		let aiPlan;
		try {
			// First, try to clean up the response and extract valid JSON
			const cleanedResult = result.trim();
			console.log('AI consolidation response:', cleanedResult);
			
			// Try multiple strategies to extract JSON
			let jsonString = '';
			
			// Strategy 1: Look for JSON between ```json and ``` tags
			const codeBlockMatch = cleanedResult.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
			if (codeBlockMatch) {
				jsonString = codeBlockMatch[1];
			} else {
				// Strategy 2: Look for the first complete JSON object
				const jsonMatch = cleanedResult.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					jsonString = jsonMatch[0];
				} else {
					throw new Error('No JSON structure found in response');
				}
			}
			
			// Check if the JSON appears to be truncated
			const lastChar = jsonString.trim().slice(-1);
			if (lastChar !== '}' && lastChar !== ']') {
				console.warn('JSON appears to be truncated, attempting to fix...');
				// Try to close the JSON structure
				const openBraces = (jsonString.match(/\{/g) || []).length;
				const closeBraces = (jsonString.match(/\}/g) || []).length;
				const openBrackets = (jsonString.match(/\[/g) || []).length;
				const closeBrackets = (jsonString.match(/\]/g) || []).length;
				
				// Add missing closing braces and brackets
				for (let i = 0; i < openBrackets - closeBrackets; i++) {
					jsonString += ']';
				}
				for (let i = 0; i < openBraces - closeBraces; i++) {
					jsonString += '}';
				}
				
				console.log('Attempted to fix truncated JSON:', jsonString);
			}
			
			// Clean up common AI response issues
			jsonString = jsonString
				.replace(/\/\/[^\n\r]*/g, '') // Remove // comments
				.replace(/\/\*[\s\S]*?\*\//g, '') // Remove /* */ comments
				.replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas before } or ]
				.replace(/,\s*$/, '') // Remove trailing comma at end
				.trim();
			
			console.log('Extracted JSON string:', jsonString);
			
			// Try to parse the cleaned JSON
			aiPlan = JSON.parse(jsonString);
			
			// Validate the structure
			if (!aiPlan || typeof aiPlan !== 'object') {
				throw new Error('Invalid JSON structure: not an object');
			}
			
			if (!Array.isArray(aiPlan.consolidations)) {
				console.log('No consolidations array found, treating as empty plan');
				aiPlan = { consolidations: [] };
			}
			
		} catch (parseError) {
			console.error('Failed to parse AI consolidation plan:', parseError);
			console.error('Raw AI response:', result);
			return []; // Return empty plan if parsing fails
		}
		
		// Convert AI plan to our format
		const consolidationGroups: ConsolidationGroup[] = [];
		const tagMap = new Map(tags.map(tag => [tag.id, tag]));
		
		for (const consolidation of aiPlan.consolidations || []) {
			// Validate consolidation structure
			if (!consolidation || 
				typeof consolidation.primary_tag_id !== 'number' || 
				!Array.isArray(consolidation.merge_tag_ids) ||
				consolidation.merge_tag_ids.length === 0) {
				console.warn('Invalid consolidation structure:', consolidation);
				continue;
			}
			
			const primaryTag = tagMap.get(consolidation.primary_tag_id);
			const mergeTags = consolidation.merge_tag_ids
				.map((id: number) => tagMap.get(id))
				.filter(Boolean)
				.filter((tag: any) => tag && tag.id && typeof tag.id === 'number'); // Ensure valid tag objects
			
			// Validate that we have valid tags
			if (!primaryTag || !primaryTag.id || typeof primaryTag.id !== 'number') {
				console.warn('Invalid primary tag:', primaryTag, 'for consolidation:', consolidation);
				continue;
			}
			
			if (mergeTags.length === 0) {
				console.warn('No valid merge tags found for consolidation:', consolidation);
				continue;
			}
			
			// Use the AI-suggested name if provided and different from current
			const suggestedName = consolidation.primary_tag_name;
			const finalPrimaryTag = suggestedName && suggestedName !== primaryTag.name 
				? { ...primaryTag, name: suggestedName, isRenamed: true } 
				: primaryTag;
			
			// Ensure all tags have required properties
			const allTags = [finalPrimaryTag, ...mergeTags];
			const validatedTags: Tag[] = [];
			
			for (const tag of allTags) {
				if (tag && 
					tag.id !== undefined && 
					typeof tag.id === 'number' &&
					tag.name !== undefined &&
					typeof tag.usageCount === 'number') {
					validatedTags.push(tag);
				}
			}
			
			if (validatedTags.length >= 2) { // At least primary + 1 merge tag
				consolidationGroups.push({
					primaryTag: finalPrimaryTag as Tag,
					tags: validatedTags,
					reason: consolidation.reason || 'No reason provided'
				});
			} else {
				console.warn('Not enough valid tags for consolidation group:', consolidation);
			}
		}
		
		return consolidationGroups;
		
	} catch (error) {
		console.error('Error generating consolidation plan:', error);
		return [];
	}
}

interface ConsolidationResult {
	primaryTag: Tag;
	mergedTags: Tag[];
	snippetsUpdated: number;
	reason: string;
}

async function consolidateTagGroup(group: ConsolidationGroup, env: Env): Promise<ConsolidationResult> {
	const primaryTag = group.primaryTag;
	const tagsToMerge = group.tags.filter(tag => tag.id !== primaryTag.id);
	
	// Validate that we have valid tags
	if (!primaryTag || !primaryTag.id) {
		throw new Error('Invalid primary tag: missing id');
	}
	
	let totalSnippetsUpdated = 0;
	
	// First, check if we need to rename the primary tag
	const isRenamed = (primaryTag as any).isRenamed;
	if (isRenamed) {
		// Clean the suggested name
		const cleanedName = cleanTag(primaryTag.name);
		if (cleanedName.length > 0 && cleanedName.length <= 4 && isValidChineseTag(cleanedName)) {
			// Update the primary tag's name in the database
			await env.CONTENT_DB.prepare(
				'UPDATE tags SET name = ? WHERE id = ?'
			).bind(cleanedName, primaryTag.id).run();
			console.log(`Renamed tag ${primaryTag.id} from original name to: ${cleanedName}`);
		}
	}
	
	// Update all snippets that use the tags to be merged
	for (const tagToMerge of tagsToMerge) {
		// Validate tag before processing
		if (!tagToMerge || !tagToMerge.id) {
			console.error('Invalid tag to merge: missing id', tagToMerge);
			continue;
		}
		
		// Get all snippets using this tag
		const snippetsWithTag = await env.CONTENT_DB.prepare(
			'SELECT snippet_id FROM snippet_tags WHERE tag_id = ?'
		).bind(tagToMerge.id).all();
		
		for (const snippetRow of snippetsWithTag.results) {
			const snippetId = (snippetRow as any).snippet_id;
			
			// Validate snippet ID
			if (!snippetId) {
				console.error('Invalid snippet ID found:', snippetRow);
				continue;
			}
			
			// Remove old tag relationship
			await env.CONTENT_DB.prepare(
				'DELETE FROM snippet_tags WHERE snippet_id = ? AND tag_id = ?'
			).bind(snippetId, tagToMerge.id).run();
			
			// Add new tag relationship (if not already exists)
			await env.CONTENT_DB.prepare(
				'INSERT OR IGNORE INTO snippet_tags (snippet_id, tag_id) VALUES (?, ?)'
			).bind(snippetId, primaryTag.id).run();
			
			// Update the tags JSON in snippets table
			const snippet = await env.CONTENT_DB.prepare(
				'SELECT tags FROM snippets WHERE id = ?'
			).bind(snippetId).first();
			
			if (snippet && snippet.tags) {
				try {
					const tagIds = JSON.parse(snippet.tags as string);
					const updatedTagIds = tagIds
						.filter((id: number) => id !== tagToMerge.id) // Remove old tag
						.concat(tagIds.includes(primaryTag.id) ? [] : [primaryTag.id]); // Add primary tag if not present
					
					await env.CONTENT_DB.prepare(
						'UPDATE snippets SET tags = ? WHERE id = ?'
					).bind(JSON.stringify(updatedTagIds), snippetId).run();
					
					totalSnippetsUpdated++;
				} catch (error) {
					console.error(`Error updating tags for snippet ${snippetId}:`, error);
				}
			}
		}
		
		// Update primary tag usage count - validate usageCount first
		const usageCountToAdd = (tagToMerge.usageCount || 0);
		if (usageCountToAdd > 0) {
			await env.CONTENT_DB.prepare(
				'UPDATE tags SET usage_count = usage_count + ? WHERE id = ?'
			).bind(usageCountToAdd, primaryTag.id).run();
		}
		
		// Delete the merged tag
		await env.CONTENT_DB.prepare(
			'DELETE FROM tags WHERE id = ?'
		).bind(tagToMerge.id).run();
	}
	
	return {
		primaryTag,
		mergedTags: tagsToMerge,
		snippetsUpdated: totalSnippetsUpdated,
		reason: group.reason || 'No reason provided'
	};
}

async function handleClearTags(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		const body = await request.json() as { confirm?: boolean };
		
		if (!body.confirm) {
			return new Response(JSON.stringify({
				success: false,
				error: 'You must set confirm: true in the request body to clear all tags'
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		await initializeDatabase(env.CONTENT_DB);
		
		// Get counts before clearing
		const [snippetsResult, tagsResult, taggedResult] = await Promise.all([
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM snippets').first(),
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM tags').first(),
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM snippets WHERE tags IS NOT NULL AND tags != "[]"').first()
		]);
		
		const totalSnippets = (snippetsResult?.count as number) || 0;
		const totalTags = (tagsResult?.count as number) || 0;
		const taggedSnippets = (taggedResult?.count as number) || 0;
		
		// Clear all tag-related data
		await env.CONTENT_DB.prepare('DELETE FROM snippet_tags').run();
		await env.CONTENT_DB.prepare('DELETE FROM tags').run();
		await env.CONTENT_DB.prepare('UPDATE snippets SET tags = NULL').run();
		
		return new Response(JSON.stringify({
			success: true,
			message: 'All tags cleared successfully',
			cleared: {
				totalTags,
				taggedSnippets,
				totalSnippets
			}
		}), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Error clearing tags:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleQueueStatus(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'GET') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		// Get queue statistics and database status
		const [snippetsResult, tagsResult, taggedResult, untaggedResult] = await Promise.all([
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM snippets').first(),
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM tags').first(),
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM snippets WHERE tags IS NOT NULL AND tags != "[]"').first(),
			env.CONTENT_DB.prepare('SELECT COUNT(*) as count FROM snippets WHERE (tags IS NULL OR tags = "[]")').first()
		]);
		
		const totalSnippets = (snippetsResult?.count as number) || 0;
		const totalTags = (tagsResult?.count as number) || 0;
		const taggedSnippets = (taggedResult?.count as number) || 0;
		const untaggedSnippets = (untaggedResult?.count as number) || 0;
		
		// Calculate processing progress
		const processingProgress = totalSnippets > 0 ? (taggedSnippets / totalSnippets * 100).toFixed(1) : '0.0';
		
		// Get Durable Object progress
		let doProgress = null;
		try {
			const doId = env.QUEUE_MANAGER.idFromName("snippet-queue-manager");
			const doStub = env.QUEUE_MANAGER.get(doId);
			doProgress = await doStub.getProgress();
		} catch (error) {
			console.error('Error getting DO progress:', error);
		}
		
		const response = {
			database: {
				totalSnippets,
				taggedSnippets,
				untaggedSnippets,
				totalTags,
				processingProgress: `${processingProgress}%`
			},
			queue: {
				isConfigured: !!env.TAGGING_QUEUE,
				pendingSnippets: untaggedSnippets,
				processingMode: 'queue-based',
				consumerSettings: {
					maxBatchSize: 5,
					maxBatchTimeout: '15 seconds',
					maxRetries: 5,
					retryDelay: '30 seconds'
				}
			},
			durableObject: doProgress,
			status: untaggedSnippets > 0 ? 'processing' : 'idle',
			recommendations: untaggedSnippets > 0 ? [
				'Run POST /tag-queue/retry to retry queuing remaining snippets',
				'Check dead letter queue in Cloudflare dashboard for failed messages',
				'Verify queue consumers are processing messages'
			] : [],
			timestamp: new Date().toISOString()
		};
		
		return new Response(JSON.stringify(response, null, 2), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Queue status error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleQueueTagging(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		// Get the QueueManager Durable Object
		const doId = env.QUEUE_MANAGER.idFromName("snippet-queue-manager");
		const doStub = env.QUEUE_MANAGER.get(doId);
		
		// Start queuing via RPC method
		const result = await doStub.startQueuing();
		
		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Queue tagging error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleQueueProgress(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'GET') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		// Get the QueueManager Durable Object
		const doId = env.QUEUE_MANAGER.idFromName("snippet-queue-manager");
		const doStub = env.QUEUE_MANAGER.get(doId);
		
		// Get progress via RPC method
		const progress = await doStub.getProgress();
		
		return new Response(JSON.stringify(progress), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Queue progress error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleQueueStop(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		// Get the QueueManager Durable Object
		const doId = env.QUEUE_MANAGER.idFromName("snippet-queue-manager");
		const doStub = env.QUEUE_MANAGER.get(doId);
		
		// Send stop signal via RPC method
		const result = await doStub.stop();
		
		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Queue stop error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleQueueRetry(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	
	try {
		// Get the QueueManager Durable Object
		const doId = env.QUEUE_MANAGER.idFromName("snippet-queue-manager");
		const doStub = env.QUEUE_MANAGER.get(doId);
		
		// Force retry queuing of remaining snippets
		const result = await doStub.retryQueuing();
		
		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' }
		});
		
	} catch (error) {
		console.error('Queue retry error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleChunkSizeConfig(request: Request, env: Env): Promise<Response> {
	try {
		// Get the QueueManager Durable Object
		const doId = env.QUEUE_MANAGER.idFromName("snippet-queue-manager");
		const doStub = env.QUEUE_MANAGER.get(doId);
		
		if (request.method === 'GET') {
			// Get current chunk size
			const chunkSize = await doStub.getChunkSize();
			return new Response(JSON.stringify({ chunkSize }), {
				headers: { 'Content-Type': 'application/json' }
			});
		} else if (request.method === 'POST') {
			// Set new chunk size
			const body = await request.json() as { chunkSize: number };
			const result = await doStub.setChunkSize(body.chunkSize);
			return new Response(JSON.stringify(result), {
				headers: { 'Content-Type': 'application/json' }
			});
		} else {
			return new Response('Method not allowed', { status: 405 });
		}
		
	} catch (error) {
		console.error('Chunk size config error:', error);
		return new Response(JSON.stringify({
			success: false,
			error: error instanceof Error ? error.message : String(error)
		}), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

async function handleQueueBatch(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
	console.log(`Processing queue batch of ${batch.messages.length} messages`);
	
	await initializeDatabase(env.CONTENT_DB);
	
	// Process messages with rate limiting (reduced to 1 to prevent AI capacity exceeded errors)
	const CONCURRENT_LIMIT = 1;
	const chunks = chunkArray([...batch.messages], CONCURRENT_LIMIT);
	
	for (const chunk of chunks) {
		await Promise.all(chunk.map(async (message) => {
			try {
				const messageData = message.body as QueueMessage;
				console.log(`Processing snippet: ${messageData.snippetId}`);
				
				// Process the snippet with AI tagging
				const stats: TaggingStats = {
					processedSnippets: 0,
					newTagsCreated: 0,
					existingTagsUsed: 0,
					totalTags: 0,
					errors: []
				};
				
				await processSnippet(messageData.snippetId, env, stats);
				
				// Acknowledge successful processing
				message.ack();
				console.log(`Successfully processed snippet: ${messageData.snippetId}`);
				
			} catch (error) {
				console.error(`Failed to process message ${message.id}:`, error);
				
				// Handle different types of errors
				if (error instanceof Error) {
					if (error.message.includes('3040') || 
					    error.message.includes('Capacity temporarily exceeded')) {
						// AI capacity exceeded error - retry with exponential backoff
						const retryCount = message.attempts || 1;
						const backoffDelay = Math.min(300, 30 * Math.pow(2, retryCount - 1)); // Max 5 minutes
						console.log(`AI capacity exceeded for snippet ${(message.body as QueueMessage).snippetId}, retrying with ${backoffDelay}s delay (attempt ${retryCount})`);
						message.retry({ delaySeconds: backoffDelay });
					} else if (error.message.includes('Too many API requests') || 
					    error.message.includes('rate limit') ||
					    error.message.includes('429')) {
						// Rate limit error - retry with delay
						console.log(`Rate limit hit for snippet ${(message.body as QueueMessage).snippetId}, retrying with delay`);
						message.retry({ delaySeconds: 60 });
					} else if (error.message.includes('timeout') || 
							   error.message.includes('network') ||
							   error.message.includes('503')) {
						// Temporary error - standard retry
						console.log(`Temporary error for snippet ${(message.body as QueueMessage).snippetId}, retrying`);
						message.retry();
					} else if (error.message.includes('not found')) {
						// Snippet not found - skip this message
						console.log(`Snippet ${(message.body as QueueMessage).snippetId} not found, skipping`);
						message.ack();
					} else {
						// Other errors - retry with standard delay
						message.retry();
					}
				} else {
					// Unknown error - retry
					message.retry();
				}
			}
		}));
		
		// Add delay between chunks to prevent overwhelming the AI API
		if (chunks.indexOf(chunk) < chunks.length - 1) {
			await new Promise(resolve => setTimeout(resolve, 2000)); // Increased to 2 seconds
		}
	}
}

function chunkArray<T>(array: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}

// Durable Object for managing queue operations
export class QueueManager extends DurableObject {
	env: Env;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.env = env;
	}

	// Configuration constants
	private static readonly DEFAULT_CHUNK_SIZE = 50;
	private static readonly CHUNK_DELAY_MS = 1000; // 1 second between chunks

	// Alarm handler for chunked processing
	async alarm(): Promise<void> {
		console.log('QueueManager: Alarm triggered, continuing chunked processing');
		await this.processNextChunk();
	}

	// RPC Methods (recommended approach)
	async startQueuing(): Promise<{ success: boolean; message: string; note?: string; progress?: QueueProgress }> {
		const currentProgress = await this.ctx.storage.get<QueueProgress>('progress');
		
		if (currentProgress && currentProgress.status === 'processing') {
			return {
				success: false,
				message: 'Queue processing already in progress',
				progress: currentProgress
			};
		}

		// Start the background processing
		this.startBackgroundQueuing();

		return {
			success: true,
			message: 'Started queuing all untagged snippets in background',
			note: 'Use getProgress() to check status'
		};
	}

	async getProgress(): Promise<QueueProgress> {
		return await this.ctx.storage.get<QueueProgress>('progress') || {
			total: 0,
			queued: 0,
			failed: 0,
			status: 'idle',
			chunkSize: QueueManager.DEFAULT_CHUNK_SIZE,
			currentChunk: 0,
			totalChunks: 0,
			processedChunks: 0
		};
	}

	async stop(): Promise<{ success: boolean; message: string }> {
		await this.ctx.storage.put('shouldStop', true);
		
		return {
			success: true,
			message: 'Stop signal sent. Processing will halt after current batch.'
		};
	}

	async retryQueuing(): Promise<{ success: boolean; message: string; progress?: QueueProgress }> {
		const currentProgress = await this.ctx.storage.get<QueueProgress>('progress');
		
		if (currentProgress && currentProgress.status === 'processing') {
			return {
				success: false,
				message: 'Queue processing already in progress',
				progress: currentProgress
			};
		}

		// Reset the progress and start again
		await this.ctx.storage.put('shouldStop', false);
		
		// Start the background processing
		this.startBackgroundQueuing();

		return {
			success: true,
			message: 'Restarted queuing process for remaining untagged snippets'
		};
	}

	async setChunkSize(chunkSize: number): Promise<{ success: boolean; message: string }> {
		if (chunkSize < 1 || chunkSize > 200) {
			return {
				success: false,
				message: 'Chunk size must be between 1 and 200'
			};
		}

		const progress = await this.ctx.storage.get<QueueProgress>('progress');
		if (progress && progress.status === 'processing') {
			return {
				success: false,
				message: 'Cannot change chunk size while processing is active'
			};
		}

		await this.ctx.storage.put('chunkSize', chunkSize);
		
		return {
			success: true,
			message: `Chunk size set to ${chunkSize}`
		};
	}

	async getChunkSize(): Promise<number> {
		const chunkSize = await this.ctx.storage.get<number>('chunkSize');
		return chunkSize || QueueManager.DEFAULT_CHUNK_SIZE;
	}

	// Legacy fetch handler (kept for compatibility)
	async fetch(request: Request): Promise<Response> {
		return new Response('QueueManager DO - Use RPC methods: startQueuing(), getProgress(), stop()');
	}


	private async startBackgroundQueuing(): Promise<void> {
		try {
			await initializeDatabase(this.env.CONTENT_DB);

			if (!this.env.TAGGING_QUEUE) {
				throw new Error('TAGGING_QUEUE not configured');
			}

			// Get total count of untagged snippets for initialization
			const countResult = await this.env.CONTENT_DB.prepare(
				'SELECT COUNT(*) as count FROM snippets WHERE (tags IS NULL OR tags = "[]")'
			).first() as { count: number };

			const totalCount = countResult.count;

			if (totalCount === 0) {
				const progress: QueueProgress = {
					total: 0,
					queued: 0,
					failed: 0,
					status: 'completed',
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					chunkSize: QueueManager.DEFAULT_CHUNK_SIZE,
					currentChunk: 0,
					totalChunks: 0,
					processedChunks: 0
				};
				await this.ctx.storage.put('progress', progress);
				return;
			}

			// Initialize chunked progress
			const chunkSize = await this.getChunkSize();
			const totalChunks = Math.ceil(totalCount / chunkSize);

			const progress: QueueProgress = {
				total: totalCount,
				queued: 0,
				failed: 0,
				status: 'processing',
				startedAt: new Date().toISOString(),
				chunkSize: chunkSize,
				currentChunk: 1,
				totalChunks: totalChunks,
				processedChunks: 0
			};

			await this.ctx.storage.put('progress', progress);
			await this.ctx.storage.put('shouldStop', false);

			console.log(`QueueManager: Starting chunked queuing for ${totalCount} snippets (${totalChunks} chunks of ${chunkSize})`);

			// Process first chunk immediately
			await this.processNextChunk();

		} catch (error) {
			console.error('QueueManager: Error during background queuing initialization:', error);
			
			const progress: QueueProgress = {
				total: 0,
				queued: 0,
				failed: 0,
				status: 'error',
				startedAt: new Date().toISOString(),
				errorMessage: error instanceof Error ? error.message : String(error),
				chunkSize: QueueManager.DEFAULT_CHUNK_SIZE,
				currentChunk: 0,
				totalChunks: 0,
				processedChunks: 0
			};
			
			await this.ctx.storage.put('progress', progress);
		}
	}

	private async processNextChunk(): Promise<void> {
		try {
			const progress = await this.ctx.storage.get<QueueProgress>('progress');
			if (!progress || progress.status !== 'processing') {
				console.log('QueueManager: No active processing to continue');
				return;
			}

			// Check if we should stop
			const shouldStop = await this.ctx.storage.get<boolean>('shouldStop');
			if (shouldStop) {
				progress.status = 'idle';
				progress.errorMessage = 'Stopped by user request';
				await this.ctx.storage.put('progress', progress);
				return;
			}

			// Check if we're done
			if (progress.processedChunks >= progress.totalChunks) {
				progress.status = 'completed';
				progress.completedAt = new Date().toISOString();
				await this.ctx.storage.put('progress', progress);
				console.log(`QueueManager: Completed all chunks. Success: ${progress.queued}, Failed: ${progress.failed}`);
				return;
			}

			// Get next chunk of untagged snippets
			const offset = progress.processedChunks * progress.chunkSize;
			const query = progress.resumeFromId ? 
				'SELECT id FROM snippets WHERE (tags IS NULL OR tags = "[]") AND id > ? ORDER BY id LIMIT ?' :
				'SELECT id FROM snippets WHERE (tags IS NULL OR tags = "[]") ORDER BY id LIMIT ? OFFSET ?';
			
			const params = progress.resumeFromId ? 
				[progress.resumeFromId, progress.chunkSize] :
				[progress.chunkSize, offset];

			const snippetResults = await this.env.CONTENT_DB.prepare(query).bind(...params).all();
			const snippetIds = snippetResults.results as unknown as { id: string }[];

			if (snippetIds.length === 0) {
				// No more snippets to process
				progress.status = 'completed';
				progress.completedAt = new Date().toISOString();
				await this.ctx.storage.put('progress', progress);
				console.log(`QueueManager: No more snippets to process. Completed.`);
				return;
			}

			console.log(`QueueManager: Processing chunk ${progress.processedChunks + 1}/${progress.totalChunks} (${snippetIds.length} snippets)`);

			const timestamp = Date.now();
			let chunkQueued = 0;
			let chunkFailed = 0;

			// Process snippets in current chunk
			for (const snippet of snippetIds) {
				try {
					await this.env.TAGGING_QUEUE.send({
						snippetId: snippet.id,
						timestamp: timestamp,
						priority: 'medium'
					});
					chunkQueued++;
					progress.lastProcessedId = snippet.id;
					progress.resumeFromId = snippet.id;
				} catch (error) {
					console.error(`QueueManager: Failed to queue snippet ${snippet.id}:`, error);
					chunkFailed++;
				}
			}

			// Update progress
			progress.queued += chunkQueued;
			progress.failed += chunkFailed;
			progress.processedChunks++;
			progress.currentChunk = progress.processedChunks + 1;

			await this.ctx.storage.put('progress', progress);

			console.log(`QueueManager: Chunk completed. Queued: ${chunkQueued}, Failed: ${chunkFailed}. Total progress: ${progress.processedChunks}/${progress.totalChunks}`);

			// Schedule next chunk if not completed
			if (progress.processedChunks < progress.totalChunks) {
				const nextAlarmTime = Date.now() + QueueManager.CHUNK_DELAY_MS;
				await this.ctx.storage.setAlarm(nextAlarmTime);
				console.log(`QueueManager: Scheduled next chunk in ${QueueManager.CHUNK_DELAY_MS}ms`);
			} else {
				progress.status = 'completed';
				progress.completedAt = new Date().toISOString();
				await this.ctx.storage.put('progress', progress);
				console.log(`QueueManager: All chunks completed. Total: Success: ${progress.queued}, Failed: ${progress.failed}`);
			}

		} catch (error) {
			console.error('QueueManager: Error during chunk processing:', error);
			
			const progress = await this.ctx.storage.get<QueueProgress>('progress') || {
				total: 0,
				queued: 0,
				failed: 0,
				status: 'error' as const,
				startedAt: new Date().toISOString(),
				chunkSize: QueueManager.DEFAULT_CHUNK_SIZE,
				currentChunk: 0,
				totalChunks: 0,
				processedChunks: 0
			};
			
			progress.status = 'error';
			progress.errorMessage = error instanceof Error ? error.message : String(error);
			
			await this.ctx.storage.put('progress', progress);
		}
	}
}
