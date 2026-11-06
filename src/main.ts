import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db.js'

const config = loadConfig()
const db = createDb({ app: config.databaseUrlApp, auth: config.databaseUrlAuth })
const app = buildApp(config, db)

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  await db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ host: config.host, port: config.port })
