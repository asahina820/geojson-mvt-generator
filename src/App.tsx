import { useState } from 'react'
import type { FeatureCollection } from 'geojson'
import { FileDropzone } from './components/FileDropzone'
import { ProcessingScreen } from './components/ProcessingScreen'
import { ResultScreen } from './components/ResultScreen'
import { useConversionJob } from './hooks/useConversionJob'
import { parseGeoJSON, summarize, toLayerName } from './lib/geojson'
import type { ConversionOptions, GeoJSONSummary } from './types'

/** これより大きいファイルはブラウザでのパース（検証・プレビュー）をスキップする */
const PREVIEW_LIMIT_BYTES = 50 * 1024 * 1024

const DEFAULT_ZOOM = { minZoom: 0, maxZoom: 14 }

interface Selected {
  file: File
  geojson: FeatureCollection | null
  summary: GeoJSONSummary | null
  options: ConversionOptions
}

export default function App() {
  const [selected, setSelected] = useState<Selected | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const { state, start, reset, isMock } = useConversionJob()

  // ファイルを選んだらすぐに変換を始める
  const handleFile = async (file: File) => {
    setFileError(null)
    let geojson: FeatureCollection | null = null
    if (file.size <= PREVIEW_LIMIT_BYTES) {
      try {
        geojson = parseGeoJSON(await file.text())
      } catch (e) {
        setFileError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    const options = { layerName: toLayerName(file.name), ...DEFAULT_ZOOM }
    setSelected({ file, geojson, summary: geojson && summarize(geojson), options })
    start(file, options)
  }

  const backToUpload = () => {
    reset()
    setSelected(null)
  }

  const renderScreen = () => {
    if (!selected || state.phase === 'idle') {
      return (
        <section className="card">
          <h2 className="card-title">GeoJSON を MVT に変換</h2>
          <FileDropzone onFile={handleFile} />
          {fileError && <p className="error">{fileError}</p>}
        </section>
      )
    }
    if (state.phase === 'succeeded') {
      return (
        <ResultScreen
          file={selected.file}
          geojson={selected.geojson}
          summary={selected.summary}
          job={state.job}
          options={selected.options}
          isMock={isMock}
          onReset={backToUpload}
        />
      )
    }
    if (state.phase === 'failed') {
      return (
        <section className="card">
          <h2 className="card-title">変換に失敗しました</h2>
          <p className="muted file-name">{selected.file.name}</p>
          <p className="error">{state.error}</p>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => start(selected.file, selected.options)}
            >
              もう一度試す
            </button>
            <button type="button" className="button secondary" onClick={backToUpload}>
              別のファイルを選ぶ
            </button>
          </div>
        </section>
      )
    }
    return <ProcessingScreen fileName={selected.file.name} state={state} onCancel={backToUpload} />
  }

  return (
    <div className="app">
      <header className="header">
        <h1>GeoJSON → MVT</h1>
        {isMock && <span className="badge">モックモード</span>}
      </header>
      <main className={state.phase === 'succeeded' ? 'main' : 'main is-centered'}>
        {renderScreen()}
      </main>
    </div>
  )
}
