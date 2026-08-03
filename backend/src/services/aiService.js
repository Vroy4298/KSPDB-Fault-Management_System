'use strict';

/**
 * aiService.js — NL Incident Summary via Groq (Llama 3)
 *
 * Generates a plain-language incident summary for operators using the Groq API.
 * This is POST-computation synthesis only — the localization engine runs
 * deterministic BFS first; the LLM only narrates the result.
 *
 * Design constraints (from AI-WORKFLOW.md):
 *  - LLM is NEVER used for fault detection logic
 *  - If Groq is unavailable (no key, rate limit, timeout): silently return null
 *    → UI falls back to structured fields, no crash, no degraded detection
 *  - Max latency budget: 8s (ticket creation is non-blocking)
 *
 * Prompt strategy: structured JSON → natural language for a field engineer.
 */

let groqClient = null;

function getGroqClient() {
  if (groqClient) return groqClient;
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const Groq = require('groq-sdk');
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    return groqClient;
  } catch {
    return null;
  }
}

/**
 * Generate a 2-3 sentence operator summary for a fault.
 * Returns null on any error (graceful degradation).
 *
 * @param {object} fault  Fault descriptor from localization engine
 * @returns {Promise<string|null>}
 */
async function summarizeFault(fault) {
  const client = getGroqClient();
  if (!client) return null;

  const faultContext = {
    type: fault.fault_type,
    confidence: fault.confidence,
    topology_mode: fault.topology_mode,
    affected_poles: fault.affected_poles,
    estimated_households: fault.estimated_households,
    location: {
      pincode: fault.pincode,
      ward: fault.ward,
      lat: fault.fault_lat?.toFixed(4),
      lon: fault.fault_lon?.toFixed(4),
    },
    upstream_pole: fault.upstream_pole_id,
    downstream_pole: fault.downstream_pole_id,
    dt_id: fault.dt_id,
    confidence_reason: fault.confidence_reason,
    scheduled_outage: fault.scheduled_outage
      ? `Scheduled outage ${fault.scheduled_outage.id} may be related.`
      : null,
  };

  const prompt = `You are a KSPDB control room assistant. A fault detection system has automatically located a power distribution fault. Write a 2-3 sentence summary for a field crew dispatcher — be specific, factual, and avoid jargon. Include location, impact, and any caveats about detection confidence.

Fault data:
${JSON.stringify(faultContext, null, 2)}

Summary:`;

  try {
    const response = await Promise.race([
      client.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama3-8b-8192',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Groq timeout')), 8000)
      ),
    ]);

    return response.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn('[AI] Summary generation failed (graceful degradation):', err.message);
    return null;
  }
}

module.exports = { summarizeFault };
