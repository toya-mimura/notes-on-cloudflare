/**
 * Cloudflare Blog System - Main Worker
 */

// ============================================================================
// Constants
// ============================================================================

const BLOCKED_BOTS = [
  'GPTBot',
  'CCBot',
  'anthropic-ai',
  'Claude-Web',
  'ChatGPT-User',
  'cohere-ai',
  'Google-Extended',
  'FacebookBot',
  'Bytespider'
];

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * 投稿IDを生成（タイムスタンプベース）
 * 形式: yyyymmddhhmmss
 */
function generatePostId() {
  const now = new Date();

  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');

  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * 衝突チェック付きID生成
 */
async function generateUniquePostId(db) {
  let postId = generatePostId();

  const existing = await db.prepare(
    'SELECT id FROM posts WHERE id = ?'
  ).bind(postId).first();

  if (existing) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return generateUniquePostId(db);
  }

  return postId;
}

/**
 * IPアドレスのハッシュを生成
 */
async function hashIP(ip) {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ブロック対象のボットかチェック
 */
function isBlockedBot(userAgent) {
  if (!userAgent) return false;
  return BLOCKED_BOTS.some(bot =>
    userAgent.toLowerCase().includes(bot.toLowerCase())
  );
}

/**
 * Rate Limitingチェック
 */
async function checkRateLimit(ip, env) {
  if (!env.RATE_LIMIT_KV) return true; // KVがない場合はスキップ

  const key = `ratelimit:${ip}`;
  const count = await env.RATE_LIMIT_KV.get(key);

  if (count && parseInt(count) > 100) {
    return false;
  }

  const newCount = count ? parseInt(count) + 1 : 1;
  await env.RATE_LIMIT_KV.put(key, newCount.toString(), { expirationTtl: 3600 });

  return true;
}

/**
 * CORS ヘッダーを生成
 */
function corsHeaders(origin, env) {
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:8787'];

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

/**
 * JSON レスポンスを生成
 */
function jsonResponse(data, status = 200, additionalHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...additionalHeaders
    }
  });
}

/**
 * HTML レスポンスを生成
 */
function htmlResponse(html, status = 200, additionalHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...additionalHeaders
    }
  });
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * robots.txt ハンドラー
 */
function handleRobotsTxt() {
  const robotsTxt = `
User-agent: GPTBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: Claude-Web
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: cohere-ai
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Googlebot
Crawl-delay: 10
Allow: /

User-agent: Bingbot
Crawl-delay: 10
Allow: /

User-agent: *
Crawl-delay: 10
Allow: /
  `.trim();

  return new Response(robotsTxt, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

/**
 * CORS Preflight ハンドラー
 */
function handleCORS(request, env) {
  const origin = request.headers.get('Origin');
  return new Response(null, {
    headers: corsHeaders(origin, env)
  });
}

/**
 * API ハンドラー
 */
async function handleAPI(request, env, pathname) {
  const method = request.method;

  // GET /api/posts - 投稿一覧取得
  if (pathname === '/api/posts' && method === 'GET') {
    return handleGetPosts(request, env);
  }

  // GET /api/posts/:id - 個別投稿取得
  if (pathname.match(/^\/api\/posts\/[^/]+$/) && method === 'GET') {
    const postId = pathname.split('/')[3];
    return handleGetPost(env, postId);
  }

  // POST /api/posts - 新規投稿
  if (pathname === '/api/posts' && method === 'POST') {
    return handleCreatePost(request, env);
  }

  // PUT /api/posts/:id - 投稿編集
  if (pathname.match(/^\/api\/posts\/[^/]+$/) && method === 'PUT') {
    const postId = pathname.split('/')[3];
    return handleUpdatePost(request, env, postId);
  }

  // DELETE /api/posts/:id - 投稿削除
  if (pathname.match(/^\/api\/posts\/[^/]+$/) && method === 'DELETE') {
    const postId = pathname.split('/')[3];
    return handleDeletePost(request, env, postId);
  }

  // GET /api/tags - タグ一覧取得
  if (pathname === '/api/tags' && method === 'GET') {
    return handleGetTags(env);
  }

  // POST /api/like/:postId - いいね追加
  if (pathname.match(/^\/api\/like\/[^/]+$/) && method === 'POST') {
    const postId = pathname.split('/')[3];
    return handleLike(request, env, postId);
  }

  // GET /api/likes/:postId - いいね数取得
  if (pathname.match(/^\/api\/likes\/[^/]+$/) && method === 'GET') {
    const postId = pathname.split('/')[3];
    return handleGetLikes(request, env, postId);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

/**
 * GET /api/posts - 投稿一覧取得
 */
async function handleGetPosts(request, env) {
  const url = new URL(request.url);
  const tag = url.searchParams.get('tag');
  const pinned = url.searchParams.get('pinned');
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    let query = 'SELECT * FROM posts';
    let bindings = [];

    if (pinned === 'true') {
      query += ' WHERE is_pinned = 1';
    }

    if (tag) {
      query = `
        SELECT p.* FROM posts p
        JOIN post_tags pt ON p.id = pt.post_id
        JOIN tags t ON pt.tag_id = t.id
        WHERE t.name = ?
      `;
      bindings.push(tag);

      if (pinned === 'true') {
        query += ' AND p.is_pinned = 1';
      }
    }

    query += ' ORDER BY is_pinned DESC, created_at DESC LIMIT ? OFFSET ?';
    bindings.push(limit, offset);

    const stmt = env.DB.prepare(query).bind(...bindings);
    const { results } = await stmt.all();

    // 各投稿のタグといいね数を取得
    for (let post of results) {
      // タグを取得
      const tagsStmt = env.DB.prepare(`
        SELECT t.name FROM tags t
        JOIN post_tags pt ON t.id = pt.tag_id
        WHERE pt.post_id = ?
      `).bind(post.id);
      const { results: tags } = await tagsStmt.all();
      post.tags = tags.map(t => t.name);

      // いいね数を取得
      const likesStmt = env.DB.prepare(
        'SELECT COUNT(*) as count FROM likes WHERE post_id = ?'
      ).bind(post.id);
      const likesResult = await likesStmt.first();
      post.likes = likesResult.count;
    }

    return jsonResponse({ posts: results });
  } catch (error) {
    console.error('Error fetching posts:', error);
    return jsonResponse({ error: 'Failed to fetch posts' }, 500);
  }
}

/**
 * GET /api/posts/:id - 個別投稿取得
 */
async function handleGetPost(env, postId) {
  try {
    const post = await env.DB.prepare(
      'SELECT * FROM posts WHERE id = ?'
    ).bind(postId).first();

    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }

    // タグを取得
    const tagsStmt = env.DB.prepare(`
      SELECT t.name FROM tags t
      JOIN post_tags pt ON t.id = pt.tag_id
      WHERE pt.post_id = ?
    `).bind(postId);
    const { results: tags } = await tagsStmt.all();
    post.tags = tags.map(t => t.name);

    // いいね数を取得
    const likesStmt = env.DB.prepare(
      'SELECT COUNT(*) as count FROM likes WHERE post_id = ?'
    ).bind(postId);
    const likesResult = await likesStmt.first();
    post.likes = likesResult.count;

    return jsonResponse({ post });
  } catch (error) {
    console.error('Error fetching post:', error);
    return jsonResponse({ error: 'Failed to fetch post' }, 500);
  }
}

/**
 * POST /api/posts - 新規投稿
 */
async function handleCreatePost(request, env) {
  // TODO: 認証チェックを実装

  try {
    const body = await request.json();
    const { content, image_url, image_sensitive, tags, is_pinned } = body;

    if (!content) {
      return jsonResponse({ error: 'Content is required' }, 400);
    }

    const postId = await generateUniquePostId(env.DB);

    // 投稿を作成
    await env.DB.prepare(
      'INSERT INTO posts (id, content, image_url, image_sensitive, is_pinned) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      postId,
      content,
      image_url || null,
      image_sensitive ? 1 : 0,
      is_pinned ? 1 : 0
    ).run();

    // タグを処理
    if (tags && tags.length > 0) {
      for (const tagName of tags) {
        // タグが存在するか確認
        let tag = await env.DB.prepare(
          'SELECT id FROM tags WHERE name = ?'
        ).bind(tagName).first();

        // タグが存在しない場合は作成
        if (!tag) {
          const insertResult = await env.DB.prepare(
            'INSERT INTO tags (name) VALUES (?)'
          ).bind(tagName).run();
          tag = { id: insertResult.meta.last_row_id };
        }

        // 投稿とタグを関連付け
        await env.DB.prepare(
          'INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)'
        ).bind(postId, tag.id).run();
      }
    }

    return jsonResponse({
      success: true,
      post: {
        id: postId,
        url: `/post/${postId}`,
        created_at: new Date().toISOString()
      }
    }, 201);
  } catch (error) {
    console.error('Error creating post:', error);
    return jsonResponse({ error: 'Failed to create post' }, 500);
  }
}

/**
 * PUT /api/posts/:id - 投稿編集
 */
async function handleUpdatePost(request, env, postId) {
  // TODO: 認証チェックを実装

  try {
    const body = await request.json();
    const { content, image_url, image_sensitive, tags, is_pinned } = body;

    // 投稿の存在確認
    const existing = await env.DB.prepare(
      'SELECT id FROM posts WHERE id = ?'
    ).bind(postId).first();

    if (!existing) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }

    // 投稿を更新
    await env.DB.prepare(`
      UPDATE posts
      SET content = ?, image_url = ?, image_sensitive = ?, is_pinned = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      content,
      image_url || null,
      image_sensitive ? 1 : 0,
      is_pinned ? 1 : 0,
      postId
    ).run();

    // 既存のタグ関連を削除
    await env.DB.prepare(
      'DELETE FROM post_tags WHERE post_id = ?'
    ).bind(postId).run();

    // 新しいタグを処理
    if (tags && tags.length > 0) {
      for (const tagName of tags) {
        let tag = await env.DB.prepare(
          'SELECT id FROM tags WHERE name = ?'
        ).bind(tagName).first();

        if (!tag) {
          const insertResult = await env.DB.prepare(
            'INSERT INTO tags (name) VALUES (?)'
          ).bind(tagName).run();
          tag = { id: insertResult.meta.last_row_id };
        }

        await env.DB.prepare(
          'INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)'
        ).bind(postId, tag.id).run();
      }
    }

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error updating post:', error);
    return jsonResponse({ error: 'Failed to update post' }, 500);
  }
}

/**
 * DELETE /api/posts/:id - 投稿削除
 */
async function handleDeletePost(request, env, postId) {
  // TODO: 認証チェックを実装

  try {
    const result = await env.DB.prepare(
      'DELETE FROM posts WHERE id = ?'
    ).bind(postId).run();

    if (result.meta.changes === 0) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting post:', error);
    return jsonResponse({ error: 'Failed to delete post' }, 500);
  }
}

/**
 * GET /api/tags - タグ一覧取得
 */
async function handleGetTags(env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT t.id, t.name, COUNT(pt.post_id) as count
      FROM tags t
      LEFT JOIN post_tags pt ON t.id = pt.tag_id
      GROUP BY t.id, t.name
      ORDER BY count DESC, t.name ASC
    `).all();

    return jsonResponse({ tags: results });
  } catch (error) {
    console.error('Error fetching tags:', error);
    return jsonResponse({ error: 'Failed to fetch tags' }, 500);
  }
}

/**
 * POST /api/like/:postId - いいね追加
 */
async function handleLike(request, env, postId) {
  try {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipHash = await hashIP(ip);

    // 投稿の存在確認
    const post = await env.DB.prepare(
      'SELECT id FROM posts WHERE id = ?'
    ).bind(postId).first();

    if (!post) {
      return jsonResponse({ error: 'Post not found' }, 404);
    }

    // 既にいいねしているか確認
    const existing = await env.DB.prepare(
      'SELECT id FROM likes WHERE post_id = ? AND ip_hash = ?'
    ).bind(postId, ipHash).first();

    if (existing) {
      // 既にいいね済み - いいねを削除（トグル）
      await env.DB.prepare(
        'DELETE FROM likes WHERE post_id = ? AND ip_hash = ?'
      ).bind(postId, ipHash).run();
    } else {
      // いいねを追加
      await env.DB.prepare(
        'INSERT INTO likes (post_id, ip_hash) VALUES (?, ?)'
      ).bind(postId, ipHash).run();
    }

    // いいね数を取得
    const likesResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM likes WHERE post_id = ?'
    ).bind(postId).first();

    return jsonResponse({
      success: true,
      likes: likesResult.count,
      liked: !existing
    });
  } catch (error) {
    console.error('Error processing like:', error);
    return jsonResponse({ error: 'Failed to process like' }, 500);
  }
}

/**
 * GET /api/likes/:postId - いいね数取得
 */
async function handleGetLikes(request, env, postId) {
  try {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const ipHash = await hashIP(ip);

    // いいね数を取得
    const likesResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM likes WHERE post_id = ?'
    ).bind(postId).first();

    // 自分がいいねしているか確認
    const userLike = await env.DB.prepare(
      'SELECT id FROM likes WHERE post_id = ? AND ip_hash = ?'
    ).bind(postId, ipHash).first();

    return jsonResponse({
      likes: likesResult.count,
      liked: !!userLike
    });
  } catch (error) {
    console.error('Error fetching likes:', error);
    return jsonResponse({ error: 'Failed to fetch likes' }, 500);
  }
}

/**
 * トップページハンドラー
 */
async function handleIndexPage(env) {
  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${env.SITE_NAME || 'My Blog'}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
  <style>
    :root {
      --color-primary: #3965a0ff;
      --color-primary-dark: #0d668fff;
      --color-bg: #3d3b3bff;
      --color-bg-secondary: #181818ff;
      --color-text: #bcbeb2ff;
      --color-text-secondary: #666666;
      --color-text-muted: #999999;
      --color-border: #b4c5c9ff;
      --color-like: #687428ff;
      --color-tag: #721b31ff;
      --color-spoiler-bg: #686767ff;
      --color-spoiler-overlay: rgba(32, 32, 32, 0.8);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      color: var(--color-text);
      background-color: var(--color-bg);
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }

    /* ヘッダー */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 0;
      margin-bottom: 30px;
      border-bottom: 1px solid var(--color-border);
    }

    .logo {
      font-size: 24px;
      font-weight: 700;
      color: var(--color-text);
      text-decoration: none;
    }

    .login-btn {
      padding: 8px 16px;
      background-color: var(--color-primary);
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      text-decoration: none;
    }

    .login-btn:hover {
      background-color: var(--color-primary-dark);
    }

    /* タグナビゲーション */
    .tag-nav {
      display: flex;
      gap: 12px;
      margin-bottom: 30px;
      overflow-x: auto;
      padding-bottom: 10px;
    }

    .tag-nav::-webkit-scrollbar {
      height: 6px;
    }

    .tag-nav::-webkit-scrollbar-thumb {
      background-color: var(--color-border);
      border-radius: 3px;
    }

    .tag-item {
      padding: 6px 16px;
      background-color: var(--color-bg-secondary);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: 20px;
      text-decoration: none;
      white-space: nowrap;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .tag-item:hover, .tag-item.active {
      background-color: var(--color-tag);
      color: white;
      border-color: var(--color-tag);
    }

    /* 投稿カード */
    .post-card {
      background-color: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      transition: box-shadow 0.2s;
    }

    .post-card:hover {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .pinned-badge {
      display: inline-block;
      background-color: var(--color-primary);
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      margin-bottom: 12px;
    }

    .post-content {
      font-size: 18px;
      line-height: 1.7;
      margin-bottom: 16px;
      color: var(--color-text);
    }

    .post-content h1, .post-content h2, .post-content h3 {
      margin-top: 16px;
      margin-bottom: 8px;
      color: var(--color-text);
    }

    .post-content code {
      background-color: var(--color-spoiler-bg);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }

    .post-content pre {
      background-color: var(--color-spoiler-bg);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 12px 0;
    }

    .post-image-container {
      margin: 16px 0;
      position: relative;
    }

    .post-image {
      width: 100%;
      border-radius: 8px;
      max-height: 500px;
      object-fit: cover;
    }

    .spoiler-image {
      filter: blur(20px);
      cursor: pointer;
      transition: filter 0.3s;
    }

    .spoiler-image.revealed {
      filter: none;
    }

    .spoiler-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .spoiler-warning {
      background: var(--color-spoiler-overlay);
      color: white;
      padding: 20px 32px;
      border-radius: 12px;
      text-align: center;
    }

    .spoiler-image.revealed + .spoiler-overlay {
      display: none;
    }

    .post-tags {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .tag {
      color: var(--color-tag);
      text-decoration: none;
      font-size: 14px;
    }

    .tag:hover {
      text-decoration: underline;
    }

    .post-actions {
      display: flex;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
    }

    .like-btn, .share-btn {
      background: none;
      border: none;
      color: var(--color-text-secondary);
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      transition: all 0.2s;
    }

    .like-btn:hover, .share-btn:hover {
      background-color: var(--color-spoiler-bg);
      color: var(--color-text);
    }

    .like-btn.liked {
      color: var(--color-like);
    }

    .post-timestamp {
      font-size: 14px;
      color: var(--color-text-secondary);
      text-decoration: none;
    }

    .post-timestamp:hover {
      text-decoration: underline;
    }

    .read-more {
      color: var(--color-primary);
      text-decoration: none;
      font-weight: 500;
    }

    .read-more:hover {
      text-decoration: underline;
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
      pointer-events: none;
    }

    .toast.show {
      opacity: 1;
    }

    /* Loading */
    .loading {
      text-align: center;
      padding: 40px;
      color: var(--color-text-secondary);
    }

    /* spoiler text */
    .spoiler {
      background: #000;
      color: #000;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      transition: all 0.2s;
      position: relative;
    }

    .spoiler.revealed {
      background: transparent;
      color: inherit;
    }

    @media (max-width: 640px) {
      .container {
        padding: 12px;
      }

      .post-card {
        padding: 16px;
      }

      .post-content {
        font-size: 16px;
      }
    }
  </style>
</head>
<body>
  <div class="container" x-data="blogApp()">
    <!-- ヘッダー -->
    <header>
      <a href="/" class="logo" x-text="siteName"></a>
      <a href="/auth/google" class="login-btn">Login</a>
    </header>

    <!-- タグナビゲーション -->
    <div class="tag-nav">
      <span class="tag-item" :class="{ 'active': selectedTag === null }" @click="filterByTag(null)">すべて</span>
      <template x-for="tag in tags" :key="tag.id">
        <span class="tag-item" :class="{ 'active': selectedTag === tag.name }" @click="filterByTag(tag.name)" x-text="tag.name + ' (' + tag.count + ')'"></span>
      </template>
    </div>

    <!-- 投稿一覧 -->
    <div x-show="loading" class="loading">読み込み中...</div>

    <template x-for="post in filteredPosts" :key="post.id">
      <article class="post-card">
        <!-- 固定投稿バッジ -->
        <div x-show="post.is_pinned" class="pinned-badge">📌 固定投稿</div>

        <!-- 本文 -->
        <div class="post-content" x-html="renderMarkdown(post.content, post.id)"></div>

        <!-- 画像 -->
        <template x-if="post.image_url">
          <div class="post-image-container">
            <img
              :src="post.image_url"
              :class="post.image_sensitive ? 'post-image spoiler-image' : 'post-image'"
              :id="'img-' + post.id"
              @click="post.image_sensitive && revealImage('img-' + post.id)"
              alt="投稿画像"
            >
            <template x-if="post.image_sensitive">
              <div class="spoiler-overlay" :id="'overlay-' + post.id">
                <div class="spoiler-warning">
                  <p>⚠️ センシティブな内容</p>
                  <p style="font-size: 14px; margin-top: 8px; opacity: 0.8;">クリックで表示</p>
                </div>
              </div>
            </template>
          </div>
        </template>

        <!-- タグ -->
        <div class="post-tags" x-show="post.tags && post.tags.length > 0">
          <template x-for="tag in post.tags" :key="tag">
            <a href="#" class="tag" @click.prevent="filterByTag(tag)" x-text="'#' + tag"></a>
          </template>
        </div>

        <!-- アクション -->
        <div class="post-actions">
          <button
            class="like-btn"
            :class="{ 'liked': post.liked }"
            @click="toggleLike(post)"
          >
            <span x-text="post.liked ? '❤️' : '♡'"></span>
            <span x-text="post.likes || 0"></span>
          </button>

          <button class="share-btn" @click="sharePost(post.id)">
            🔗 共有
          </button>

          <a :href="'/post/' + post.id" class="post-timestamp" x-text="formatTimestamp(post.created_at)"></a>
        </div>
      </article>
    </template>
  </div>

  <!-- Toast -->
  <div id="toast" class="toast"></div>

  <script>
    function blogApp() {
      return {
        siteName: '${env.SITE_NAME || 'My Blog'}',
        posts: [],
        tags: [],
        selectedTag: null,
        loading: true,

        async init() {
          await this.loadTags();
          await this.loadPosts();
          this.loading = false;
        },

        async loadPosts() {
          try {
            const url = this.selectedTag
              ? '/api/posts?tag=' + encodeURIComponent(this.selectedTag)
              : '/api/posts';
            const response = await fetch(url);
            const data = await response.json();
            this.posts = data.posts || [];

            // いいね状態をローカルストレージから復元
            this.posts.forEach(post => {
              const liked = localStorage.getItem('liked_' + post.id) === 'true';
              post.liked = liked;
            });
          } catch (error) {
            console.error('Failed to load posts:', error);
          }
        },

        async loadTags() {
          try {
            const response = await fetch('/api/tags');
            const data = await response.json();
            this.tags = data.tags || [];
          } catch (error) {
            console.error('Failed to load tags:', error);
          }
        },

        async filterByTag(tagName) {
          this.selectedTag = tagName;
          this.loading = true;
          await this.loadPosts();
          this.loading = false;
        },

        get filteredPosts() {
          return this.posts;
        },

        async toggleLike(post) {
          try {
            const response = await fetch('/api/like/' + post.id, {
              method: 'POST'
            });
            const data = await response.json();

            if (data.success) {
              post.likes = data.likes;
              post.liked = data.liked;

              // ローカルストレージに保存
              localStorage.setItem('liked_' + post.id, data.liked);
            }
          } catch (error) {
            console.error('Failed to toggle like:', error);
          }
        },

        sharePost(postId) {
          const url = window.location.origin + '/post/' + postId;

          navigator.clipboard.writeText(url).then(() => {
            this.showToast('URLをコピーしました！');
          }).catch(() => {
            this.showToast('URLのコピーに失敗しました');
          });
        },

        showToast(message) {
          const toast = document.getElementById('toast');
          toast.textContent = message;
          toast.classList.add('show');

          setTimeout(() => {
            toast.classList.remove('show');
          }, 3000);
        },

        renderMarkdown(content, postId) {
          if (!content) return '';

          // marked.jsでMarkdownをHTMLに変換
          let html = marked.parse(content);

          // spoilerタグ（||text||）を処理
          html = html.replace(/\\|\\|([^|]+)\\|\\|/g,
            '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>'
          );

          return html;
        },

        formatTimestamp(timestamp) {
          if (!timestamp) return '';

          const date = new Date(timestamp);
          const now = new Date();
          const diffMs = now - date;
          const diffMins = Math.floor(diffMs / 60000);
          const diffHours = Math.floor(diffMs / 3600000);
          const diffDays = Math.floor(diffMs / 86400000);

          if (diffMins < 1) return 'たった今';
          if (diffMins < 60) return diffMins + '分前';
          if (diffHours < 24) return diffHours + '時間前';
          if (diffDays < 7) return diffDays + '日前';

          return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
        },

        revealImage(imgId) {
          const img = document.getElementById(imgId);
          if (img) {
            img.classList.add('revealed');
          }
        }
      }
    }
  </script>
</body>
</html>
  `;

  return htmlResponse(html);
}

/**
 * 個別投稿ページハンドラー
 */
async function handlePostPage(env, postId) {
  try {
    // 投稿を取得
    const post = await env.DB.prepare(
      'SELECT * FROM posts WHERE id = ?'
    ).bind(postId).first();

    if (!post) {
      return htmlResponse('<h1>投稿が見つかりません</h1>', 404);
    }

    // タグを取得
    const tagsStmt = env.DB.prepare(
      'SELECT t.name FROM tags t JOIN post_tags pt ON t.id = pt.tag_id WHERE pt.post_id = ?'
    ).bind(postId);
    const { results: tags } = await tagsStmt.all();
    post.tags = tags.map(t => t.name);

    // OGPメタタグ用のデータ
    const ogTitle = post.content.substring(0, 100).replace(/<[^>]*>/g, '');
    const ogDescription = post.content.substring(0, 200).replace(/<[^>]*>/g, '');
    const ogImage = post.image_url || '';
    const ogUrl = env.SITE_URL + '/post/' + postId;

    const html = \`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>\${ogTitle} - \${env.SITE_NAME || 'My Blog'}</title>

  <!-- OGP Meta Tags -->
  <meta property="og:title" content="\${ogTitle}">
  <meta property="og:description" content="\${ogDescription}">
  \${ogImage ? \`<meta property="og:image" content="\${ogImage}">\` : ''}
  <meta property="og:url" content="\${ogUrl}">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">

  <script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
  <style>
    /* Same CSS as index page */
    :root {
      --color-primary: #3965a0ff;
      --color-primary-dark: #0d668fff;
      --color-bg: #3d3b3bff;
      --color-bg-secondary: #181818ff;
      --color-text: #bcbeb2ff;
      --color-text-secondary: #666666;
      --color-border: #b4c5c9ff;
      --color-like: #687428ff;
      --color-tag: #721b31ff;
      --color-spoiler-bg: #686767ff;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      color: var(--color-text);
      background-color: var(--color-bg);
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }

    .back-btn {
      color: var(--color-primary);
      text-decoration: none;
      display: inline-block;
      margin-bottom: 20px;
      font-size: 16px;
    }

    .back-btn:hover {
      text-decoration: underline;
    }

    .post-content {
      font-size: 18px;
      line-height: 1.7;
      margin-bottom: 24px;
      color: var(--color-text);
    }

    .post-content h1, .post-content h2, .post-content h3 {
      margin-top: 24px;
      margin-bottom: 12px;
      color: var(--color-text);
    }

    .post-content code {
      background-color: var(--color-spoiler-bg);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }

    .post-content pre {
      background-color: var(--color-spoiler-bg);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 12px 0;
    }

    .post-image {
      width: 100%;
      border-radius: 8px;
      margin: 24px 0;
    }

    .post-tags {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .tag {
      color: var(--color-tag);
      text-decoration: none;
      font-size: 14px;
    }

    .tag:hover {
      text-decoration: underline;
    }

    .post-actions {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-bottom: 16px;
    }

    .like-btn, .share-btn {
      background: none;
      border: none;
      color: var(--color-text-secondary);
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      transition: all 0.2s;
    }

    .like-btn:hover, .share-btn:hover {
      background-color: var(--color-spoiler-bg);
      color: var(--color-text);
    }

    .like-btn.liked {
      color: var(--color-like);
    }

    .post-timestamp {
      font-size: 14px;
      color: var(--color-text-secondary);
    }

    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
    }

    .toast.show {
      opacity: 1;
    }

    .spoiler {
      background: #000;
      color: #000;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      transition: all 0.2s;
    }

    .spoiler.revealed {
      background: transparent;
      color: inherit;
    }
  </style>
</head>
<body>
  <div class="container" x-data="postPage()">
    <a href="/" class="back-btn">← 戻る</a>

    <article>
      <div class="post-content" x-html="renderMarkdown(post.content)"></div>

      <template x-if="post.image_url">
        <img :src="post.image_url" class="post-image" alt="投稿画像">
      </template>

      <div class="post-tags" x-show="post.tags && post.tags.length > 0">
        <template x-for="tag in post.tags" :key="tag">
          <a :href="'/?tag=' + encodeURIComponent(tag)" class="tag" x-text="'#' + tag"></a>
        </template>
      </div>

      <div class="post-actions">
        <button
          class="like-btn"
          :class="{ 'liked': liked }"
          @click="toggleLike()"
        >
          <span x-text="liked ? '❤️' : '♡'"></span>
          <span x-text="likes"></span>
        </button>

        <button class="share-btn" @click="sharePost()">
          🔗 共有
        </button>
      </div>

      <div class="post-timestamp" x-text="formatTimestamp(post.created_at)"></div>
    </article>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function postPage() {
      return {
        post: \${JSON.stringify(post)},
        likes: 0,
        liked: false,

        async init() {
          await this.loadLikes();
        },

        async loadLikes() {
          try {
            const response = await fetch('/api/likes/\${postId}');
            const data = await response.json();
            this.likes = data.likes;
            this.liked = data.liked;
          } catch (error) {
            console.error('Failed to load likes:', error);
          }
        },

        async toggleLike() {
          try {
            const response = await fetch('/api/like/\${postId}', {
              method: 'POST'
            });
            const data = await response.json();

            if (data.success) {
              this.likes = data.likes;
              this.liked = data.liked;
            }
          } catch (error) {
            console.error('Failed to toggle like:', error);
          }
        },

        sharePost() {
          const url = window.location.href;

          navigator.clipboard.writeText(url).then(() => {
            this.showToast('URLをコピーしました！');
          }).catch(() => {
            this.showToast('URLのコピーに失敗しました');
          });
        },

        showToast(message) {
          const toast = document.getElementById('toast');
          toast.textContent = message;
          toast.classList.add('show');

          setTimeout(() => {
            toast.classList.remove('show');
          }, 3000);
        },

        renderMarkdown(content) {
          if (!content) return '';

          let html = marked.parse(content);

          // spoilerタグ（||text||）を処理
          html = html.replace(/\\|\\|([^|]+)\\|\\|/g,
            '<span class="spoiler" onclick="this.classList.toggle(\\'revealed\\')">$1</span>'
          );

          return html;
        },

        formatTimestamp(timestamp) {
          if (!timestamp) return '';

          const date = new Date(timestamp);
          return date.getFullYear() + '年' +
                 (date.getMonth() + 1) + '月' +
                 date.getDate() + '日 ' +
                 date.getHours().toString().padStart(2, '0') + ':' +
                 date.getMinutes().toString().padStart(2, '0');
        }
      }
    }
  </script>
</body>
</html>
    \`;

    return htmlResponse(html);
  } catch (error) {
    console.error('Error rendering post page:', error);
    return htmlResponse('<h1>エラーが発生しました</h1>', 500);
  }
}

// ============================================================================
// Main Handler
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // robots.txt
    if (pathname === '/robots.txt') {
      return handleRobotsTxt();
    }

    // ボット対策
    const userAgent = request.headers.get('user-agent') || '';
    if (isBlockedBot(userAgent)) {
      return new Response('Access denied', { status: 403 });
    }

    // Rate Limiting
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const allowed = await checkRateLimit(ip, env);
    if (!allowed) {
      return new Response('Too many requests', {
        status: 429,
        headers: { 'Retry-After': '3600' }
      });
    }

    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    // API
    if (pathname.startsWith('/api/')) {
      const response = await handleAPI(request, env, pathname);
      const origin = request.headers.get('Origin');
      const cors = corsHeaders(origin, env);

      // Add CORS headers to response
      Object.entries(cors).forEach(([key, value]) => {
        response.headers.set(key, value);
      });

      return response;
    }

    // 個別投稿ページ
    if (pathname.startsWith('/post/')) {
      const postId = pathname.split('/')[2];
      return handlePostPage(env, postId);
    }

    // TODO: タグフィルタリング
    if (pathname.startsWith('/tag/')) {
      return htmlResponse('<h1>Tag page - Coming soon</h1>');
    }

    // トップページ
    if (pathname === '/' || pathname === '/index.html') {
      return handleIndexPage(env);
    }

    // 404
    return new Response('Not found', { status: 404 });
  }
};
