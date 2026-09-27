import { randomUUID } from 'node:crypto'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { DescribeTasksCommand, ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const BUCKET = process.env.BUCKET!
const CLUSTER = process.env.CLUSTER!
const TASK_DEFINITION = process.env.TASK_DEFINITION!
const CONTAINER_NAME = process.env.CONTAINER_NAME!
const SUBNETS = process.env.SUBNETS!.split(',')
const SECURITY_GROUPS = process.env.SECURITY_GROUPS!.split(',')

const URL_EXPIRES_SEC = 60 * 60
/** S3 の単一 PUT の上限 */
const MAX_FILE_SIZE = 5 * 1024 ** 3
const UPLOAD_CONTENT_TYPE = 'application/geo+json'

const s3 = new S3Client({})
const ecs = new ECSClient({})

type JobStatus = 'WAITING_UPLOAD' | 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED'

/** S3 の jobs/{jobId}/job.json に保存するジョブ情報 */
interface JobRecord {
  jobId: string
  fileName: string
  fileSize: number
  layerName: string
  minZoom: number
  maxZoom: number
  status: JobStatus
  taskArn?: string
  error?: string
  createdAt: string
  updatedAt: string
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

/** ジョブごとにフォルダを分け、複数の変換でファイル名が衝突しないようにする */
const keys = {
  job: (id: string) => `jobs/${id}/job.json`,
  input: (id: string) => `jobs/${id}/input.geojson`,
  output: (id: string) => `jobs/${id}/output.zip`,
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// ---- S3 ----

async function loadJob(jobId: string): Promise<JobRecord> {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new HttpError(404, 'ジョブが見つかりません')
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keys.job(jobId) }))
    return JSON.parse(await res.Body!.transformToString()) as JobRecord
  } catch (e) {
    if (e instanceof NoSuchKey) throw new HttpError(404, 'ジョブが見つかりません')
    throw e
  }
}

async function saveJob(job: JobRecord): Promise<void> {
  job.updatedAt = new Date().toISOString()
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: keys.job(job.jobId),
      Body: JSON.stringify(job),
      ContentType: 'application/json',
    }),
  )
}

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch (e) {
    if (e instanceof NotFound) return false
    throw e
  }
}

// ---- 入力チェック ----

function parseCreateInput(body: string | undefined) {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(body ?? '')
  } catch {
    throw new HttpError(400, 'リクエストが JSON ではありません')
  }
  const { fileName, fileSize, layerName, minZoom, maxZoom } = input
  const isZoom = (z: unknown): z is number => Number.isInteger(z) && (z as number) >= 0 && (z as number) <= 22

  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 255) {
    throw new HttpError(400, 'fileName が不正です')
  }
  if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > MAX_FILE_SIZE) {
    throw new HttpError(400, 'ファイルサイズは 5GB までです')
  }
  if (typeof layerName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(layerName)) {
    throw new HttpError(400, 'layerName は英数字・_・- のみ使用できます')
  }
  if (!isZoom(minZoom) || !isZoom(maxZoom) || minZoom > maxZoom) {
    throw new HttpError(400, 'ズームは 0〜22 で、minZoom <= maxZoom にしてください')
  }
  return { fileName, fileSize, layerName, minZoom, maxZoom }
}

// ---- ルート ----

/** POST /jobs: ジョブを作成し、GeoJSON アップロード用の Presigned URL を返す */
async function createJob(event: APIGatewayProxyEventV2) {
  const input = parseCreateInput(event.body)
  const now = new Date().toISOString()
  const job: JobRecord = {
    ...input,
    jobId: randomUUID(),
    status: 'WAITING_UPLOAD',
    createdAt: now,
    updatedAt: now,
  }
  await saveJob(job)

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: keys.input(job.jobId),
      ContentType: UPLOAD_CONTENT_TYPE,
    }),
    { expiresIn: URL_EXPIRES_SEC },
  )
  return json(201, {
    jobId: job.jobId,
    uploadUrl,
    uploadHeaders: { 'Content-Type': UPLOAD_CONTENT_TYPE },
  })
}

/** POST /jobs/{jobId}/start: アップロード済みの GeoJSON で Fargate タスクを起動する */
async function startJob(jobId: string) {
  const job = await loadJob(jobId)
  if (job.status !== 'WAITING_UPLOAD') return json(200, await toResponse(job))

  if (!(await exists(keys.input(jobId)))) {
    throw new HttpError(400, 'GeoJSON がまだアップロードされていません')
  }

  const res = await ecs.send(
    new RunTaskCommand({
      cluster: CLUSTER,
      taskDefinition: TASK_DEFINITION,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNETS,
          securityGroups: SECURITY_GROUPS,
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: CONTAINER_NAME,
            environment: [
              { name: 'INPUT_S3', value: `s3://${BUCKET}/${keys.input(jobId)}` },
              { name: 'OUTPUT_S3', value: `s3://${BUCKET}/${keys.output(jobId)}` },
              { name: 'LAYER_NAME', value: job.layerName },
              { name: 'MIN_ZOOM', value: String(job.minZoom) },
              { name: 'MAX_ZOOM', value: String(job.maxZoom) },
            ],
          },
        ],
      },
      // startedBy は 36 文字まで。コンソールでジョブとタスクを対応付けやすくする
      startedBy: jobId,
    }),
  )

  const taskArn = res.tasks?.[0]?.taskArn
  if (!taskArn) {
    const reason = res.failures?.map((f) => f.reason).join(', ') || '不明なエラー'
    job.status = 'FAILED'
    job.error = `タスクを起動できませんでした: ${reason}`
  } else {
    job.status = 'QUEUED'
    job.taskArn = taskArn
  }
  await saveJob(job)
  return json(200, await toResponse(job))
}

/** 実行中のジョブについて ECS タスクの状態を反映する */
async function refreshStatus(job: JobRecord): Promise<void> {
  if (!job.taskArn || (job.status !== 'QUEUED' && job.status !== 'PROCESSING')) return

  const res = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [job.taskArn] }))
  const task = res.tasks?.[0]
  let next: Pick<JobRecord, 'status' | 'error'>

  if (!task) {
    // 停止したタスクは一定時間で参照できなくなる。成果物があれば成功とみなす
    next = (await exists(keys.output(job.jobId)))
      ? { status: 'SUCCEEDED' }
      : { status: 'FAILED', error: 'タスクの情報が見つかりません' }
  } else if (task.lastStatus === 'STOPPED') {
    const container = task.containers?.find((c) => c.name === CONTAINER_NAME)
    if (container?.exitCode === 0) {
      next = { status: 'SUCCEEDED' }
    } else {
      const detail =
        container?.reason ??
        (container?.exitCode !== undefined ? `終了コード ${container.exitCode}` : task.stoppedReason)
      next = { status: 'FAILED', error: `変換に失敗しました${detail ? `（${detail}）` : ''}` }
    }
  } else if (['PROVISIONING', 'PENDING', 'ACTIVATING'].includes(task.lastStatus ?? '')) {
    next = { status: 'QUEUED' }
  } else {
    next = { status: 'PROCESSING' }
  }

  if (next.status !== job.status) {
    Object.assign(job, next)
    await saveJob(job)
  }
}

async function toResponse(job: JobRecord) {
  const res: Record<string, unknown> = { jobId: job.jobId, status: job.status }
  if (job.error) res.error = job.error
  if (job.status === 'SUCCEEDED') {
    const zipName = `${job.fileName.replace(/\.(geo)?json$/i, '')}.zip`
    res.downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: keys.output(job.jobId),
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      }),
      { expiresIn: URL_EXPIRES_SEC },
    )
  }
  return res
}

/** GET /jobs/{jobId}: ジョブの状態を返す */
async function getJob(jobId: string) {
  const job = await loadJob(jobId)
  await refreshStatus(job)
  return json(200, await toResponse(job))
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const jobId = event.pathParameters?.jobId ?? ''
    switch (event.routeKey) {
      case 'POST /jobs':
        return await createJob(event)
      case 'POST /jobs/{jobId}/start':
        return await startJob(jobId)
      case 'GET /jobs/{jobId}':
        return await getJob(jobId)
      default:
        return json(404, { message: 'Not Found' })
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.statusCode, { message: e.message })
    console.error(e)
    return json(500, { message: 'サーバーエラーが発生しました' })
  }
}
