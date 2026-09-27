# mvt-generator-frontend

GeoJSON をアップロードして MVT（Mapbox Vector Tiles）に変換するツールのフロントエンドです。
変換処理は AWS 側で行い、このリポジトリはフロントエンドのみを管理します。

```text
Frontend (S3 + CloudFront)
  │  POST /jobs, POST /jobs/{id}/start, GET /jobs/{id}
  ▼
API Gateway → Lambda（api/）→ ECS RunTask → Fargate（mvt-docker/, tippecanoe）→ S3（jobs/{jobId}/output.zip）
  ▲
  │  GeoJSON は Presigned URL で S3 に直接 PUT
Frontend
```

## 開発

```sh
npm install
npm run dev
```

`VITE_API_BASE_URL` が未設定の場合は **モックモード** で動作し、バックエンドなしで UI の一連の流れを確認できます。
ファイル名に `fail` を含めると失敗パターンになります。

実 API に接続する場合は `.env.local` を作って API の URL を設定します（dev サーバーの再起動が必要）。

```sh
echo "VITE_API_BASE_URL=$(terraform -chdir=terraform output -raw api_url)" > .env.local
```

## API 仕様（フロントエンドが期待するもの）

### `POST /jobs`

ジョブを作成し、GeoJSON アップロード用の Presigned URL を返す。

リクエスト:

```json
{
  "fileName": "sample.geojson",
  "fileSize": 123456,
  "layerName": "sample",
  "minZoom": 0,
  "maxZoom": 14
}
```

レスポンス:

```json
{
  "jobId": "a1b2c3",
  "uploadUrl": "https://bucket.s3.amazonaws.com/uploads/a1b2c3.geojson?X-Amz-...",
  "uploadHeaders": { "Content-Type": "application/geo+json" }
}
```

- フロントエンドは `uploadUrl` に対して `uploadHeaders` を付けて `PUT` する（省略時は `Content-Type: application/geo+json`）

### `POST /jobs/{jobId}/start`

アップロード完了後に呼び、ECS RunTask で変換（Fargate）を開始する。レスポンスは `GET /jobs/{jobId}` と同じ形式。

### `GET /jobs/{jobId}`

```json
{
  "jobId": "a1b2c3",
  "status": "PROCESSING",
  "progress": 42,
  "tileUrl": "https://xxxx.cloudfront.net/tiles/a1b2c3/{z}/{x}/{y}.pbf",
  "downloadUrl": "https://...",
  "error": "..."
}
```

| status           | 意味                       |
| ---------------- | -------------------------- |
| `WAITING_UPLOAD` | アップロード待ち           |
| `QUEUED`         | Fargate タスク起動待ち     |
| `PROCESSING`     | 変換中                     |
| `SUCCEEDED`      | 完了（`tileUrl` / `downloadUrl` を返す） |
| `FAILED`         | 失敗（`error` を返す）     |

- `progress`, `tileUrl`, `downloadUrl`, `error` は任意
- `tileUrl` を返すと、完了後に地図上で MVT をプレビューする（`source-layer` は `layerName`）
- フロントエンドは 2 秒間隔で最大 15 分ポーリングする

### CORS

- API Gateway: フロントエンドのオリジンから `POST` / `GET` を許可
- アップロード用 S3 バケット: `PUT` と `Content-Type` ヘッダーを許可
- タイル配信（CloudFront / S3）: `GET` を許可

## デプロイ

`main` への push で [.github/workflows/deploy.yml](.github/workflows/deploy.yml) が走り、ビルド結果を S3 に配置して CloudFront のキャッシュを無効化します。

GitHub リポジトリに以下を設定してください。

| 種類     | 名前                         | 内容                                    |
| -------- | ---------------------------- | --------------------------------------- |
| Secret   | `AWS_ROLE_ARN`               | GitHub OIDC で AssumeRole する IAM ロール |
| Variable | `AWS_REGION`                 | 例: `ap-northeast-1`                    |
| Variable | `S3_BUCKET`                  | フロントエンド配信用バケット名          |
| Variable | `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront ディストリビューション ID    |
| Variable | `VITE_API_BASE_URL`          | API Gateway のベース URL                |
