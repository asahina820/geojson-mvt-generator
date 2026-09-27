import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // maplibre-gl のワーカーは module worker として起動されるため ES 形式で出力する
  worker: { format: 'es' },
})
