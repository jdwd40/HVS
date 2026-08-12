// Generic agent adapter. runAgent executes a named task with a payload and
// returns a structured result. Mock implementations only — deterministic,
// offline, no paid calls.
import crypto from 'node:crypto';

function seededScore(seedText) {
  const h = crypto.createHash('sha256').update(String(seedText)).digest();
  return 0.5 + (h[0] / 255) * 0.5; // 0.50 .. 1.00 deterministic
}

const agents = {
  // Score a batch of generated candidates and pick the AI-preferred one.
  async 'candidate-scout'({ candidateIds, prompt }) {
    const scored = candidateIds.map((id, i) => ({
      id,
      aiScore: Number(seededScore(`${prompt}::${id}::${i}`).toFixed(3)),
    }));
    scored.sort((a, b) => b.aiScore - a.aiScore);
    return { scored, selectedId: scored[0]?.id ?? null };
  },

  // Expand a shot description into image/video prompts.
  async 'prompt-smith'({ title, description }) {
    const base = `${title}${description ? ' — ' + description : ''}`;
    return {
      imagePrompt: `Cinematic still: ${base}`.slice(0, 300),
      videoPrompt: `Slow push-in motion shot: ${base}`.slice(0, 300),
    };
  },
};

export async function runAgent(name, payload) {
  const agent = agents[name];
  if (!agent) throw new Error(`unknown agent: ${name}`);
  return agent(payload);
}

export function listAgents() {
  return Object.keys(agents);
}
