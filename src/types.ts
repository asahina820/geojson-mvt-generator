/** ユーザーが指定する変換オプション */
export interface ConversionOptions {
  /** MVT 内のレイヤー名（source-layer） */
  layerName: string
  minZoom: number
  maxZoom: number
}

/** バックエンド（AWS）側のジョブ状態 */
export type JobStatus =
  | 'WAITING_UPLOAD'
  | 'QUEUED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'

/** POST /jobs のレスポンス */
export interface CreateJobResponse {
  jobId: string
  /** S3 への署名付き PUT URL */
  uploadUrl: string
  /** 署名に含めたヘッダー（Content-Type など）。PUT 時にそのまま付与する */
  uploadHeaders?: Record<string, string>
}

/** GET /jobs/{jobId} のレスポンス */
export interface Job {
  jobId: string
  status: JobStatus
  /** 0〜100。バックエンドが返せる場合のみ */
  progress?: number
  /** タイル URL テンプレート（例: https://cdn.example.com/tiles/{jobId}/{z}/{x}/{y}.pbf） */
  tileUrl?: string
  /** 成果物一式（zip / PMTiles など）のダウンロード URL */
  downloadUrl?: string
  error?: string
}

/** クライアント側で GeoJSON を解析した結果 */
export interface GeoJSONSummary {
  featureCount: number
  geometryTypes: Record<string, number>
  /** [minLng, minLat, maxLng, maxLat]。座標がない場合は null */
  bbox: [number, number, number, number] | null
  propertyKeys: string[]
}
