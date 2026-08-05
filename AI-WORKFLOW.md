# AI Workflow & Leverage Document

This document details how AI tooling was utilized during the development of the KSPDB Fault Management System.

---

## 1. AI Tools Utilized

- **Antigravity / Gemini 3.6 Flash**: Core architecture planning, backend Node.js route design, React + Leaflet map integration, data seeding logic, and Docker configuration.
- **Groq Cloud API (Llama 3 8B)**: Runtime LLM integration for live control room incident summarization.

---

## 2. Delegation & Ownership Breakdown

| Task Area | Strategy | AI Contribution | Human Oversight & Engineering |
|-----------|----------|-----------------|-------------------------------|
| **DB Schema & Seeds** | Delegated | Generated synthetic data schema matching schemas in `02-data-and-systems.md` | Verified foreign key relationships and proportions (~9% no device, ~60% missing topology). |
| **Fault Localization Engine** | Collaborative | Drafted BFS graph boundary walking logic | Authored missing topology geometric estimation fallback & isolated sensor fault suppression. |
| **Operator UI (React/Leaflet)** | Delegated | Generated Leaflet map components, CSS dark theme, ticket sidebar | Reviewed responsive layout, map pin tooltips, WebSocket event state handlers. |
| **Docker & Deployment** | Delegated | Created multi-stage Dockerfile and `docker-compose.yml` | Validated DB container initialization race condition & environment variable passing. |

---

## 3. Concrete Cases of AI Misdirections / Hallucinations Caught

### Case 1: LLM for Graph Localization
- **Initial AI Proposal**: The AI assistant initially suggested feeding raw telemetry JSON arrays directly into an LLM prompt to identify failed line spans.
- **Why it was wrong**: LLMs are non-deterministic, expensive, slow (>1.5s latency per prompt), and prone to hallucinating non-existent pole IDs.
- **Correction**: Rejected LLM for localization. Built a deterministic graph BFS algorithm (<5ms execution) in pure JavaScript and relegated LLM exclusively to generating human-friendly incident summaries.

### Case 2: Naive Synchronous Telemetry Processing
- **Initial AI Proposal**: The AI generated telemetry ingest handlers that executed DB transactions immediately on every incoming POST request.
- **Why it was wrong**: Under 5,000-message outage bursts, DB connection pool exhausted and created race conditions resulting in 40 duplicate tickets for a single snapped wire.
- **Correction**: Replaced immediate DB writing with an in-memory sliding debounce queue (`DEBOUNCE_MS = 20,000ms`) before running localization.

---

## 4. Code Generation Estimate

- **~75% AI-Generated Code**: Boilerplate Express routes, React components, CSS styling, seed data scripts, Docker setup.
- **~25% Manually Written / Refactored Logic**: BFS boundary detection logic, silent watchdog timeout logic, telemetry auto-verification rules, missing topology spatial fallback.

---

## 5. Exemplary Prompts Used

> *"Design a deterministic BFS boundary-walking algorithm for a radial electrical distribution tree in Node.js. Inputs are node states (energized true/false). Identify the exact edge span (parent pole live, child pole dark). Include fallback logic when parent_pole_id is missing by calculating spatial distance."*

> *"Write a Dockerfile and Docker Compose setup for Node.js + Express + React + PostgreSQL 16 that supports one-command startup (`docker compose up --build`), automatically waits for PG DB health, and executes idempotent schema migrations and synthetic seeding."*
