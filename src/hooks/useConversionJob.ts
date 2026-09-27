import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ConversionOptions, Job } from '../types'

const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 15 * 60 * 1000

export type ConversionState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'uploading'; jobId: string; progress: number }
  | { phase: 'processing'; job: Job }
  | { phase: 'succeeded'; job: Job }
  | { phase: 'failed'; error: string; jobId?: string }

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

/**
 * 変換フロー:
 *   1. POST /jobs でジョブを作成し、S3 の署名付き URL を受け取る
 *   2. 署名付き URL に GeoJSON を PUT
 *   3. POST /jobs/{jobId}/start で変換（ECS タスク）を開始
 *   4. GET /jobs/{jobId} を完了/失敗までポーリング
 */
export function useConversionJob() {
  const [state, setStateRaw] = useState<ConversionState>({ phase: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)

  const abort = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const reset = useCallback(() => {
    abort()
    setStateRaw({ phase: 'idle' })
  }, [abort])

  const start = useCallback(
    async (file: File, options: ConversionOptions) => {
      abort()
      const controller = new AbortController()
      controllerRef.current = controller
      const { signal } = controller
      let jobId: string | undefined
      // 中断・再実行された古いフローからの更新は無視する
      const setState = (next: ConversionState) => {
        if (controllerRef.current === controller) setStateRaw(next)
      }

      try {
        setState({ phase: 'creating' })
        const created = await api.createJob(
          { ...options, fileName: file.name, fileSize: file.size },
          signal,
        )
        jobId = created.jobId

        setState({ phase: 'uploading', jobId, progress: 0 })
        await api.upload(
          created,
          file,
          (progress) => setState({ phase: 'uploading', jobId: created.jobId, progress }),
          signal,
        )

        const startedJob = await api.startJob(jobId, signal)
        const deadline = Date.now() + POLL_TIMEOUT_MS
        setState({ phase: 'processing', job: startedJob })
        while (Date.now() < deadline) {
          const job = await api.getJob(jobId, signal)
          if (job.status === 'SUCCEEDED') {
            setState({ phase: 'succeeded', job })
            return
          }
          if (job.status === 'FAILED') {
            setState({ phase: 'failed', jobId, error: job.error ?? '変換に失敗しました' })
            return
          }
          setState({ phase: 'processing', job })
          await wait(POLL_INTERVAL_MS, signal)
        }
        setState({ phase: 'failed', jobId, error: '変換がタイムアウトしました' })
      } catch (e) {
        if (isAbort(e)) return
        setState({ phase: 'failed', jobId, error: e instanceof Error ? e.message : String(e) })
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null
      }
    },
    [abort],
  )

  // アンマウント時に進行中の処理を止める
  useEffect(() => abort, [abort])

  return { state, start, cancel: reset, reset, isMock: api.isMock }
}
