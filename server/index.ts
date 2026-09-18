import { serve } from '@hono/node-server'
import { loadConfig } from './config.ts'
import { createApp } from './app.ts'

const config = loadConfig()
const app = createApp(config)

serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Reunion server listening on port ${info.port}`)
})
