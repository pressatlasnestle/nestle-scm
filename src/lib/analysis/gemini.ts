import { getStageModel, type AnalysisClient, type AnalysisStage } from "./models";

/**
 * The Gemini transport shared by both analysis stages.
 *
 * Every call here is structured-output: the caller supplies a JSON schema and
 * gets back a parsed object, because both engines write their results straight
 * into typed columns and a prose reply would have to be scraped. Gemini's
 * responseSchema enforces the shape server-side, so the failure mode is an
 * explicit API error rather than a parse that half-works.
 *
 * The API key comes from the Vault-backed get_integration_secret() RPC, which
 * is granted to service_role ONLY (migration 0019). Everything in this
 * directory therefore has to run with the admin client — a user-scoped client
 * gets a permission error, by design.
 */

const ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Generous: a cold model can take a while, and the caller is already async. */
const REQUEST_TIMEOUT_MS = 30_000;

/** 429s and 5xx are retried; everything else fails immediately. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;

export type JsonSchema = Record<string, unknown>;

export type GenerateJsonOptions = {
  /** Persona + rules. Sent as systemInstruction, not folded into the prompt. */
  system: string;
  /** The per-article payload. */
  prompt: string;
  /** Enforced server-side via generationConfig.responseSchema. */
  schema: JsonSchema;
};

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
};

/** Loads the Vault-backed Gemini key. service_role only — see migration 0019. */
async function loadApiKey(client: AnalysisClient): Promise<string> {
  const { data, error } = await client.rpc("get_integration_secret", {
    p_provider: "gemini",
  });
  if (error) {
    throw new Error(`Could not read the Gemini key: ${error.message}`);
  }
  if (!data) {
    throw new Error("No Gemini key is set. Add it under Integrations → Gemini.");
  }
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One structured-output call. Resolves the stage's model from app_settings on
 * every invocation — see getStageModel() for why that is not cached.
 */
export async function generateJson<T>(
  client: AnalysisClient,
  stage: AnalysisStage,
  options: GenerateJsonOptions
): Promise<T> {
  const [apiKey, model] = await Promise.all([
    loadApiKey(client),
    getStageModel(client, stage),
  ]);

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: options.system }] },
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: options.schema,
      // Deterministic on purpose: two runs over the same article should not
      // disagree, or the flagged/confirmed split becomes impossible to audit.
      temperature: 0,
    },
  });

  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(
        `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          cache: "no-store",
          signal: controller.signal,
          body,
        }
      );

      const payload = (await res.json().catch(() => null)) as GeminiResponse | null;

      if (!res.ok) {
        const detail = payload?.error?.message ?? `${res.status} ${res.statusText}`;
        // A wrong model id is the single most likely misconfiguration here, and
        // it is worth naming explicitly — the model is admin-editable, so the
        // fix is in the UI, not the code.
        if (res.status === 404) {
          throw new Error(
            `Gemini rejected the model "${model}" (404). Check the ${stage} model id under Integrations → Gemini. ${detail}`
          );
        }
        if (res.status === 429 || res.status >= 500) {
          lastError = detail;
          if (attempt < MAX_ATTEMPTS) {
            await sleep(RETRY_BASE_MS * attempt);
            continue;
          }
        }
        throw new Error(`Gemini error (${res.status}): ${detail}`);
      }

      if (payload?.promptFeedback?.blockReason) {
        throw new Error(
          `Gemini blocked the prompt: ${payload.promptFeedback.blockReason}`
        );
      }

      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const finish = payload?.candidates?.[0]?.finishReason;
        throw new Error(
          `Gemini returned no content${finish ? ` (finishReason: ${finish})` : ""}.`
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Gemini returned unparseable JSON: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An abort is a timeout; treat it like a 5xx and retry.
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort && attempt < MAX_ATTEMPTS) {
        lastError = `timed out after ${REQUEST_TIMEOUT_MS}ms`;
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw new Error(isAbort ? `Gemini request ${lastError}` : message);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Gemini failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

/**
 * Runs `worker` over `items` at a bounded concurrency, collecting per-item
 * outcomes rather than rejecting on the first failure. Both engines process
 * batches of articles where one bad row must not abandon the rest — the same
 * reasoning that keeps one failing source from aborting an ingestion run.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<{ item: T; result: R | null; error: string | null }[]> {
  const out: { item: T; result: R | null; error: string | null }[] = new Array(
    items.length
  );
  let cursor = 0;

  async function pump(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      try {
        out[index] = { item, result: await worker(item), error: null };
      } catch (err) {
        out[index] = {
          item,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => pump())
  );

  return out;
}
