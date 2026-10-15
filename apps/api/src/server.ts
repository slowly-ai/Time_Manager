import cors from 'cors'
import express from 'express'
import morgan from 'morgan'

const app = express()
const port = Number(process.env.PORT ?? 4000)

app.use(cors())
app.use(express.json())
app.use(morgan('tiny'))

app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'tempo-api', now: new Date().toISOString() }))
app.post('/api/v1/sync/push', (req, res) => res.json({ accepted: req.body?.operations?.length ?? 0, conflicts: [] }))
app.get('/api/v1/sync/pull', (req, res) => res.json({ cursor: String(req.query.cursor ?? '0'), operations: [] }))

app.listen(port, () => console.log(`Tempo API listening on http://localhost:${port}`))
