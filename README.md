# Cloudflare Blog System

【Private】Cloudflareに作るSubstackのNotesのようなミニブログ

X-like posting experience with Substack-like UI on Cloudflare Workers

## Features

✅ **Phase 1 - 完了**
- Cloudflare Workers + D1 + R2 ベースのブログシステム
- タイムスタンプベースの投稿ID生成（yyyymmddhhmmss形式）
- 投稿CRUD API（作成・取得・更新・削除）
- Markdown表示機能（marked.js）
- タグ機能（作成・フィルタリング）
- いいね機能（IPベース重複防止）
- 個別投稿ページ（OGPメタタグ対応）
- 共有機能（URLコピー）
- ボット対策（User-Agent、Rate Limiting、robots.txt）
- CORS対応
- Substackライクなデザイン（Alpine.js + Tailwind CSS風カスタムCSS）

🚧 **Phase 2 - 今後実装予定**
- Google OAuth認証
- R2画像アップロード機能
- 投稿フォーム（UI）
- 画像spoiler機能
- テキストspoiler機能（||text||）

## Tech Stack

### Backend
- **Cloudflare Workers** - Serverless edge computing
- **Cloudflare D1** - SQLite database
- **Cloudflare R2** - Image storage (予定)
- **Cloudflare KV** - Rate limiting & sessions

### Frontend
- **Alpine.js** - Lightweight reactive UI
- **marked.js** - Markdown parsing
- **Vanilla JavaScript** - No build step required

## Setup

### 1. 依存関係のインストール

```bash
npm install
```

### 2. D1データベースの作成

```bash
# D1データベースを作成
npx wrangler d1 create blog-db

# 出力されたdatabase_idをwrangler.tomlに設定
# [[d1_databases]]
# binding = "DB"
# database_name = "blog-db"
# database_id = "YOUR_DATABASE_ID_HERE"
```

### 3. KV Namespaceの作成

```bash
# Rate Limiting用
npx wrangler kv:namespace create "RATE_LIMIT_KV"

# Session管理用
npx wrangler kv:namespace create "SESSION_KV"

# 出力されたIDをwrangler.tomlに設定
```

### 4. R2バケットの作成（予定）

```bash
npx wrangler r2 bucket create blog-images
```

### 5. データベースマイグレーション

```bash
# ローカル環境
npm run db:migrate

# 本番環境
npm run db:migrate:remote
```

### 6. ローカル開発

```bash
npm run dev
```

ブラウザで http://localhost:8787 を開く

### 7. デプロイ

```bash
npm run deploy
```

## Environment Variables

以下の環境変数を設定してください（`wrangler secret put`コマンドまたはCloudflare Dashboardから）:

```bash
# Google OAuth（今後実装）
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REDIRECT_URI
wrangler secret put ALLOWED_EMAIL

# Session
wrangler secret put SESSION_SECRET
```

`wrangler.toml`の`[vars]`セクションで公開可能な変数を設定:

```toml
[vars]
SITE_URL = "https://your-domain.com"
SITE_NAME = "Your Blog Name"
ALLOWED_ORIGINS = "https://your-domain.com,https://yourdomain.carrd.co"
```

## API Endpoints

### 投稿
- `GET /api/posts` - 投稿一覧取得
  - Query params: `tag`, `pinned`, `limit`, `offset`
- `GET /api/posts/:id` - 個別投稿取得
- `POST /api/posts` - 新規投稿（認証必須・今後実装）
- `PUT /api/posts/:id` - 投稿編集（認証必須・今後実装）
- `DELETE /api/posts/:id` - 投稿削除（認証必須・今後実装）

### タグ
- `GET /api/tags` - タグ一覧取得

### いいね
- `POST /api/like/:postId` - いいね追加/削除（トグル）
- `GET /api/likes/:postId` - いいね数取得

### その他
- `GET /robots.txt` - robots.txt生成
- `GET /` - トップページ
- `GET /post/:id` - 個別投稿ページ

## Database Schema

```sql
-- 投稿テーブル
CREATE TABLE posts (
  id TEXT PRIMARY KEY,  -- yyyymmddhhmmss形式
  content TEXT NOT NULL,
  image_url TEXT,
  image_sensitive BOOLEAN DEFAULT 0,
  is_pinned BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- タグテーブル
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

-- 投稿-タグ関連テーブル
CREATE TABLE post_tags (
  post_id TEXT,
  tag_id INTEGER,
  PRIMARY KEY (post_id, tag_id)
);

-- いいねテーブル
CREATE TABLE likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, ip_hash)
);
```

## Project Structure

```
.
├── src/
│   └── index.js          # Main Worker code
├── schema.sql            # Database schema
├── wrangler.toml         # Cloudflare Workers config
├── package.json          # Dependencies
└── README.md            # This file
```

## Testing

APIエンドポイントをテストする:

```bash
# 投稿一覧を取得
curl http://localhost:8787/api/posts

# 新規投稿を作成（今後認証が必要になります）
curl -X POST http://localhost:8787/api/posts \
  -H "Content-Type: application/json" \
  -d '{
    "content": "# Hello World\n\nThis is my first post!",
    "tags": ["tech", "blog"],
    "is_pinned": false
  }'

# タグ一覧を取得
curl http://localhost:8787/api/tags
```

## License

MIT
