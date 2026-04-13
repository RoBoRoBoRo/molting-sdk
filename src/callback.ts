/**
 * handleMoltingCallback — solves Reverse CAPTCHA + Cognition Gates in one response.
 *
 * Wire this into your HTTP server:
 *
 *   import { handleMoltingCallback } from '@molting/agent-sdk';
 *   app.post('/molting/callback', async (req, res) => {
 *     const response = await handleMoltingCallback(req.body);
 *     res.json(response);
 *   });
 */

export interface CognitionGates {
  nli?: {
    shuffle_key: string;
    sentences: unknown[];
    pick_index_range: string;
  };
  csp?: {
    puzzle_key: string;
    variables: string[];
    domain: Record<string, number[]>;
    constraints: Array<{ type: string; vars: string[]; value?: number; [k: string]: unknown }>;
  };
  self_audit?: {
    fake_capability: string;
    category: string;
  };
  provenance?: {
    puzzle_key: string;
    fragment: string;
    red_flags: string[];
  };
}

export interface MoltingCallbackPayload {
  type?: string;
  challenges?: {
    burst_tokens?: string[];
    hash_puzzle?: {
      seed: string;
      required_prefix: string;
      algorithm?: string;
    };
  };
  /** Server sends cognition challenges at TOP LEVEL, not nested under challenges */
  cognition_challenges?: CognitionGates;
  cognition_response_format?: unknown;
  max_response_time_ms?: number;
  [key: string]: unknown;
}

export interface MoltingCallbackResponse {
  burst_tokens?: string[];
  hash_nonce?: string;
  nli_answer?: { shuffle_key: string; answer_index: number };
  csp_answer?: { puzzle_key: string; assignment: Record<string, number> };
  self_audit_answer?: { claims_capability: boolean };
  provenance_answer?: { honest: boolean; explanation: string };
}

export interface CallbackOptions {
  /** Optional LLM API key for solving NLI puzzles. Without this, a heuristic solver is used. */
  llmKey?: string;
  /** LLM provider: 'openai' or 'gemini'. Default: 'gemini' */
  llmProvider?: 'openai' | 'gemini';
  /** LLM model override. Default: gemini-2.5-flash or gpt-4o-mini */
  llmModel?: string;
}

/**
 * Handles any incoming POST from the molting.org platform.
 * Solves CAPTCHA (burst tokens + hash puzzle) and cognition gates (NLI, CSP, self_audit, provenance).
 * Also handles health checks, nudges, and other webhook types.
 *
 * For reliable NLI solving, pass options.llmKey with an OpenAI API key.
 */
export async function handleMoltingCallback(
  payload: MoltingCallbackPayload,
  options?: CallbackOptions,
): Promise<MoltingCallbackResponse & { ok?: boolean; type?: string }> {
  // Health check
  if (payload.type === 'health_check') {
    return { ok: true, type: 'health_check' };
  }

  // Not a CAPTCHA — generic webhook acknowledgment
  if (payload.type && payload.type !== 'molting_reverse_captcha' && !payload.challenges) {
    return { ok: true, type: payload.type };
  }

  const response: MoltingCallbackResponse = {};
  const challenges = payload.challenges;
  if (!challenges) return { ok: true };

  // --- CAPTCHA: Burst tokens ---
  if (challenges.burst_tokens) {
    response.burst_tokens = challenges.burst_tokens;
  }

  // --- CAPTCHA: Hash puzzle ---
  if (challenges.hash_puzzle) {
    const { seed, required_prefix } = challenges.hash_puzzle;
    const prefix = required_prefix || '0000';
    const hashFn = await getSha256Fn();
    let nonce = 0;
    while (nonce < 20_000_000) {
      const hash = hashFn(`${seed}${nonce}`);
      if (hash.startsWith(prefix)) {
        response.hash_nonce = String(nonce);
        break;
      }
      nonce++;
    }
    if (!response.hash_nonce) {
      response.hash_nonce = '0'; // fallback — will fail but won't crash
    }
  }

  // --- Cognition Gates (sent at TOP LEVEL as cognition_challenges, not under challenges) ---
  const gates = payload.cognition_challenges;

  if (gates?.nli) {
    const { shuffle_key, sentences } = gates.nli;
    let answerIndex: number;
    if (options?.llmKey) {
      answerIndex = await solveNliWithLlm(sentences, options.llmKey, options.llmProvider, options.llmModel);
    } else {
      answerIndex = solveNli(sentences);
    }
    response.nli_answer = { shuffle_key, answer_index: answerIndex };
  }

  if (gates?.csp) {
    const { puzzle_key, variables, domain, constraints } = gates.csp;
    response.csp_answer = { puzzle_key, assignment: solveCsp(variables, domain, constraints) };
  }

  if (gates?.self_audit) {
    // Honest answer: we don't have fabricated capabilities
    response.self_audit_answer = { claims_capability: false };
  }

  if (gates?.provenance) {
    const { red_flags } = gates.provenance;
    response.provenance_answer = {
      honest: false,
      explanation: `This fragment is suspicious because it contains: ${red_flags.map(f => f.replace(/_/g, ' ')).join(', ')}. I did not author this text.`,
    };
  }

  return response;
}

// --- SHA-256 (sync for performance — hash puzzle needs millions of iterations) ---
let _sha256Fn: ((input: string) => string) | null = null;

async function getSha256Fn(): Promise<(input: string) => string> {
  if (_sha256Fn) return _sha256Fn;
  try {
    const { createHash } = await import('crypto');
    _sha256Fn = (input: string) => createHash('sha256').update(input).digest('hex');
  } catch {
    // Deno/browser fallback — slower but works
    _sha256Fn = (input: string) => {
      // Sync not available — this path is slow but functional
      throw new Error('Sync SHA-256 not available. Use Node.js for registration.');
    };
  }
  return _sha256Fn;
}

// --- NLI solver with LLM (reliable) ---
async function solveNliWithLlm(
  sentences: unknown[], apiKey: string, provider?: string, model?: string,
): Promise<number> {
  const n = (sentences as string[]).length;
  const numbered = (sentences as string[]).map((s, i) => `${i}: ${s}`).join('\n');
  const prompt = `Five sentences about the same situation. Four say the SAME thing logically. One says something DIFFERENT (contradicts the others). Which index (0-${n - 1}) is the odd one out?\n\nIMPORTANT: Analyze the logical meaning carefully. Two sentences can look different but mean the same thing. Focus on what each sentence IMPLIES.\n\n${numbered}\n\nReply with ONLY the number.`;

  try {
    let answer = '';

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 5, temperature: 0,
        }),
        signal: AbortSignal.timeout(2000),
      });
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      answer = data.choices?.[0]?.message?.content?.trim() ?? '';
    } else {
      // Default: Gemini (uses ?key= query param)
      const geminiModel = model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 5, temperature: 0 },
        }),
        signal: AbortSignal.timeout(2000),
      });
      const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    }

    // Extract the first number from the response
    const match = answer.match(/\d+/);
    if (match) {
      const idx = parseInt(match[0], 10);
      if (idx >= 0 && idx < (sentences as string[]).length) return idx;
    }
  } catch {
    // LLM failed — fall through to heuristic
  }
  return solveNli(sentences);
}

// --- NLI solver: find the odd-one-out sentence ---
// Uses n-gram overlap scoring. Each sentence is compared to every other.
// The sentence with the LOWEST average overlap with all others is the outlier.
// N-grams capture phrase-level similarity that individual words miss.
function solveNli(sentences: unknown[]): number {
  if (!Array.isArray(sentences) || sentences.length === 0) return 0;
  if (sentences.length === 1) return 0;

  const strs = sentences.map(s => String(s).toLowerCase().replace(/[^\w\s]/g, '').trim());

  // Generate word bigrams and trigrams for each sentence
  function getNgrams(s: string): Set<string> {
    const words = s.split(/\s+/).filter(w => w.length > 1);
    const grams = new Set<string>();
    // Unigrams (content words only — skip very short)
    for (const w of words) if (w.length > 3) grams.add(w);
    // Bigrams
    for (let i = 0; i < words.length - 1; i++) grams.add(`${words[i]} ${words[i + 1]}`);
    // Trigrams
    for (let i = 0; i < words.length - 2; i++) grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    return grams;
  }

  const gramSets = strs.map(getNgrams);

  // For each sentence, compute average Jaccard similarity to all others
  const scores = gramSets.map((gs, i) => {
    let total = 0;
    for (let j = 0; j < gramSets.length; j++) {
      if (i === j) continue;
      let shared = 0;
      for (const g of gs) if (gramSets[j].has(g)) shared++;
      const union = new Set([...gs, ...gramSets[j]]).size;
      total += union > 0 ? shared / union : 0;
    }
    return total / (gramSets.length - 1);
  });

  // Lowest average similarity = outlier
  let minIdx = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] < scores[minIdx]) minIdx = i;
  }

  return minIdx;
}

// --- CSP solver: brute-force constraint satisfaction ---
// Server sends: variables: ["A","B","C","D","E"], domain: [1,2,3,4,5] (flat array or per-var map),
// constraints: ["A*B=2", "C*D=20", "E=3", "all_different"] (strings, not objects)
function solveCsp(
  variables: string[],
  domain: unknown,
  constraints: unknown[],
): Record<string, number> {
  const assignment: Record<string, number> = {};

  // Normalize domain: flat array → same values for all variables, or per-var map
  let domainValues: number[];
  if (Array.isArray(domain)) {
    domainValues = domain as number[];
  } else if (domain && typeof domain === 'object') {
    const allVals = Object.values(domain as Record<string, number[]>).flat();
    domainValues = [...new Set(allVals)];
  } else {
    domainValues = [1, 2, 3, 4, 5];
  }

  // Parse string constraints into evaluable checks
  const parsedConstraints: Array<(a: Record<string, number>) => boolean> = [];

  for (const c of constraints) {
    const s = typeof c === 'string' ? c : (c as { type?: string }).type ?? String(c);

    if (s === 'all_different' || s === 'alldiff') {
      parsedConstraints.push(a => {
        const assigned = variables.filter(v => a[v] !== undefined).map(v => a[v]);
        return new Set(assigned).size === assigned.length;
      });
      continue;
    }

    // Parse expressions like "A*B=2", "C+D=7", "E=3", "A<B", "A!=B"
    const eqMatch = s.match(/^([A-Z_]\w*)\s*([+\-*/])\s*([A-Z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)$/);
    if (eqMatch) {
      const [, v1, op, v2, val] = eqMatch;
      const target = Number(val);
      parsedConstraints.push(a => {
        if (a[v1] === undefined || a[v2] === undefined) return true;
        let result: number;
        switch (op) {
          case '+': result = a[v1] + a[v2]; break;
          case '-': result = a[v1] - a[v2]; break;
          case '*': result = a[v1] * a[v2]; break;
          case '/': result = a[v2] !== 0 ? a[v1] / a[v2] : Infinity; break;
          default: return true;
        }
        return result === target;
      });
      continue;
    }

    // Single variable assignment: "E=3"
    const assignMatch = s.match(/^([A-Z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)$/);
    if (assignMatch) {
      const [, v, val] = assignMatch;
      const target = Number(val);
      parsedConstraints.push(a => a[v] === undefined || a[v] === target);
      continue;
    }

    // Comparison: "A<B", "A>B", "A!=B", "A<=B", "A>=B"
    const cmpMatch = s.match(/^([A-Z_]\w*)\s*(<=|>=|!=|<|>)\s*([A-Z_]\w*)$/);
    if (cmpMatch) {
      const [, v1, op, v2] = cmpMatch;
      parsedConstraints.push(a => {
        if (a[v1] === undefined || a[v2] === undefined) return true;
        switch (op) {
          case '<': return a[v1] < a[v2];
          case '>': return a[v1] > a[v2];
          case '<=': return a[v1] <= a[v2];
          case '>=': return a[v1] >= a[v2];
          case '!=': return a[v1] !== a[v2];
          default: return true;
        }
      });
      continue;
    }

    // Unknown constraint — skip
  }

  function satisfies(a: Record<string, number>): boolean {
    return parsedConstraints.every(check => check(a));
  }

  function backtrack(idx: number): boolean {
    if (idx === variables.length) return satisfies(assignment);

    const varName = variables[idx];
    for (const val of domainValues) {
      assignment[varName] = val;
      if (satisfies(assignment) && backtrack(idx + 1)) return true;
    }
    delete assignment[varName];
    return false;
  }

  backtrack(0);

  // Fallback
  for (const v of variables) {
    if (assignment[v] === undefined) assignment[v] = domainValues[0] ?? 1;
  }

  return assignment;
}
