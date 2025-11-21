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

/**
 * セッションIDを生成
 */
async function generateSessionId() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * セッションを保存
 */
async function saveSession(env, sessionId, userData) {
  if (!env.SESSION_KV) return false;
  await env.SESSION_KV.put(
    `session:${sessionId}`,
    JSON.stringify(userData),
    { expirationTtl: 86400 * 7 } // 7日間
  );
  return true;
}

/**
 * セッションを取得
 */
async function getSession(env, sessionId) {
  if (!env.SESSION_KV || !sessionId) return null;
  const data = await env.SESSION_KV.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

/**
 * セッションを削除
 */
async function deleteSession(env, sessionId) {
  if (!env.SESSION_KV || !sessionId) return;
  await env.SESSION_KV.delete(`session:${sessionId}`);
}

/**
 * Cookieからセッションを取得
 */
function getSessionFromCookie(request) {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;

  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * 認証済みかチェック
 */
async function isAuthenticated(request, env) {
  const sessionId = getSessionFromCookie(request);
  if (!sessionId) return false;

  const session = await getSession(env, sessionId);
  if (!session) return false;

  // 許可されたメールアドレスかチェック
  const allowedEmail = env.ALLOWED_EMAIL;
  if (allowedEmail && session.email !== allowedEmail) {
    return false;
  }

  return true;
}

/**
 * Google OAuth URL を生成
 */
function getGoogleAuthURL(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent'
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Google OAuth トークン交換
 */
async function exchangeCodeForToken(code, env) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });

  return response.json();
}

/**
 * Google ユーザー情報を取得
 */
async function getGoogleUserInfo(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  return response.json();
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
 * ログインページハンドラー
 */
function handleLoginPage(env) {
  const authURL = getGoogleAuthURL(env);

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ログイン - ${env.SITE_NAME || 'Blog'}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0f0f0f;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .login-container {
      background: #1a1a1a;
      border: 1px solid #2d2d2d;
      border-radius: 12px;
      padding: 60px 40px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      text-align: center;
    }

    h1 {
      font-size: 28px;
      margin-bottom: 10px;
      color: #ffffff;
    }

    p {
      color: #b0b0b0;
      margin-bottom: 40px;
      line-height: 1.6;
    }

    .google-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #2d2d2d;
      color: #ffffff;
      border: 2px solid #404040;
      border-radius: 8px;
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.3s;
      cursor: pointer;
      width: 100%;
    }

    .google-btn:hover {
      background: #353535;
      border-color: #4285f4;
      box-shadow: 0 2px 8px rgba(66, 133, 244, 0.3);
    }

    .google-icon {
      width: 20px;
      height: 20px;
      margin-right: 12px;
    }

    .back-link {
      display: block;
      margin-top: 30px;
      color: #1da1f2;
      text-decoration: none;
      font-size: 14px;
    }

    .back-link:hover {
      text-decoration: underline;
      color: #1a91da;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>管理者ログイン</h1>
    <p>ブログの管理画面にアクセスするには<br>Googleアカウントでログインしてください</p>

    <a href="${authURL}" class="google-btn">
      <svg class="google-icon" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>
      Googleでログイン
    </a>

    <a href="/" class="back-link">← トップページに戻る</a>
  </div>
</body>
</html>
  `;

  return htmlResponse(html);
}

/**
 * OAuth コールバックハンドラー
 */
async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return htmlResponse('<h1>認証エラー</h1><p>認証コードが取得できませんでした。</p>', 400);
  }

  try {
    // トークン取得
    const tokenData = await exchangeCodeForToken(code, env);

    if (!tokenData.access_token) {
      throw new Error('アクセストークンの取得に失敗しました');
    }

    // ユーザー情報取得
    const userInfo = await getGoogleUserInfo(tokenData.access_token);

    // 許可されたメールアドレスかチェック
    const allowedEmail = env.ALLOWED_EMAIL;
    if (allowedEmail && userInfo.email !== allowedEmail) {
      return htmlResponse(`
        <h1>アクセス拒否</h1>
        <p>このメールアドレス（${userInfo.email}）は許可されていません。</p>
        <a href="/">トップページに戻る</a>
      `, 403);
    }

    // セッション作成
    const sessionId = await generateSessionId();
    await saveSession(env, sessionId, {
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture
    });

    // Cookieをセットしてリダイレクト
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/admin',
        'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${86400 * 7}`
      }
    });

  } catch (error) {
    console.error('Auth callback error:', error);
    return htmlResponse(`<h1>認証エラー</h1><p>${error.message}</p>`, 500);
  }
}

/**
 * ログアウトハンドラー
 */
async function handleLogout(request, env) {
  const sessionId = getSessionFromCookie(request);

  if (sessionId) {
    await deleteSession(env, sessionId);
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    }
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

  // PUT /api/posts/:id/pin - 固定投稿設定/解除
  if (pathname.match(/^\/api\/posts\/[^/]+\/pin$/) && method === 'PUT') {
    // 認証チェック
    const authenticated = await isAuthenticated(request, env);
    if (!authenticated) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const postId = pathname.split('/')[3];
    return handleTogglePin(request, env, postId);
  }

  // POST /api/upload - 画像アップロード
  if (pathname === '/api/upload' && method === 'POST') {
    // 認証チェック
    const authenticated = await isAuthenticated(request, env);
    if (!authenticated) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    return handleImageUpload(request, env);
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
      HAVING count > 0
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
 * PUT /api/posts/:id/pin - 固定投稿設定/解除
 */
async function handleTogglePin(request, env, postId) {
  try {
    const body = await request.json();
    const isPinned = body.is_pinned;

    if (typeof isPinned !== 'boolean') {
      return jsonResponse({ error: 'is_pinned must be a boolean' }, 400);
    }

    // 既に固定投稿がある場合は、それを解除する
    if (isPinned) {
      await env.DB.prepare(
        'UPDATE posts SET is_pinned = 0 WHERE is_pinned = 1'
      ).run();
    }

    // 指定された投稿の固定状態を設定
    await env.DB.prepare(
      'UPDATE posts SET is_pinned = ? WHERE id = ?'
    ).bind(isPinned ? 1 : 0, postId).run();

    return jsonResponse({
      success: true,
      is_pinned: isPinned
    });
  } catch (error) {
    console.error('Error toggling pin:', error);
    return jsonResponse({ error: 'Failed to toggle pin' }, 500);
  }
}

/**
 * POST /api/upload - 画像アップロード
 */
async function handleImageUpload(request, env) {
  try {
    if (!env.R2) {
      return jsonResponse({ error: 'R2 bucket not configured' }, 500);
    }

    const formData = await request.formData();
    const imageFile = formData.get('image');

    if (!imageFile) {
      return jsonResponse({ error: 'No image file provided' }, 400);
    }

    // ファイルタイプチェック
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(imageFile.type)) {
      return jsonResponse({ error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP' }, 400);
    }

    // ファイルサイズチェック (5MB制限)
    if (imageFile.size > 5 * 1024 * 1024) {
      return jsonResponse({ error: 'File size exceeds 5MB limit' }, 400);
    }

    // ファイル名を生成（タイムスタンプ + ランダム文字列）
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 10);
    const ext = imageFile.name.split('.').pop();
    const filename = `${timestamp}-${randomStr}.${ext}`;

    // R2にアップロード
    await env.R2.put(filename, imageFile.stream(), {
      httpMetadata: {
        contentType: imageFile.type
      }
    });

    // 公開URLを生成
    // Note: R2のPublic Bucketを使用している場合、またはCustom Domainを設定している場合
    // ここではWorker経由で画像を提供する想定
    const imageUrl = `${env.SITE_URL}/images/${filename}`;

    return jsonResponse({
      success: true,
      url: imageUrl,
      filename: filename
    });

  } catch (error) {
    console.error('Error uploading image:', error);
    return jsonResponse({ error: 'Failed to upload image' }, 500);
  }
}

/**
 * 画像取得ハンドラー (R2から画像を取得)
 */
async function handleImageGet(env, filename) {
  try {
    if (!env.R2) {
      return new Response('R2 bucket not configured', { status: 500 });
    }

    const object = await env.R2.get(filename);

    if (!object) {
      return new Response('Image not found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000');

    return new Response(object.body, {
      headers
    });

  } catch (error) {
    console.error('Error fetching image:', error);
    return new Response('Failed to fetch image', { status: 500 });
  }
}

/**
 * トップページハンドラー
 */
async function handleIndexPage(env) {
  const siteName = env.SITE_NAME || 'Journal';

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${siteName}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
  <style>
    :root {
      --color-primary: #3965a0ff;
      --color-primary-dark: #383933;
      --color-bg: #3d3b3bff;
      --color-bg-secondary: #181818ff;
      --color-text: #8f8b7c;
      --color-text-secondary: #666666;
      --color-text-muted: #999999;
      --color-border: #333435;
      --color-like: #687428ff;
      --color-tag: #737550;
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
      border-radius: 0px;
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

    .post-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      gap: 12px;
    }

    .pinned-badge {
      display: inline-block;
      background-color: var(--color-primary);
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
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
      <a href="/login" class="login-btn">Login</a>
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
        <!-- ヘッダー（固定バッジ & タイムスタンプ） -->
        <div class="post-header">
          <div x-show="post.is_pinned" class="pinned-badge">📌 固定投稿</div>
          <a :href="'/post/' + post.id" class="post-timestamp" x-text="formatTimestamp(post.created_at)"></a>
        </div>

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
        </div>
      </article>
    </template>
  </div>

  <!-- Toast -->
  <div id="toast" class="toast"></div>

  <script>
    function blogApp() {
      return {
        siteName: '${siteName}',
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
 * 管理画面ダッシュボード
 */
async function handleAdminDashboard(request, env) {
  const session = await getSession(env, getSessionFromCookie(request));

  // 投稿一覧を取得
  const posts = await env.DB.prepare(
    'SELECT id, content, image_url, is_pinned, created_at FROM posts ORDER BY created_at DESC LIMIT 50'
  ).all();

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理画面 - ${env.SITE_NAME || 'Blog'}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0f0f0f;
    }

    .header {
      background: #1a1a1a;
      border-bottom: 1px solid #2d2d2d;
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .header-left h1 {
      font-size: 20px;
      color: #ffffff;
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #e0e0e0;
    }

    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
    }

    .btn {
      padding: 8px 16px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: inline-block;
    }

    .btn-primary {
      background: #1da1f2;
      color: white;
    }

    .btn-primary:hover {
      background: #1a91da;
    }

    .btn-secondary {
      background: #2d2d2d;
      color: #e0e0e0;
      border: 1px solid #404040;
    }

    .btn-secondary:hover {
      background: #353535;
    }

    .container {
      max-width: 1200px;
      margin: 24px auto;
      padding: 0 24px;
    }

    .actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }

    .actions h2 {
      color: #ffffff;
    }

    .posts-table {
      background: #1a1a1a;
      border: 1px solid #2d2d2d;
      border-radius: 8px;
      overflow: hidden;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      background: #212121;
      padding: 12px 16px;
      text-align: left;
      font-weight: 600;
      font-size: 14px;
      color: #b0b0b0;
      border-bottom: 1px solid #2d2d2d;
    }

    td {
      padding: 16px;
      border-bottom: 1px solid #2d2d2d;
      font-size: 14px;
      color: #e0e0e0;
    }

    tr:hover {
      background: #212121;
    }

    .post-preview {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .post-image {
      width: 60px;
      height: 60px;
      object-fit: cover;
      border-radius: 4px;
    }

    .post-actions {
      display: flex;
      gap: 8px;
    }

    .btn-small {
      padding: 6px 12px;
      font-size: 13px;
    }

    .btn-danger {
      background: #dc3545;
      color: white;
    }

    .btn-danger:hover {
      background: #c82333;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #b0b0b0;
    }

    .empty-state h2 {
      margin-bottom: 12px;
      color: #e0e0e0;
    }

    code {
      background: #2d2d2d;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
    }

    .menu-container {
      position: relative;
      display: inline-block;
    }

    .menu-btn {
      background: #2d2d2d;
      color: #e0e0e0;
      border: 1px solid #404040;
      border-radius: 4px;
      width: 32px;
      height: 32px;
      font-size: 18px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .menu-btn:hover {
      background: #353535;
      border-color: #505050;
    }

    .dropdown-menu {
      display: none;
      position: absolute;
      right: 0;
      top: 36px;
      background: #1a1a1a;
      border: 1px solid #404040;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      min-width: 180px;
      z-index: 1000;
    }

    .dropdown-menu.show {
      display: block;
    }

    .dropdown-item {
      padding: 10px 16px;
      color: #e0e0e0;
      cursor: pointer;
      font-size: 14px;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      transition: background 0.2s;
    }

    .dropdown-item:hover {
      background: #2d2d2d;
    }

    .dropdown-item:first-child {
      border-radius: 6px 6px 0 0;
    }

    .dropdown-item:last-child {
      border-radius: 0 0 6px 6px;
    }

    .pin-badge {
      display: inline-block;
      background: #1da1f2;
      color: white;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      margin-left: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>📝 ブログ管理画面</h1>
      <a href="/" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">🔗 View</a>
    </div>
    <div class="user-info">
      ${session?.picture ? `<img src="${session.picture}" alt="${session.name}" class="user-avatar">` : ''}
      <span>${session?.name || 'Admin'}</span>
      <a href="/logout" class="btn btn-secondary">ログアウト</a>
    </div>
  </div>

  <div class="container">
    <div class="actions">
      <h2>投稿一覧</h2>
      <a href="/admin/posts/new" class="btn btn-primary">+ 新規投稿</a>
    </div>

    <div class="posts-table">
      ${posts.results.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>内容</th>
              <th>画像</th>
              <th>作成日時</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${posts.results.map(post => `
              <tr>
                <td>
                  <code>${post.id}</code>
                  ${post.is_pinned ? '<span class="pin-badge">📌 固定</span>' : ''}
                </td>
                <td class="post-preview">${post.content.substring(0, 100).replace(/<[^>]*>/g, '')}...</td>
                <td>
                  ${post.image_url ? `<img src="${post.image_url}" alt="" class="post-image">` : '-'}
                </td>
                <td>${new Date(post.created_at).toLocaleString('ja-JP')}</td>
                <td class="post-actions">
                  <a href="/admin/posts/${post.id}/edit" class="btn btn-secondary btn-small">編集</a>
                  <button onclick="deletePost('${post.id}')" class="btn btn-danger btn-small">削除</button>
                  <div class="menu-container">
                    <button class="menu-btn" onclick="toggleMenu(event, '${post.id}')">⋮</button>
                    <div class="dropdown-menu" id="menu-${post.id}">
                      <button class="dropdown-item" onclick="togglePin('${post.id}', ${post.is_pinned ? 'false' : 'true'})">
                        ${post.is_pinned ? '📌 固定を解除' : '📌 固定記事にする'}
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : `
        <div class="empty-state">
          <h2>投稿がありません</h2>
          <p>最初の投稿を作成しましょう</p>
          <br>
          <a href="/admin/posts/new" class="btn btn-primary">+ 新規投稿</a>
        </div>
      `}
    </div>
  </div>

  <script>
    async function deletePost(postId) {
      if (!confirm('この投稿を削除してもよろしいですか？')) {
        return;
      }

      try {
        const response = await fetch('/api/posts/' + postId, {
          method: 'DELETE'
        });

        if (response.ok) {
          alert('削除しました');
          location.reload();
        } else {
          alert('削除に失敗しました');
        }
      } catch (error) {
        alert('エラーが発生しました: ' + error.message);
      }
    }

    function toggleMenu(event, postId) {
      event.stopPropagation();
      const menu = document.getElementById('menu-' + postId);
      const allMenus = document.querySelectorAll('.dropdown-menu');

      // 他のメニューを閉じる
      allMenus.forEach(m => {
        if (m.id !== 'menu-' + postId) {
          m.classList.remove('show');
        }
      });

      // クリックしたメニューをトグル
      menu.classList.toggle('show');
    }

    async function togglePin(postId, isPinned) {
      try {
        const response = await fetch('/api/posts/' + postId + '/pin', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ is_pinned: isPinned })
        });

        if (response.ok) {
          alert(isPinned ? '固定記事に設定しました' : '固定を解除しました');
          location.reload();
        } else {
          alert('設定の変更に失敗しました');
        }
      } catch (error) {
        alert('エラーが発生しました: ' + error.message);
      }
    }

    // ページ外をクリックしたらメニューを閉じる
    document.addEventListener('click', function() {
      document.querySelectorAll('.dropdown-menu').forEach(menu => {
        menu.classList.remove('show');
      });
    });
  </script>
</body>
</html>
  `;

  return htmlResponse(html);
}

/**
 * 新規投稿画面
 */
async function handleNewPost(env) {
  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>新規投稿 - ${env.SITE_NAME || 'Blog'}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0f0f0f;
    }

    .header {
      background: #1a1a1a;
      border-bottom: 1px solid #2d2d2d;
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header h1 {
      font-size: 20px;
      color: #ffffff;
    }

    .header-actions {
      display: flex;
      gap: 12px;
    }

    .btn {
      padding: 8px 16px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: inline-block;
    }

    .btn-primary {
      background: #1da1f2;
      color: white;
    }

    .btn-primary:hover {
      background: #1a91da;
    }

    .btn-primary:disabled {
      background: #555;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: #2d2d2d;
      color: #e0e0e0;
      border: 1px solid #404040;
    }

    .btn-secondary:hover {
      background: #353535;
    }

    .container {
      max-width: 900px;
      margin: 24px auto;
      padding: 0 24px;
    }

    .editor-container {
      background: #1a1a1a;
      border: 1px solid #2d2d2d;
      border-radius: 8px;
      padding: 24px;
    }

    .form-group {
      margin-bottom: 24px;
    }

    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #e0e0e0;
      font-size: 14px;
    }

    textarea {
      width: 100%;
      padding: 12px;
      background: #2d2d2d;
      border: 1px solid #404040;
      border-radius: 6px;
      font-size: 15px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      resize: vertical;
      min-height: 200px;
      color: #e0e0e0;
    }

    textarea:focus {
      outline: none;
      border-color: #1da1f2;
      background: #353535;
    }

    input[type="text"],
    input[type="file"] {
      width: 100%;
      padding: 10px 12px;
      background: #2d2d2d;
      border: 1px solid #404040;
      border-radius: 6px;
      font-size: 14px;
      color: #e0e0e0;
    }

    input[type="text"]:focus {
      outline: none;
      border-color: #1da1f2;
      background: #353535;
    }

    input[type="file"]::file-selector-button {
      background: #404040;
      color: #e0e0e0;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 12px;
    }

    input[type="file"]::file-selector-button:hover {
      background: #4a4a4a;
    }

    .preview {
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2d2d2d;
    }

    .preview h3 {
      margin-bottom: 12px;
      color: #e0e0e0;
    }

    .preview-content {
      padding: 16px;
      background: #212121;
      border: 1px solid #2d2d2d;
      border-radius: 6px;
      min-height: 100px;
      color: #e0e0e0;
    }

    .help-text {
      font-size: 13px;
      color: #b0b0b0;
      margin-top: 4px;
    }

    .image-preview {
      margin-top: 12px;
      max-width: 400px;
      position: relative;
    }

    .image-preview img {
      max-width: 100%;
      border-radius: 8px;
      border: 1px solid #404040;
      display: block;
    }

    .image-preview .remove-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(220, 53, 69, 0.9);
      color: white;
      border: none;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .image-preview .remove-btn:hover {
      background: rgba(220, 53, 69, 1);
      transform: scale(1.1);
    }

    .loading {
      display: none;
      color: #b0b0b0;
      margin-left: 12px;
    }

    .loading.show {
      display: inline;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📝 新規投稿</h1>
    <div class="header-actions">
      <a href="/admin" class="btn btn-secondary">キャンセル</a>
      <button onclick="submitPost()" class="btn btn-primary" id="submitBtn">投稿する</button>
      <span class="loading" id="loading">投稿中...</span>
    </div>
  </div>

  <div class="container">
    <div class="editor-container">
      <div class="form-group">
        <label for="content">内容</label>
        <textarea id="content" placeholder="投稿内容を入力してください（Markdown対応）"></textarea>
        <div class="help-text">Markdown記法が使えます。例: **太字**、*斜体*、# 見出し</div>
      </div>

      <div class="form-group">
        <label for="image">画像</label>
        <input type="file" id="image" accept="image/*" onchange="previewImage(this)">
        <div class="help-text">投稿に添付する画像を選択できます</div>
        <div class="image-preview" id="imagePreview"></div>
      </div>

      <div class="form-group">
        <label for="tags">タグ</label>
        <input type="text" id="tags" placeholder="タグ1, タグ2, タグ3">
        <div class="help-text">カンマ区切りで複数のタグを指定できます</div>
      </div>

      <div class="preview">
        <h3>プレビュー</h3>
        <div class="preview-content" id="preview"></div>
      </div>
    </div>
  </div>

  <script>
    const contentInput = document.getElementById('content');
    const previewDiv = document.getElementById('preview');

    // リアルタイムプレビュー
    contentInput.addEventListener('input', () => {
      const markdown = contentInput.value;
      previewDiv.innerHTML = markdown ? marked.parse(markdown) : '<em>プレビューがここに表示されます</em>';
    });

    // 画像プレビュー
    function previewImage(input) {
      const previewDiv = document.getElementById('imagePreview');
      previewDiv.innerHTML = '';

      if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => {
          previewDiv.innerHTML = '<img src="' + e.target.result + '" alt="Preview"><button class="remove-btn" onclick="removeImage()" title="画像を削除">×</button>';
        };
        reader.readAsDataURL(input.files[0]);
      }
    }

    // 画像削除
    function removeImage() {
      const imageInput = document.getElementById('image');
      const previewDiv = document.getElementById('imagePreview');
      imageInput.value = '';
      previewDiv.innerHTML = '';
    }

    // 投稿送信
    async function submitPost() {
      const content = document.getElementById('content').value.trim();
      const imageFile = document.getElementById('image').files[0];
      const tagsInput = document.getElementById('tags').value.trim();

      if (!content) {
        alert('内容を入力してください');
        return;
      }

      const submitBtn = document.getElementById('submitBtn');
      const loading = document.getElementById('loading');

      submitBtn.disabled = true;
      loading.classList.add('show');

      try {
        let imageUrl = null;

        // 画像アップロード
        if (imageFile) {
          const formData = new FormData();
          formData.append('image', imageFile);

          const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: formData
          });

          if (!uploadResponse.ok) {
            throw new Error('画像のアップロードに失敗しました');
          }

          const uploadData = await uploadResponse.json();
          imageUrl = uploadData.url;
        }

        // 投稿作成
        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(t => t) : [];

        const response = await fetch('/api/posts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content,
            image_url: imageUrl,
            tags
          })
        });

        if (!response.ok) {
          throw new Error('投稿の作成に失敗しました');
        }

        const data = await response.json();
        alert('投稿しました！');
        location.href = '/admin';

      } catch (error) {
        alert('エラーが発生しました: ' + error.message);
        submitBtn.disabled = false;
        loading.classList.remove('show');
      }
    }
  </script>
</body>
</html>
  `;

  return htmlResponse(html);
}

/**
 * 投稿編集画面
 */
async function handleEditPost(env, postId) {
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
  const tagsStr = tags.map(t => t.name).join(', ');

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>投稿編集 - ${env.SITE_NAME || 'Blog'}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0f0f0f;
    }

    .header {
      background: #1a1a1a;
      border-bottom: 1px solid #2d2d2d;
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header h1 {
      font-size: 20px;
      color: #ffffff;
    }

    .header-actions {
      display: flex;
      gap: 12px;
    }

    .btn {
      padding: 8px 16px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: inline-block;
    }

    .btn-primary {
      background: #1da1f2;
      color: white;
    }

    .btn-primary:hover {
      background: #1a91da;
    }

    .btn-primary:disabled {
      background: #555;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: #2d2d2d;
      color: #e0e0e0;
      border: 1px solid #404040;
    }

    .btn-secondary:hover {
      background: #353535;
    }

    .container {
      max-width: 900px;
      margin: 24px auto;
      padding: 0 24px;
    }

    .editor-container {
      background: #1a1a1a;
      border: 1px solid #2d2d2d;
      border-radius: 8px;
      padding: 24px;
    }

    .form-group {
      margin-bottom: 24px;
    }

    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #e0e0e0;
      font-size: 14px;
    }

    textarea {
      width: 100%;
      padding: 12px;
      background: #2d2d2d;
      border: 1px solid #404040;
      border-radius: 6px;
      font-size: 15px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      resize: vertical;
      min-height: 200px;
      color: #e0e0e0;
    }

    textarea:focus {
      outline: none;
      border-color: #1da1f2;
      background: #353535;
    }

    input[type="text"],
    input[type="file"] {
      width: 100%;
      padding: 10px 12px;
      background: #2d2d2d;
      border: 1px solid #404040;
      border-radius: 6px;
      font-size: 14px;
      color: #e0e0e0;
    }

    input[type="text"]:focus {
      outline: none;
      border-color: #1da1f2;
      background: #353535;
    }

    input[type="file"]::file-selector-button {
      background: #404040;
      color: #e0e0e0;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 12px;
    }

    input[type="file"]::file-selector-button:hover {
      background: #4a4a4a;
    }

    .preview {
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2d2d2d;
    }

    .preview h3 {
      margin-bottom: 12px;
      color: #e0e0e0;
    }

    .preview-content {
      padding: 16px;
      background: #212121;
      border: 1px solid #2d2d2d;
      border-radius: 6px;
      min-height: 100px;
      color: #e0e0e0;
    }

    .help-text {
      font-size: 13px;
      color: #b0b0b0;
      margin-top: 4px;
    }

    .current-image {
      margin-top: 12px;
      max-width: 400px;
      position: relative;
    }

    .current-image img {
      max-width: 100%;
      border-radius: 8px;
      border: 1px solid #404040;
      display: block;
    }

    .current-image .remove-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(220, 53, 69, 0.9);
      color: white;
      border: none;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .current-image .remove-btn:hover {
      background: rgba(220, 53, 69, 1);
      transform: scale(1.1);
    }

    .image-preview {
      margin-top: 12px;
      max-width: 400px;
      position: relative;
    }

    .image-preview img {
      max-width: 100%;
      border-radius: 8px;
      border: 1px solid #404040;
      display: block;
    }

    .image-preview .remove-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(220, 53, 69, 0.9);
      color: white;
      border: none;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .image-preview .remove-btn:hover {
      background: rgba(220, 53, 69, 1);
      transform: scale(1.1);
    }

    .loading {
      display: none;
      color: #b0b0b0;
      margin-left: 12px;
    }

    .loading.show {
      display: inline;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>✏️ 投稿編集</h1>
    <div class="header-actions">
      <a href="/admin" class="btn btn-secondary">キャンセル</a>
      <button onclick="updatePost()" class="btn btn-primary" id="submitBtn">更新する</button>
      <span class="loading" id="loading">更新中...</span>
    </div>
  </div>

  <div class="container">
    <div class="editor-container">
      <div class="form-group">
        <label for="content">内容</label>
        <textarea id="content">${post.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
        <div class="help-text">Markdown記法が使えます。例: **太字**、*斜体*、# 見出し</div>
      </div>

      <div class="form-group">
        <label for="image">画像</label>
        ${post.image_url ? `
          <div class="current-image" id="currentImage">
            <div class="help-text">現在の画像:</div>
            <img src="${post.image_url}" alt="Current">
            <button class="remove-btn" onclick="removeCurrentImage()" title="現在の画像を削除">×</button>
          </div>
        ` : ''}
        <input type="file" id="image" accept="image/*" onchange="previewImage(this)" style="margin-top: 12px;">
        <div class="help-text">新しい画像を選択すると、現在の画像が置き換わります</div>
        <div class="image-preview" id="imagePreview"></div>
      </div>

      <div class="form-group">
        <label for="tags">タグ</label>
        <input type="text" id="tags" value="${tagsStr}" placeholder="タグ1, タグ2, タグ3">
        <div class="help-text">カンマ区切りで複数のタグを指定できます</div>
      </div>

      <div class="preview">
        <h3>プレビュー</h3>
        <div class="preview-content" id="preview"></div>
      </div>
    </div>
  </div>

  <script>
    const contentInput = document.getElementById('content');
    const previewDiv = document.getElementById('preview');

    // 初期プレビュー
    previewDiv.innerHTML = marked.parse(contentInput.value);

    // リアルタイムプレビュー
    contentInput.addEventListener('input', () => {
      const markdown = contentInput.value;
      previewDiv.innerHTML = markdown ? marked.parse(markdown) : '<em>プレビューがここに表示されます</em>';
    });

    // 画像プレビュー
    function previewImage(input) {
      const previewDiv = document.getElementById('imagePreview');
      previewDiv.innerHTML = '';

      if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => {
          previewDiv.innerHTML = '<img src="' + e.target.result + '" alt="Preview"><button class="remove-btn" onclick="removeImage()" title="画像を削除">×</button>';
        };
        reader.readAsDataURL(input.files[0]);
      }
    }

    // 画像削除
    function removeImage() {
      const imageInput = document.getElementById('image');
      const previewDiv = document.getElementById('imagePreview');
      imageInput.value = '';
      previewDiv.innerHTML = '';
    }

    // 現在の画像を削除
    function removeCurrentImage() {
      const currentImageDiv = document.getElementById('currentImage');
      if (currentImageDiv && confirm('現在の画像を削除しますか？保存時に画像なしで更新されます。')) {
        currentImageDiv.style.display = 'none';
      }
    }

    // 投稿更新
    async function updatePost() {
      const content = document.getElementById('content').value.trim();
      const imageFile = document.getElementById('image').files[0];
      const tagsInput = document.getElementById('tags').value.trim();

      if (!content) {
        alert('内容を入力してください');
        return;
      }

      const submitBtn = document.getElementById('submitBtn');
      const loading = document.getElementById('loading');

      submitBtn.disabled = true;
      loading.classList.add('show');

      try {
        let imageUrl = '${post.image_url || ''}';

        // 現在の画像が削除された場合
        const currentImageDiv = document.getElementById('currentImage');
        if (currentImageDiv && currentImageDiv.style.display === 'none') {
          imageUrl = null;
        }

        // 新しい画像がアップロードされた場合
        if (imageFile) {
          const formData = new FormData();
          formData.append('image', imageFile);

          const uploadResponse = await fetch('/api/upload', {
            method: 'POST',
            body: formData
          });

          if (!uploadResponse.ok) {
            throw new Error('画像のアップロードに失敗しました');
          }

          const uploadData = await uploadResponse.json();
          imageUrl = uploadData.url;
        }

        // 投稿更新
        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(t => t) : [];

        const response = await fetch('/api/posts/${postId}', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content,
            image_url: imageUrl || null,
            tags
          })
        });

        if (!response.ok) {
          throw new Error('投稿の更新に失敗しました');
        }

        alert('更新しました！');
        location.href = '/admin';

      } catch (error) {
        alert('エラーが発生しました: ' + error.message);
        submitBtn.disabled = false;
        loading.classList.remove('show');
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
    const siteName = env.SITE_NAME || 'My Blog';
    const ogTitle = post.content.substring(0, 100).replace(/<[^>]*>/g, '');
    const ogDescription = post.content.substring(0, 200).replace(/<[^>]*>/g, '');
    const ogImage = post.image_url || '';
    const ogUrl = env.SITE_URL + '/post/' + postId;

    const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ogTitle} - ${siteName}</title>

  <!-- OGP Meta Tags -->
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDescription}">
  ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
  <meta property="og:url" content="${ogUrl}">
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
      <!-- タイムスタンプ -->
      <div class="post-timestamp" x-text="formatTimestamp(post.created_at)" style="margin-bottom: 12px; text-align: right;"></div>

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
    </article>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function postPage() {
      return {
        post: ${JSON.stringify(post)},
        likes: 0,
        liked: false,

        async init() {
          await this.loadLikes();
        },

        async loadLikes() {
          try {
            const response = await fetch('/api/likes/${postId}');
            const data = await response.json();
            this.likes = data.likes;
            this.liked = data.liked;
          } catch (error) {
            console.error('Failed to load likes:', error);
          }
        },

        async toggleLike() {
          try {
            const response = await fetch('/api/like/${postId}', {
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
    `;

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

    // 画像取得
    if (pathname.startsWith('/images/')) {
      const filename = pathname.split('/')[2];
      return handleImageGet(env, filename);
    }

    // ログイン
    if (pathname === '/login') {
      return handleLoginPage(env);
    }

    // OAuth コールバック
    if (pathname === '/auth/callback') {
      return handleAuthCallback(request, env);
    }

    // ログアウト
    if (pathname === '/logout') {
      return handleLogout(request, env);
    }

    // 管理画面（認証必須）
    if (pathname === '/admin') {
      const authenticated = await isAuthenticated(request, env);
      if (!authenticated) {
        return new Response(null, {
          status: 302,
          headers: { 'Location': '/login' }
        });
      }
      return handleAdminDashboard(request, env);
    }

    // 新規投稿画面（認証必須）
    if (pathname === '/admin/posts/new') {
      const authenticated = await isAuthenticated(request, env);
      if (!authenticated) {
        return new Response(null, {
          status: 302,
          headers: { 'Location': '/login' }
        });
      }
      return handleNewPost(env);
    }

    // 投稿編集画面（認証必須）
    if (pathname.match(/^\/admin\/posts\/[^/]+\/edit$/)) {
      const authenticated = await isAuthenticated(request, env);
      if (!authenticated) {
        return new Response(null, {
          status: 302,
          headers: { 'Location': '/login' }
        });
      }
      const postId = pathname.split('/')[3];
      return handleEditPost(env, postId);
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
