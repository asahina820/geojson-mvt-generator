import type { ConversionOptions, CreateJobResponse, Job } from '../types'

export interface CreateJobInput extends ConversionOptions {
  fileName: string
  fileSize: number
}

/**
 * 変換バックエンドとのインターフェース。
 * 本番は API Gateway + Lambda + S3、ローカルではモック実装を使う。
 */
export interface ConversionApi {
  readonly isMock: boolean
  createJob(input: CreateJobInput, signal?: AbortSignal): Promise<CreateJobResponse>
  upload(
    job: CreateJobResponse,
    file: File,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<void>
  /** アップロード完了後に変換（ECS タスク）を開始する */
  startJob(jobId: string, signal?: AbortSignal): Promise<Job>
  getJob(jobId: string, signal?: AbortSignal): Promise<Job>
}
