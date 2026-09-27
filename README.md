# geojson-mvt-generator

ブラウザから GeoJSON をアップロードすると、AWS 上で [tippecanoe](https://github.com/felt/tippecanoe) を使って MVT（Mapbox Vector Tiles）に変換し、ZIP でダウンロードできるツールです。

一言でいうと **「大きめの GeoJSON を AWS 上で MVT に変換するバッチ処理基盤」と、それを操作するフロントエンド** です。
ユーザーからは AWS は見えず、「ファイルを選ぶ → 待つ → ダウンロード」だけで使えます。

## 全体構成

```text
[ブラウザ] React + Vite
   │
   ├─ ① ③ ④ API 呼び出し ───────▶ [API Gateway] ──▶ [Lambda]  api/
   │                                                  │
   │                                                  ├─ job.json の読み書き ──▶ [S3]
   │                                                  └─ ECS RunTask ─────────▶ [ECS / Fargate]
   │
   ├─ ② GeoJSON を直接 PUT（Presigned URL）─────────────────────────────────▶ [S3]
   │
   └─ ⑤ ZIP を直接 GET（Presigned URL）◀──────────────────────────────────── [S3]


[ECS / Fargate]  Docker コンテナ（mvt-docker/）
   │  convert.sh
   │   ├─ AWS CLI     input.geojson を S3 から取得
   │   ├─ tippecanoe  MVT を生成
   │   ├─ zip         タイルをまとめる
   │   └─ AWS CLI     output.zip を S3 へ
   │
   ├─ イメージの取得元 ──▶ [ECR]
   └─ ログの送信先 ────▶ [CloudWatch Logs]


[S3]（非公開）
   jobs/{jobId}/
   ├── job.json        ジョブの状態
   ├── input.geojson   アップロードされた入力
   └── output.zip      変換結果


AWS の構成はすべて Terraform（terraform/）で管理
```

### ポイント

- **ブラウザに AWS の権限を持たせない**
  フロントエンドが呼ぶのは自分たちの API だけです。ECS の起動などの強い権限は Lambda だけが持ちます。
  ブラウザにアクセスキーを埋め込むと抜き取られるためです。
- **大きいファイルは API を通さない**
  GeoJSON 本体は Presigned URL（期限付きの署名付き URL）で S3 に直接アップロードします。
  API Gateway / Lambda にはサイズ上限があるため、ファイル本体は受け取らず URL を発行するだけにしています。
- **ジョブごとに S3 のフォルダを分ける**
  `jobs/{jobId}/` に入力・出力をまとめるので、複数人が同時に変換してもファイル名が衝突しません。
- **Docker イメージと Task Definition は使い回す**
  入力・出力のパスやズームは RunTask 時に環境変数で上書きして渡します。

## 処理の流れ

| # | 誰が | 何をする | 画面 |
| --- | --- | --- | --- |
| ① | フロントエンド → Lambda | `POST /jobs` でジョブを作成。Lambda は jobId を発行し、`job.json` を保存して、アップロード用の Presigned URL を返す | アップロード中… |
| ② | フロントエンド → S3 | Presigned URL に GeoJSON を `PUT`（API を経由しない） | アップロード中… |
| ③ | フロントエンド → Lambda → ECS | `POST /jobs/{jobId}/start` で Lambda が ECS RunTask を呼び、Fargate タスクを起動 | 変換中… |
| — | Fargate | `convert.sh` が GeoJSON を取得 → tippecanoe で MVT 生成 → ZIP 化 → S3 に `output.zip` を置く | 変換中… |
| ④ | フロントエンド → Lambda | 2 秒ごとに `GET /jobs/{jobId}`。Lambda が ECS のタスク状態を確認し、完了ならダウンロード用 Presigned URL を返す | 変換中… → 変換完了 |
| ⑤ | フロントエンド → S3 | ダウンロードボタンで `output.zip` を取得 | 変換完了 |

ジョブの状態は次のように進みます。

```text
WAITING_UPLOAD ──(start)──▶ QUEUED ──▶ PROCESSING ──┬──▶ SUCCEEDED
                                                    └──▶ FAILED
```

| status | 意味 |
| --- | --- |
| `WAITING_UPLOAD` | ジョブ作成済み、アップロード待ち |
| `QUEUED` | Fargate タスクの起動待ち |
| `PROCESSING` | 変換中 |
| `SUCCEEDED` | 完了（`downloadUrl` を返す） |
| `FAILED` | 失敗（`error` を返す） |

`GET /jobs/{jobId}` が呼ばれるたびに、Lambda が ECS のタスク状態（`DescribeTasks`）を確認して `job.json` を更新します。

## 各コンポーネントの役割

| コンポーネント | 役割 | 場所 |
| --- | --- | --- |
| フロントエンド | アップロード・進捗表示・プレビュー・ダウンロード | `src/` |
| API Gateway (HTTP API) | ブラウザからの入口。CORS と流量制限（5 req/s）もここで設定 | `terraform/api.tf` |
| Lambda | ジョブ作成、Presigned URL の発行、ECS タスクの起動と状態確認 | `api/` |
| S3 | 入力 GeoJSON・変換結果 ZIP・ジョブ情報の置き場（非公開） | `terraform/main.tf` |
| ECR | Docker イメージ（`mvt-generator-worker:latest`）の置き場 | `terraform/main.tf` |
| ECS Cluster | Fargate タスクを動かす枠 | `terraform/main.tf` |
| Task Definition | 「どのイメージを、どの CPU・メモリ・アーキテクチャ・権限で動かすか」の実行設定書 | `terraform/main.tf` |
| Fargate | Task Definition に従って実際にコンテナを動かす計算環境（サーバー管理不要） | — |
| CloudWatch Logs | コンテナと Lambda のログ置き場（7 日保持） | `terraform/main.tf`, `api.tf` |
| Terraform | 上記 AWS 構成をコードで管理 | `terraform/` |

### Docker コンテナの中身

```text
Ubuntu 24.04
├── tippecanoe   GeoJSON → MVT 変換
├── AWS CLI      S3 からの取得・S3 へのアップロード
├── zip          タイルを 1 ファイルにまとめる
└── convert.sh   処理本体
```

`convert.sh` は次の処理を行います。

```text
S3 から GeoJSON を取得（$INPUT_S3）
  ↓
tippecanoe で MVT を生成（$LAYER_NAME, $MIN_ZOOM, $MAX_ZOOM）
  ↓
{z}/{x}/{y}.pbf
  ↓
ZIP 化
  ↓
S3 へアップロード（$OUTPUT_S3）
```

環境変数は Lambda が RunTask 時に渡します。Task Definition のリソースは 2 vCPU / メモリ 4GB / ディスク 50GB です。

### IAM Role は 3 つ

| Role | 誰が使うか | できること |
| --- | --- | --- |
| Task Role（`mvt-generator-ecs-task-role`） | コンテナ内の `convert.sh` | S3 の読み書き |
| Execution Role（`mvt-generator-ecs-execution-role`） | ECS 自身 | ECR からイメージ取得、CloudWatch へログ送信 |
| API Role（`mvt-generator-api-role`） | Lambda | S3 の読み書き、ECS タスクの起動・状態確認、上記 2 つの Role をタスクに渡す |

Task Role があるので、コンテナにアクセスキーを埋め込まなくても `aws s3 cp` が使えます。

### ARM64 で統一している

Apple Silicon の Mac でビルドしたイメージは ARM64 になるため、全部を ARM64 に揃えています。

```text
Mac でビルドした Docker イメージ   ARM64
イメージ内の AWS CLI              ARM64（awscli-exe-linux-aarch64）
Fargate Task                     ARM64（Task Definition の runtime_platform）
```

どれかがずれると、Fargate で `Exec format error` になって失敗します。

## ディレクトリ構成

```text
.
├── src/            フロントエンド（React + Vite）
├── api/            Lambda（TypeScript → esbuild で dist/index.mjs に 1 ファイル化）
├── mvt-docker/     変換用 Docker イメージ（dockerfile, convert.sh）
└── terraform/      AWS 構成
    ├── provider.tf
    ├── variables.tf
    ├── main.tf     S3, ECR, ECS, Task Definition, IAM, CloudWatch
    ├── api.tf      API Gateway, Lambda, S3 CORS, セキュリティグループ
    └── outputs.tf
```

## セットアップ

### 1. AWS にログイン

```sh
aws sso login --profile <プロファイル名>
export AWS_PROFILE=<プロファイル名>
aws sts get-caller-identity   # root ではないことを確認
```

### 2. Lambda をビルド

Terraform が `api/dist/index.mjs` を zip にしてデプロイするので、先にビルドしておきます。

```sh
cd api
npm install
npm run build
```

### 3. AWS の構成を作る

S3 のバケット名は世界で一意である必要があります。

```sh
cd terraform
terraform init
terraform plan  -var="bucket_name=<一意のバケット名>"
terraform apply -var="bucket_name=<一意のバケット名>"
```

`terraform.tfstate` には作成した AWS リソースの情報が入っています。Git には含めず（`.gitignore` 済み）、削除しないでください。

### 4. Docker イメージを ECR に push

```sh
cd mvt-docker
ECR_URL=$(terraform -chdir=../terraform output -raw ecr_repository_url)

aws ecr get-login-password | docker login --username AWS --password-stdin "${ECR_URL%%/*}"
docker build -f dockerfile -t mvt-worker .
docker tag mvt-worker:latest "${ECR_URL}:latest"
docker push "${ECR_URL}:latest"
```

### 5. フロントエンドを起動

```sh
npm install
echo "VITE_API_BASE_URL=$(terraform -chdir=terraform output -raw api_url)" > .env.local
npm run dev
```

http://localhost:5173 を開きます。API と S3 の CORS は `http://localhost:5173` のみ許可しているので、ポートを変えた場合や別のオリジンで公開する場合は `allowed_origins` 変数を変更してください。

### コードを変更したとき

| 変更したもの | やること |
| --- | --- |
| `api/` | `npm run build` → `terraform apply` |
| `mvt-docker/` | `docker build` → `docker push`（次に起動するタスクから反映） |
| `terraform/` | `terraform plan` → `terraform apply` |
| `.env.local` | dev サーバーを再起動 |

## ローカル開発（モックモード）

`VITE_API_BASE_URL` が未設定だと **モックモード** で動き、AWS なしで画面の流れを確認できます（画面右上に「モックモード」と表示）。
ファイル名に `fail` を含めると失敗パターンになります。

## 動作確認・トラブルシュート

- **コンテナのログ**：CloudWatch Logs の `/ecs/mvt-generator-worker`
  `Downloading input...` → `Generating MVT...` → `Packaging...` → `Uploading output...` → `Done!` と出れば成功です。
- **Lambda のログ**：CloudWatch Logs の `/aws/lambda/mvt-generator-api`
- **タスクの状態**：ECS コンソール → `mvt-generator-cluster` → タスク（停止済みタスクも一定時間は残ります）
- **成果物**：S3 の `jobs/{jobId}/output.zip`

## API 仕様

### `POST /jobs`

ジョブを作成し、GeoJSON アップロード用の Presigned URL を返します。

```json
// リクエスト
{
  "fileName": "sample.geojson",
  "fileSize": 123456,
  "layerName": "sample",
  "minZoom": 0,
  "maxZoom": 14
}

// レスポンス
{
  "jobId": "230f0ab3-f5ff-4b50-95d3-d8b4ac6e6f5a",
  "uploadUrl": "https://<bucket>.s3.ap-northeast-1.amazonaws.com/jobs/230f.../input.geojson?X-Amz-...",
  "uploadHeaders": { "Content-Type": "application/geo+json" }
}
```

- フロントエンドは `uploadUrl` に `uploadHeaders` を付けて `PUT` します
- ファイルサイズは 5GB まで（S3 の単一 PUT の上限）、`layerName` は英数字・`_`・`-`、ズームは 0〜22

### `POST /jobs/{jobId}/start`

アップロード完了後に呼び、ECS RunTask で変換を開始します。レスポンスは `GET /jobs/{jobId}` と同じ形式です。

### `GET /jobs/{jobId}`

```json
{
  "jobId": "230f0ab3-f5ff-4b50-95d3-d8b4ac6e6f5a",
  "status": "SUCCEEDED",
  "downloadUrl": "https://<bucket>.s3.ap-northeast-1.amazonaws.com/jobs/230f.../output.zip?X-Amz-...",
  "error": "..."
}
```

- `downloadUrl` は `SUCCEEDED` のとき、`error` は `FAILED` のときだけ返します
- Presigned URL の有効期限はアップロード用・ダウンロード用とも 1 時間
- フロントエンドは 2 秒間隔で最大 15 分ポーリングします
- フロントエンドは `progress`（0〜100）と `tileUrl`（`{z}/{x}/{y}.pbf` のテンプレート）にも対応していますが、今の API は返していません

## 今の制限と今後

- **API に認証がない**：URL を知っていれば誰でも Fargate を起動できます（流量制限のみ）。学習用以外で使うなら認証が必要です。
- **プレビューは元の GeoJSON**：タイルは ZIP の中にあり配信 URL がないため、完了画面の地図はアップロードした GeoJSON を表示します。MVT で表示するにはタイル配信（CloudFront など）を追加し、`tileUrl` を返す必要があります。tippecanoe はタイルを gzip 圧縮するので、配信時は `Content-Encoding: gzip` が必要です。
- **ズームは 0〜14 固定**：画面にはアップロードだけを置いているため、ズームを変える UI はありません（API は対応済み）。
- **S3 のファイルは自動削除されない**：必要ならライフサイクルルールで `jobs/` を一定期間後に削除します。
