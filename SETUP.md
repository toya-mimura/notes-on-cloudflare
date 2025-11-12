# セットアップ手順書

このドキュメントでは、Cloudflare Blog Systemをゼロからセットアップする詳細な手順を説明します。

## 前提条件

- Node.js 18以上がインストールされていること
- Cloudflareアカウントを持っていること
- Wranglerがインストールされていること（なければ `npm install -g wrangler`）

## Step 1: Cloudflareにログイン

```bash
npx wrangler login
```

ブラウザが開くので、Cloudflareアカウントでログインします。

## Step 2: プロジェクトのセットアップ

```bash
# 依存関係のインストール
npm install
```

## Step 3: D1データベースの作成

```bash
# D1データベースを作成
npx wrangler d1 create blog-db
```

出力例:
```
✅ Successfully created DB 'blog-db' in region APAC
Created your database using D1's new storage backend. The new storage backend is not yet recommended for production workloads, but backs up your data via point-in-time restore.

[[d1_databases]]
binding = "DB" # available in your Worker on env.DB
database_name = "blog-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

出力された `database_id` をコピーして、`wrangler.toml` の該当箇所に貼り付けます：

```toml
[[d1_databases]]
binding = "DB"
database_name = "blog-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ここに貼り付け
```

## Step 4: KV Namespaceの作成

### Rate Limiting用KV

```bash
npx wrangler kv:namespace create "RATE_LIMIT_KV"
```

出力例:
```
🌀 Creating namespace with title "cloudflare-blog-system-RATE_LIMIT_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "RATE_LIMIT_KV", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

### Session管理用KV

```bash
npx wrangler kv:namespace create "SESSION_KV"
```

出力例:
```
🌀 Creating namespace with title "cloudflare-blog-system-SESSION_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "SESSION_KV", id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy" }
```

両方の `id` を `wrangler.toml` に設定します：

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # Rate Limiting用

[[kv_namespaces]]
binding = "SESSION_KV"
id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"  # Session管理用
```

## Step 5: R2バケットの作成（オプション - Phase 2で使用）

```bash
npx wrangler r2 bucket create blog-images
```

出力例:
```
 ⛅️ wrangler 3.x.x
-------------------
Creating bucket blog-images.
Created bucket blog-images.
```

`wrangler.toml`のR2設定は既に含まれています。

## Step 6: データベースマイグレーション

### ローカル環境でテスト

```bash
npm run db:migrate
```

または

```bash
npx wrangler d1 execute blog-db --local --file=./schema.sql
```

出力例:
```
🌀 Mapping SQL input into an array of statements
🌀 Executing on local database blog-db (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) from .wrangler/state/v3/d1:
🌀 To execute on your remote database, add a --remote flag to your wrangler command.
├ 🌀 Executing statements (4)
│ ✅ Successfully executed
```

### 本番環境にデプロイ（後で実行）

```bash
npm run db:migrate:remote
```

または

```bash
npx wrangler d1 execute blog-db --remote --file=./schema.sql
```

## Step 7: 環境変数の設定（オプション）

`wrangler.toml` の `[vars]` セクションを編集します：

```toml
[vars]
SITE_URL = "http://localhost:8787"  # 本番環境では実際のURLに変更
SITE_NAME = "My Tech Blog"          # ブログ名を設定
ALLOWED_ORIGINS = "http://localhost:8787"  # CORS許可するオリジンを設定
```

将来的にGoogle OAuth等を実装する場合は、シークレット情報を設定します：

```bash
# Google OAuth（Phase 2で実装）
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REDIRECT_URI
npx wrangler secret put ALLOWED_EMAIL

# Session用
npx wrangler secret put SESSION_SECRET
```

## Step 8: ローカル開発サーバーの起動

```bash
npm run dev
```

出力例:
```
 ⛅️ wrangler 3.x.x
-------------------
⎔ Starting local server...
[wrangler:inf] Ready on http://localhost:8787
```

ブラウザで http://localhost:8787 を開きます。

## Step 9: テストデータの投入

ローカルサーバーが起動している状態で、別のターミナルで以下を実行します：

### 投稿を作成

```bash
curl -X POST http://localhost:8787/api/posts \
  -H "Content-Type: application/json" \
  -d '{
    "content": "# Hello World\n\nこれは最初の投稿です！\n\n## Markdownの例\n\n- リスト1\n- リスト2\n\n**太字** と *イタリック*\n\n```javascript\nconsole.log(\"Hello, World!\");\n```",
    "tags": ["tech", "blog"],
    "is_pinned": true
  }'
```

### 別の投稿を作成

```bash
curl -X POST http://localhost:8787/api/posts \
  -H "Content-Type: application/json" \
  -d '{
    "content": "# Cloudflare Workersについて\n\nCloudflare WorkersはエッジでJavaScriptを実行できる素晴らしいプラットフォームです。\n\n## メリット\n\n- 低レイテンシ\n- グローバル展開\n- 従量課金",
    "tags": ["tech", "cloudflare"],
    "is_pinned": false
  }'
```

### 投稿一覧を確認

```bash
curl http://localhost:8787/api/posts | jq
```

### タグ一覧を確認

```bash
curl http://localhost:8787/api/tags | jq
```

ブラウザで http://localhost:8787 を開いて、投稿が表示されることを確認します。

## Step 10: 本番環境へのデプロイ

### データベースマイグレーション（本番）

```bash
npm run db:migrate:remote
```

### Workers のデプロイ

```bash
npm run deploy
```

出力例:
```
 ⛅️ wrangler 3.x.x
-------------------
Total Upload: xx.xx KiB / gzip: xx.xx KiB
Uploaded cloudflare-blog-system (x.xx sec)
Published cloudflare-blog-system (x.xx sec)
  https://cloudflare-blog-system.your-subdomain.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

デプロイされたURLにアクセスして、動作を確認します。

## Step 11: カスタムドメインの設定（オプション）

Cloudflare Dashboardで：

1. Workers & Pages → your-worker → Settings → Domains & Routes
2. "Add Custom Domain" をクリック
3. ドメインを入力（例：blog.yourdomain.com）
4. DNSレコードが自動的に追加されます

`wrangler.toml` の `SITE_URL` を更新：

```toml
[vars]
SITE_URL = "https://blog.yourdomain.com"
ALLOWED_ORIGINS = "https://blog.yourdomain.com,https://yourdomain.carrd.co"
```

再デプロイ：

```bash
npm run deploy
```

## トラブルシューティング

### D1データベースが見つからない

```bash
# データベース一覧を確認
npx wrangler d1 list

# wrangler.tomlのdatabase_idが正しいか確認
```

### KV Namespaceが見つからない

```bash
# KV namespace一覧を確認
npx wrangler kv:namespace list

# wrangler.tomlのidが正しいか確認
```

### ローカルサーバーでエラーが発生

```bash
# .wranglerディレクトリを削除して再起動
rm -rf .wrangler
npm run dev
```

### デプロイ時にエラーが発生

```bash
# ログインし直す
npx wrangler logout
npx wrangler login

# 再デプロイ
npm run deploy
```

## 次のステップ

Phase 1が完了したら、以下の機能を実装していきます：

### Phase 2: 認証と画像
- Google OAuth実装
- R2で画像アップロード機能
- 投稿フォームのUI
- 編集フォーム

### Phase 3: 高度な機能
- Markdown spoiler拡張（`||text||`）
- 画像spoiler（ぼかし+クリック表示）
- 検索機能
- ページネーション

### Phase 4: 最適化
- パフォーマンス最適化
- SEO対策
- アクセシビリティ改善

## サポート

問題が発生した場合は、以下を確認してください：

- Cloudflare Workers ドキュメント: https://developers.cloudflare.com/workers/
- Cloudflare D1 ドキュメント: https://developers.cloudflare.com/d1/
- Wrangler ドキュメント: https://developers.cloudflare.com/workers/wrangler/
