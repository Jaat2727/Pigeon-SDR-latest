/**
 * Knowledge: the source material personalisation is allowed to draw on, and a
 * preview of what retrieval would actually return for a given query.
 *
 * The preview is there because "grounded in your knowledge base" is a claim,
 * and a claim you can check in two clicks is worth more than one you cannot.
 */
import express from 'express';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { listKnowledge, addKnowledge, deleteKnowledge, retrieveForStep } from '../services/knowledge.js';
import { logActivity } from '../services/activity.js';
import { PIPELINE } from '../agents/registry.js';

const router = express.Router();

const TYPES = [
  'product', 'brand_voice', 'case_study', 'example_email', 'playbook',
  'objection_handling', 'faq', 'competitor', 'icp_definition', 'persona', 'note',
];

router.get('/types', (req, res) => res.json(TYPES));

/** GET /knowledge?campaignId= */
router.get('/', asyncHandler(async (req, res) => {
  res.json(await listKnowledge(req.query.campaignId || null));
}));

/** POST /knowledge */
router.post('/', asyncHandler(async (req, res) => {
  const { campaignId = null, type = 'note', title, content } = req.body ?? {};

  if (!content?.trim()) throw badRequest('A knowledge chunk needs content');
  if (!TYPES.includes(type)) throw badRequest(`Unknown type "${type}"`);

  const row = await addKnowledge({
    campaignId,
    type,
    title: title?.trim() || null,
    content: content.trim(),
  });

  await logActivity({
    campaignId,
    agentName: 'system',
    action: 'Added knowledge',
    detail: `${title?.trim() || type} is now available to personalisation.`,
    status: 'success',
  });

  res.status(201).json(row);
}));

/** DELETE /knowledge/:id */
router.delete('/:id', asyncHandler(async (req, res) => {
  const row = await deleteKnowledge(req.params.id);
  if (!row) throw notFound('No such knowledge chunk');
  res.json({ deleted: row.id });
}));

/**
 * POST /knowledge/preview
 * Runs retrieval for a query and shows what came back and why, without
 * calling an agent or writing anything.
 */
router.post('/preview', asyncHandler(async (req, res) => {
  const { campaignId = null, query, agentName = 'personalisation', limit = 5 } = req.body ?? {};
  if (!query?.trim()) throw badRequest('A preview needs a query');

  const step = PIPELINE.includes(agentName) || agentName === 'conversation' ? agentName : 'personalisation';
  const results = await retrieveForStep({ campaignId, agentName: step, context: query, limit });

  res.json({
    query,
    agent: step,
    method: 'lexical',
    note:
      'Retrieval is lexical: term overlap, normalised for chunk length, with a boost for chunk ' +
      'types that matter to this step. It is not embedding search.',
    results,
  });
}));

export default router;
