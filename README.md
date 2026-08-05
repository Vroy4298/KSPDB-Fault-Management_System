# KSPDB Fault Management System

A real-time fault detection and management system for electricity distribution networks, featuring AI-powered incident summarisation, live operator console, and automated ticket management.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│              Render Cloud               │
│                                         │
│  ┌──────────┐   ┌──────────┐   ┌──────┐ │
│  │ Frontend │──▶│ Backend  │──▶│  DB  │ │
│  │  nginx   │   │ Node.js  │   │ PG16 │ │
│  │  :80     │   │  :3000   │   │      │ │
│  └──────────┘   └──────────┘   └──────┘ │
└─────────────────────────────────────────┘
```

- **Frontend**: React + Vite, served by nginx (Web Service — Docker)
- **Backend**: Express + Socket.io (Web Service — Docker)
- **Database**: PostgreSQL 16 (Render managed)

---

## 🚀 Deploying to Render

### Prerequisites
- GitHub account with this repo pushed
- [Render account](https://render.com) (free tier works)
- Groq API key (optional — for AI summaries, get one free at [console.groq.com](https://console.groq.com/keys))

---

### Step 1 — Create PostgreSQL Database

1. Go to [Render Dashboard](https://dashboard.render.com) → **New +** → **PostgreSQL**
2. Fill in:
   | Field | Value |
   |-------|-------|
   | Name | `kspdb-db` |
   | Database | `kspdb` |
   | User | `kspdb_user` |
   | Region | Choose closest to your users |
   | Plan | **Free** |
3. Click **Create Database**
4. Once created, copy the **Internal Database URL** — you'll need it in Step 2.

---

### Step 2 — Deploy the Backend

1. **New +** → **Web Service**
2. Connect your GitHub repo
3. Configure:
   | Field | Value |
   |-------|-------|
   | Name | `kspdb-backend` |
   | Region | Same as DB |
   | Branch | `main` |
   | Root Directory | `backend` |
   | Runtime | **Docker** |
   | Dockerfile Path | `./Dockerfile` |
   | Plan | **Free** |

4. Under **Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | *(paste Internal Database URL from Step 1)* |
   | `GROQ_API_KEY` | *(your Groq key, or leave blank)* |
   | `GROQ_MODEL` | `llama3-8b-8192` |
   | `HEARTBEAT_TIMEOUT_MS` | `1200000` |
   | `DEBOUNCE_MS` | `20000` |

5. Click **Create Web Service**
6. Wait for the build to complete (3-5 min first time)
7. Copy the backend URL — it looks like `https://kspdb-backend.onrender.com`

---

### Step 3 — Deploy the Frontend

1. **New +** → **Web Service**
2. Connect your GitHub repo
3. Configure:
   | Field | Value |
   |-------|-------|
   | Name | `kspdb-frontend` |
   | Region | Same as backend |
   | Branch | `main` |
   | Root Directory | `frontend` |
   | Runtime | **Docker** |
   | Dockerfile Path | `./Dockerfile.render` |
   | Plan | **Free** |

4. Under **Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `BACKEND_URL` | *(the backend URL from Step 2, e.g. `https://kspdb-backend.onrender.com`)* |

5. Click **Create Web Service**
6. Wait for build (4-6 min first time)
7. Your app is live at `https://kspdb-frontend.onrender.com`

---

## 🔄 Running Locally (Docker Compose)

```bash
# Copy env file
cp .env.example .env
# Edit .env and set your GROQ_API_KEY

# Start all services
docker compose up --build

# Frontend → http://localhost:5173
# Backend  → http://localhost:3000/api/health
```

## 🔄 Running Locally (Dev Mode)

```bash
# Terminal 1 — Backend
cd backend
npm install
# Create .env with DATABASE_URL pointing to a local postgres
npm run dev

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev
# Opens at http://localhost:5173
```

---

## 📋 Environment Variables Reference

### Backend
| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `NODE_ENV` | `production` | Node environment |
| `PORT` | `3000` | HTTP port |
| `GROQ_API_KEY` | — | Groq API key for AI summaries (optional) |
| `GROQ_MODEL` | `llama3-8b-8192` | Groq model to use |
| `HEARTBEAT_TIMEOUT_MS` | `1200000` | Silence threshold before pole flagged dark (ms) |
| `DEBOUNCE_MS` | `20000` | Wait time before raising fault ticket (ms) |

### Frontend (Docker — Render)
| Variable | Description |
|----------|-------------|
| `BACKEND_URL` | Full URL of the backend service (e.g. `https://kspdb-backend.onrender.com`) |

---

## 🩺 Health Check

```
GET /api/health
```
Returns `{ status: "ok", db: "connected", uptime: <seconds> }`

---

## Notes on Render Free Tier

- Free services spin down after 15 min of inactivity — first request after sleep takes ~30s
- Free PostgreSQL databases expire after 90 days — upgrade to a paid plan for production
- WebSockets work on Render (they support HTTP upgrade headers)