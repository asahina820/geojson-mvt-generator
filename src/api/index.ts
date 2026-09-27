import { createHttpClient } from './httpClient'
import { createMockClient } from './mockClient'

const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined

/** VITE_API_BASE_URL が未設定ならモックで動かす */
export const api = baseUrl ? createHttpClient(baseUrl) : createMockClient()
