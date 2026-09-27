import type { Job } from '../types'
import type { ConversionApi } from './client'

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

/**
 * バックエンド未構築時に UI を確認するためのモック。
 * アップロード → 変換開始 → キュー待ち → 変換中 → 完了 の流れを時間経過で再現する。
 * ファイル名に "fail" を含めると失敗パターンになる。
 */
export function createMockClient(): ConversionApi {
  const jobs = new Map<string, { startedAt: number; shouldFail: boolean }>()

  return {
    isMock: true,
    async createJob(input, signal) {
      await sleep(300, signal)
      const jobId = crypto.randomUUID()
      jobs.set(jobId, { startedAt: 0, shouldFail: /fail/i.test(input.fileName) })
      return { jobId, uploadUrl: `mock://upload/${jobId}` }
    },
    async upload(_job, _file, onProgress, signal) {
      for (let p = 0; p <= 100; p += 10) {
        onProgress(p)
        await sleep(120, signal)
      }
    },
    async startJob(jobId, signal) {
      await sleep(200, signal)
      const entry = jobs.get(jobId)
      if (!entry) throw new Error('ジョブが見つかりません')
      entry.startedAt = Date.now()
      return { jobId, status: 'QUEUED' }
    },
    async getJob(jobId, signal) {
      await sleep(150, signal)
      const entry = jobs.get(jobId)
      if (!entry) throw new Error('ジョブが見つかりません')
      if (!entry.startedAt) return { jobId, status: 'WAITING_UPLOAD' }

      const elapsed = Date.now() - entry.startedAt
      if (elapsed < 1500) return { jobId, status: 'QUEUED' }

      const progress = Math.min(100, Math.round(((elapsed - 1500) / 3500) * 100))
      if (entry.shouldFail && progress > 40) {
        return { jobId, status: 'FAILED', error: 'tippecanoe の実行に失敗しました（モック）' }
      }
      if (progress < 100) return { jobId, status: 'PROCESSING', progress }

      // モックでは実タイルがないため tileUrl は返さない
      const job: Job = { jobId, status: 'SUCCEEDED', progress: 100 }
      return job
    },
  }
}
