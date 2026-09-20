/** One function per endpoint. Nothing in the UI builds a URL by hand. */
import { get, post, patch, put, del } from './client.js';

const qs = (params) => {
  const entries = Object.entries(params ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

/* queue */
export const getQueue = (campaignId) => get(`/queue${qs({ campaignId })}`);
export const getActivity = (params) => get(`/queue/activity${qs(params)}`);
export const approve = (id, body) => post(`/queue/approvals/${id}/approve`, body);
export const reject = (id, body) => post(`/queue/approvals/${id}/reject`, body);
export const approveAndContinue = (id, body) => post(`/queue/approvals/${id}/approve-and-continue`, body);

/* campaigns */
export const listCampaigns = () => get('/campaigns');
export const getCampaign = (id) => get(`/campaigns/${id}`);
export const createCampaign = (body) => post('/campaigns', body);
export const updateCampaign = (id, body) => patch(`/campaigns/${id}`, body);
export const duplicateCampaign = (id, body) => post(`/campaigns/${id}/duplicate`, body ?? {});
export const deleteCampaign = (id, { keepProspects = true } = {}) => del(`/campaigns/${id}${qs({ keepProspects })}`);
export const getPrompts = (id) => get(`/campaigns/${id}/prompts`);
export const savePrompt = (id, agent, body) => put(`/campaigns/${id}/prompts/${agent}`, body);

/**
 * Run and discover both answer 202 with a job id rather than a result. The
 * work takes minutes; the request does not wait for it. Everything that calls
 * these should hand the job id to `useJob`.
 */
export const runCampaign = (id, body) => post(`/campaigns/${id}/run`, body ?? { limit: 5 });
export const discoverProspects = (id, body) => post(`/campaigns/${id}/discover`, body ?? {});
export const previewDiscovery = (id, body) => post(`/campaigns/${id}/discover/preview`, body ?? {});

/* jobs */
export const listJobs = (params) => get(`/jobs${qs(params)}`);
export const getJob = (id) => get(`/jobs/${id}`);
export const cancelJob = (id, body) => post(`/jobs/${id}/cancel`, body ?? {});

/* messages */
export const listMessages = (params) => get(`/messages${qs(params)}`);
export const getMessageStats = () => get('/messages/stats');

/* reps */
export const listReps = () => get('/reps');
export const createRep = (body) => post('/reps', body);
export const deleteRep = (id) => del(`/reps/${id}`);

/* prospects */
export const listProspects = (params) => get(`/prospects${qs(params)}`);
export const getProspect = (id) => get(`/prospects/${id}`);
export const addProspect = (body) => post('/prospects', body);
export const importProspects = (body) => post('/prospects/import', body);
export const advanceProspect = (id, body) => post(`/prospects/${id}/advance`, body);
export const sendReply = (id, body) => post(`/prospects/${id}/reply`, body);
export const pauseProspect = (id, body) => post(`/prospects/${id}/pause`, body);

/* agents */
export const listAgents = () => get('/agents');
export const getRouting = () => get('/agents/routing');
export const getAgentRuns = (id, params) => get(`/agents/${id}/runs${qs(params)}`);
export const getScenarios = (id) => get(`/agents/${id}/scenarios`);
export const pauseAgent = (id, body) => post(`/agents/${id}/pause`, body);
export const testAgent = (id, body) => post(`/agents/${id}/test`, body ?? {});
export const getKeys = () => get('/agents/keys');
export const getModels = () => get('/agents/models');
export const refreshModels = () => post('/agents/models/refresh', {});
export const reviveKeys = (body) => post('/agents/keys/revive', body ?? {});

/* knowledge */
export const listKnowledge = (campaignId) => get(`/knowledge${qs({ campaignId })}`);
export const knowledgeTypes = () => get('/knowledge/types');
export const addKnowledge = (body) => post('/knowledge', body);
export const deleteKnowledge = (id) => del(`/knowledge/${id}`);
export const previewRetrieval = (body) => post('/knowledge/preview', body);

/* controls */
export const getControls = () => get('/controls');
export const setKillSwitch = (body) => post('/controls/kill-switch', body);
export const setChannelPause = (body) => post('/controls/channel', body);
export const setCampaignPause = (body) => post('/controls/campaign', body);
export const listSuppression = () => get('/controls/suppression');
export const addSuppression = (body) => post('/controls/suppression', body);
export const removeSuppression = (id) => del(`/controls/suppression/${id}`);
export const testMailer = (body) => post('/controls/mailer/test', body ?? {});

/* health */
export const getSchemaHealth = () => get('/health/schema');
export const getProviderHealth = (probe = true) => get(`/health/providers${qs({ probe })}`);
