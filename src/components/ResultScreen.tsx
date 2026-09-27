import type { FeatureCollection } from 'geojson'
import { formatBytes } from '../lib/geojson'
import type { ConversionOptions, GeoJSONSummary, Job } from '../types'
import { MapPreview } from './MapPreview'

interface Props {
  file: File
  geojson: FeatureCollection | null
  summary: GeoJSONSummary | null
  job: Job
  options: ConversionOptions
  isMock: boolean
  onReset: () => void
}

export function ResultScreen({ file, geojson, summary, job, options, isMock, onReset }: Props) {
  return (
    <div className="result">
      <aside className="panel">
        <div>
          <p className="status-done">✓ 変換完了</p>
          <h2 className="file-name">{file.name}</h2>
        </div>

        <dl className="summary">
          <dt>サイズ</dt>
          <dd>{formatBytes(file.size)}</dd>
          {summary && (
            <>
              <dt>フィーチャ数</dt>
              <dd>{summary.featureCount.toLocaleString()}</dd>
              <dt>ジオメトリ</dt>
              <dd>
                {Object.entries(summary.geometryTypes)
                  .map(([t, n]) => `${t} (${n.toLocaleString()})`)
                  .join(', ')}
              </dd>
            </>
          )}
          <dt>レイヤー名</dt>
          <dd className="mono">{options.layerName}</dd>
          <dt>ズーム</dt>
          <dd>
            {options.minZoom} – {options.maxZoom}
          </dd>
        </dl>

        {job.tileUrl && (
          <label className="field">
            <span>タイル URL</span>
            <input type="text" readOnly value={job.tileUrl} onFocus={(e) => e.target.select()} />
          </label>
        )}

        <div className="actions">
          {job.downloadUrl && (
            <a className="button" href={job.downloadUrl} download>
              タイルをダウンロード
            </a>
          )}
          <button type="button" className="button secondary" onClick={onReset}>
            別のファイルを変換
          </button>
        </div>

        {isMock && <p className="muted">モックモードのため、実際のタイルは生成されていません。</p>}
        <p className="muted mono">Job ID: {job.jobId}</p>
      </aside>

      <MapPreview
        geojson={geojson}
        bbox={summary?.bbox ?? null}
        tileUrl={job.tileUrl}
        layerName={options.layerName}
        minZoom={options.minZoom}
        maxZoom={options.maxZoom}
      />
    </div>
  )
}
