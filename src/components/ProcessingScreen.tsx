import type { ConversionState } from '../hooks/useConversionJob'

interface Props {
  fileName: string
  state: ConversionState
  onCancel: () => void
}

const STEPS = ['アップロード', '変換待ち', '変換中'] as const

function currentStep(state: ConversionState): number {
  if (state.phase === 'processing') return state.job.status === 'PROCESSING' ? 2 : 1
  return 0
}

function progressOf(state: ConversionState): number | undefined {
  if (state.phase === 'uploading') return state.progress
  if (state.phase === 'processing') return state.job.progress
  return undefined
}

export function ProcessingScreen({ fileName, state, onCancel }: Props) {
  const step = currentStep(state)
  const progress = progressOf(state)

  return (
    <section className="card" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <h2 className="card-title">{step === 0 ? 'アップロード中…' : '変換中…'}</h2>
      <p className="muted file-name">{fileName}</p>

      <ol className="steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i < step ? 'done' : i === step ? 'active' : undefined}>
            {label}
          </li>
        ))}
      </ol>

      <div
        className={`bar${progress === undefined ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-valuenow={progress !== undefined ? Math.round(progress) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: progress !== undefined ? `${progress}%` : undefined }} />
      </div>

      <button type="button" className="button secondary" onClick={onCancel}>
        キャンセル
      </button>
    </section>
  )
}
