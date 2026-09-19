/**
 * Retrieval.
 *
 * This is lexical: overlap scoring over the campaign's knowledge chunks, with
 * a boost for chunk types that matter to the step being run. It is not
 * embedding search and the UI does not call it one.
 *
 * That is a deliberate trade, not a shortcut. Embedding search needs a vector
 * column, an embedding provider and a backfill job; lexical retrieval over a
 * few hundred chunks runs inside the Postgres that is already there and
 * returns in single-digit milliseconds. `retrieveForStep` hands back the chunk
 * objects themselves, and the caller stores their ids on the agent run, so a
 * prospect's timeline can show which source material produced which sentence.
 * Swapping in pgvector later means replacing `score` and nothing else.
 */
import { supabase, unwrapSoft } from '../db/client.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'you', 'your', 'our', 'their', 'has', 'have', 'had', 'not', 'but', 'can',
  'will', 'would', 'should', 'about', 'into', 'over', 'they', 'them', 'its',
  'who', 'what', 'when', 'where', 'which', 'than', 'then', 'there', 'been',
]);

function tokenise(text) {
  if (!text) return [];
  const flat = typeof text === 'string' ? text : JSON.stringify(text);
  return flat
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Which chunk types are worth most to each step of the pipeline. */
const TYPE_PRIORITY = {
  research: ['icp_definition', 'persona'],
  icp_fitment: ['icp_definition', 'persona'],
  outreach_strategy: ['playbook', 'sequence', 'icp_definition'],
  personalisation: ['case_study', 'example_email', 'product', 'playbook', 'brand_voice'],
  conversation: ['objection_handling', 'faq', 'playbook', 'competitor'],
};

function score(chunk, queryTokens, preferredTypes) {
  const chunkTokens = tokenise(`${chunk.title ?? ''} ${chunk.content ?? ''}`);
  if (chunkTokens.length === 0) return 0;

  const chunkSet = new Set(chunkTokens);
  let overlap = 0;
  for (const t of queryTokens) if (chunkSet.has(t)) overlap += 1;

  const preferred = preferredTypes.includes(chunk.type);
  if (overlap === 0 && !preferred) return 0;

  // Normalise by length so a long document does not win on volume alone.
  const lengthNorm = 1 / Math.log2(chunkTokens.length + 2);
  const typeBoost = preferred ? 1.6 : 1;

  return overlap * lengthNorm * typeBoost;
}

async function chunksFor(campaignId) {
  const query = supabase
    .from('knowledge_chunks')
    .select('id, campaign_id, type, title, content, created_at');

  const res = campaignId
    ? await query.or(`campaign_id.eq.${campaignId},campaign_id.is.null`)
    : await query.is('campaign_id', null);

  return unwrapSoft(res, [], 'knowledge_chunks');
}

/**
 * @returns {Promise<Array<{id,type,title,content,score,scope}>>}
 */
export async function retrieveForStep({ campaignId, agentName, context, limit = 4 }) {
  const chunks = await chunksFor(campaignId);
  if (!chunks.length) return [];

  const queryTokens = tokenise(context);
  const preferred = TYPE_PRIORITY[agentName] ?? [];

  return chunks
    .map((c) => ({ ...c, score: Number(score(c, queryTokens, preferred).toFixed(4)) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title ?? c.type ?? 'knowledge chunk',
      content: c.content,
      score: c.score,
      scope: c.campaign_id ? 'campaign' : 'global',
    }));
}

export async function listKnowledge(campaignId = null) {
  let query = supabase
    .from('knowledge_chunks')
    .select('id, campaign_id, type, title, content, created_at')
    .order('created_at', { ascending: false });

  if (campaignId) query = query.or(`campaign_id.eq.${campaignId},campaign_id.is.null`);

  return unwrapSoft(await query, [], 'knowledge_chunks').map((c) => ({
    id: c.id,
    campaign_id: c.campaign_id,
    scope: c.campaign_id ? 'campaign' : 'global',
    type: c.type,
    title: c.title ?? 'Untitled',
    content: c.content,
    excerpt: (c.content ?? '').length > 200 ? `${c.content.slice(0, 200).trimEnd()}…` : c.content ?? '',
    word_count: (c.content ?? '').split(/\s+/).filter(Boolean).length,
    created_at: c.created_at,
  }));
}

export async function addKnowledge({ campaignId = null, type = 'note', title, content }) {
  const { data, error } = await supabase
    .from('knowledge_chunks')
    .insert({ campaign_id: campaignId, type, title, content })
    .select()
    .single();
  if (error) throw new Error(`knowledge insert: ${error.message}`);
  return data;
}

export async function deleteKnowledge(id) {
  const { data, error } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`knowledge delete: ${error.message}`);
  return data;
}
