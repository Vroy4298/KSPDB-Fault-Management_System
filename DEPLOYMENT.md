# Deployment Guide — KSPDB Fault Management System

This guide covers running the system locally using Docker Compose or deploying to production on Render.

---

## 1. Prerequisites

- **Docker Desktop** (v24.0+) & Docker Compose
- **Node.js** (v18+) *(for local development without Docker)*
- **PostgreSQL** (v16+) *(for local development without Docker)*

---

## 2. Quickstart (One Command Docker Compose)

To launch the complete application stack (Frontend, Backend, and PostgreSQL database) with seeded synthetic network data:

```bash
# 1. Clone repository
git clone <your-repo-url>
cd KSPDB-Fault-Management_System

# 2. Copy environment variables
cp .env.example .env

# 3. Start stack with Docker Compose
docker compose up --build
```

- **Frontend Console**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:3000/api/health](http://localhost:3000/api/health)

---

## 3. Environment Variables Reference

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | Express HTTP server port |
| `NODE_ENV` | `production` | No | Environment mode (`development` / `production`) |
| `DATABASE_URL` | `postgres://kspdb_user:kspdb_pass@db:5432/kspdb` | Yes | PostgreSQL connection URI |
| `GROQ_API_KEY` | `""` | No | Optional API key for LLM summaries ([console.groq.com](https://console.groq.com)) |
| `GROQ_MODEL` | `llama3-8b-8192` | No | LLM model identifier |
| `HEARTBEAT_TIMEOUT_MS` | `1200000` | No | Silence window before flagging fw 1.2 poles dark (ms) |
| `DEBOUNCE_MS` | `20000` | No | Telemetry aggregation window before raising tickets (ms) |
| `VITE_BACKEND_URL` | `http://localhost:3000` | No | Backend URL used by frontend |

---

## 4. Deploying to Cloud (Render Free Tier)

### Step A — PostgreSQL Database
1. Go to [Render Dashboard](https://dashboard.render.com) -> **New +** -> **PostgreSQL**.
2. Name: `kspdb-db`, Database: `kspdb`, User: `kspdb_user`, Plan: **Free**.
3. Copy the **Internal Database URL**.

### Step B — Backend Service
1. **New +** -> **Web Service** -> Connect GitHub Repo.
2. Root Directory: `backend`, Runtime: `Docker`, Dockerfile Path: `./Dockerfile`.
3. Add Environment Variables:
   - `DATABASE_URL`: *(pasted Internal Database URL)*
   - `NODE_ENV`: `production`
   - `GROQ_API_KEY`: *(your key or blank)*

### Step C — Frontend Service
1. **New +** -> **Web Service** -> Connect GitHub Repo.
2. Root Directory: `frontend`, Runtime: `Docker`, Dockerfile Path: `./Dockerfile.render`.
3. Add Environment Variable:
   - `BACKEND_URL`: `https://kspdb-backend.onrender.com`

---

## 5. Deployment Troubleshooting Section

| Symptom / Failure Mode | Cause | Resolution / Fix |
|-----------------------|-------|------------------|
| **Database Connection Refused** | PostgreSQL container still booting when backend starts | Handled by `waitForDB()` in `server.js` with exponential backoff retry. |
| **Port Conflict (3000/5173 in use)** | Local process occupying default ports | Change `PORT` in `.env` or set `PORT=3001 docker compose up`. |
| **WebSocket Disconnections on Cloud** | Reverse proxy dropping long-lived HTTP connections | Express & Socket.io use polling fallback + explicit HTTP Upgrade headers supported on Render. |
| **Cold-Start Delay (~30s)** | Render free tier spins down inactive web services after 15 min | Expected behavior on free tier. README clearly notes 30s warmup notice. |
| **CORS Error on Ingest/Tickets** | Frontend origin missing from CORS headers | Backend defaults to wildcard `cors({ origin: '*' })` for evaluation ease. |

---

## 6. How to Reset to Clean State

To wipe all tickets, restore all poles back to `energized = true`, and re-seed clean synthetic network topology:

```bash
# Using the UI:
Click on the "Simulator" tab -> Click "Reset System / Clear Faults"

# Using cURL:
curl -X POST http://localhost:3000/api/simulator/reset
```
