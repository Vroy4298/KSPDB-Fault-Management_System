# Decision Log — KSPDB Fault Management System

Log of key design decisions, trade-offs, documented assumptions, and future scope.

---

## Decision Log

### 1. Handling Missing Topology (The 60% Missing Data Challenge)
- **Context**: 60% of distribution transformers lack recorded pole line order (`parent_pole_id` / `seq_on_line` are null).
- **Decision**: Implemented a hybrid approach:
  1. For 40% of DTs with explicit wiring: Perform strict tree BFS walk to isolate exact span. Confidence = `HIGH`.
  2. For 60% of DTs with missing topology: Synthesize radial layout geometrically using pole GPS coordinates (nearest-neighbor distance calculation from DT location). If span cannot be uniquely isolated, bound the fault to candidate poles under the DT. Confidence = `MEDIUM` / `LOW`.
- **Rejected**: Requiring complete physical survey before shipping. In reality, asset digitisation takes months; the utility needs an operational tool today.

### 2. LLM / AI Placement in System
- **Context**: The candidate brief asked for appropriate placement of AI in the product, warning against using LLMs for graph fault localization.
- **Decision**: Placed the LLM (Groq Llama 3) strictly in the **Operator Intelligence & Summarizer** role. It converts complex telemetry vectors (pole IDs, household count, PIN, confidence metrics) into concise, 2-line executive natural language summaries for control room operators.
- **Rejected**: Using LLM for fault localization algorithm. Graph traversal is deterministic, instant, zero-cost, and 100% explainable; LLMs are non-deterministic and prone to hallucinating topology edges.

### 3. Telemetry Debouncing & Event Aggregation
- **Context**: On line fault, hundreds of pole devices report power loss simultaneously, causing telemetry bursts.
- **Decision**: Implemented a 20-second sliding debounce window (`DEBOUNCE_MS = 20,000`). Telemetry is buffered in memory before running localization, ensuring all downstream dark reports are grouped into a single ticket.
- **Rejected**: Processing every incoming packet synchronously without buffering, which led to temporary ticket fragmentation during rapid bursts.

### 4. Telemetry-Driven Ticket Auto-Verification
- **Context**: Field linemen often manually mark tickets as "Resolved" before power is fully restored.
- **Decision**: Ticket status transitions from `resolved` to `verified` strictly via incoming telemetry (`boot` / `power_restored` signals from 100% of affected poles). If a lineman attempts manual resolution while telemetry shows dark poles, the system displays a warning and blocks auto-closure.
- **Rejected**: Pure manual button-click closure without telemetry proof.

---

## Assumptions Made

1. **Substation & Feeder Structure**: Feeder outages shut down all distribution transformers downstream. Feeder IDs are always present in pole registry CSVs.
2. **Device Firmware Distribution**: ~8% of devices on firmware 1.2 are silent on outage. Silence exceeding 20 minutes is interpreted as dark power loss rather than device hardware failure if neighboring poles also report outages.
3. **PIN Codes**: Missing PIN codes (~3%) default to nearest pole PIN code or ward centroid.

---

## Future Scope (Two-Week Roadmap)

1. **Spatial Clustering (HDBSCAN/DBSCAN)**: For dense urban grids with unmapped topology, train spatial-temporal density clustering on historical outage patterns to automatically learn pole radial hierarchies.
2. **Offline GIS Layers**: Support offline GeoJSON maps for control room computers running on isolated air-gapped intranet networks.
3. **Multi-Subdivision Scaling**: Partition ingestion queues using Kafka / RabbitMQ to scale from 35,000 poles to 1,000,000+ poles across Karnataka state.

---

## Known Limitations

- **Simultaneous Faults on Same LT Line**: If two separate physical line breaks occur simultaneously on the exact same spur, the algorithm localizes the upstream break first. The downstream break becomes visible after the upstream span is restored.
