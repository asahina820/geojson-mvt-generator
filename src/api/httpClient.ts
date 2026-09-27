import type { ConversionApi } from './client'

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.message ?? `API エラー (${res.status})`)
  }
  return res.json() as Promise<T>
}

/** S3 署名付き URL への PUT。fetch ではアップロード進捗が取れないため XHR を使う */
function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v))

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`アップロードに失敗しました (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('アップロード中にネットワークエラーが発生しました'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })

    xhr.send(file)
  })
}

export function createHttpClient(baseUrl: string): ConversionApi {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    isMock: false,
    createJob: (input, signal) =>
      request(`${base}/jobs`, { method: 'POST', body: JSON.stringify(input), signal }),
    upload: (job, file, onProgress, signal) =>
      putWithProgress(
        job.uploadUrl,
        file,
        job.uploadHeaders ?? { 'Content-Type': 'application/geo+json' },
        onProgress,
        signal,
      ),
    startJob: (jobId, signal) =>
      request(`${base}/jobs/${encodeURIComponent(jobId)}/start`, { method: 'POST', signal }),
    getJob: (jobId, signal) =>
      request(`${base}/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', signal }),
  }
}
