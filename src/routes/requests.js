import { Router } from 'express';
import { z } from 'zod';
import { Update, Request, REQUEST_TYPES, REQUEST_STATUSES } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { mediaUpload, filesFrom, deleteUploads } from '../middleware/upload.js';
import { loadProject, assertObjectId } from '../services/access.js';
import { notify } from '../services/notify.js';
import { validate, toBool, badRequest, forbidden, notFound } from '../utils/http.js';

const router = Router();
router.use(authenticate, requireRole('client', 'engineer'));

const DEFAULT_MESSAGES = {
  approval: 'Looks good. Approved this update.',
  call: 'Please give me a call.',
};
const TYPE_LABEL = { question: 'Question', change: 'Change request', approval: 'Approval', call: 'Call request' };
const STATUS_LABEL = { new: 'New', in_progress: 'In progress', done: 'Done' };

function populate(query) {
  return query
    .populate('client', 'name phone email avatarUrl')
    .populate('engineer', 'name phone email title avatarUrl')
    .populate('project', 'name location coverImage')
    .populate('update', 'date note photos');
}

function scopeFilter(actor) {
  return actor.role === 'engineer' ? { engineer: actor.doc._id } : { client: actor.doc._id };
}

async function loadRequest(actor, id) {
  assertObjectId(id, 'request id');
  const request = await Request.findById(id);
  if (!request) throw notFound('Request not found');
  const own = actor.role === 'engineer' ? request.engineer.toString() === actor.id : request.client.toString() === actor.id;
  if (!own) throw forbidden();
  return request;
}

// ---------- List ----------

/** Query: status (new|in_progress|done|open), projectId, updateId, type */
router.get('/', async (req, res) => {
  const filter = scopeFilter(req.actor);
  const { status, projectId, updateId, type } = req.query;
  if (status === 'open') filter.status = { $ne: 'done' };
  else if (REQUEST_STATUSES.includes(status)) filter.status = status;
  if (projectId) {
    assertObjectId(projectId, 'project id');
    filter.project = projectId;
  }
  if (updateId) {
    assertObjectId(updateId, 'update id');
    filter.update = updateId;
  }
  if (REQUEST_TYPES.includes(type)) filter.type = type;

  const requests = await populate(Request.find(filter).sort({ createdAt: -1 }).limit(200));
  const counts = await Request.aggregate([
    { $match: scopeFilter(req.actor) },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  res.json({
    requests: requests.map((r) => r.toJSON()),
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  });
});

// ---------- Create (client) ----------

const createSchema = z.object({
  projectId: z.string(),
  updateId: z.string().optional(),
  type: z.enum(REQUEST_TYPES),
  message: z.string().trim().max(300, 'Keep it under 300 characters').optional().default(''),
  urgent: z.preprocess(toBool, z.boolean()).optional().default(false),
});

router.post('/', requireRole('client'), mediaUpload, async (req, res) => {
  const photos = filesFrom(req, 'photos');
  const [voiceNoteUrl = ''] = filesFrom(req, 'voiceNote');
  let data, project, update;
  try {
    data = validate(createSchema, { ...req.body, updateId: req.body.updateId || undefined });
    project = await loadProject(req.actor, data.projectId);
    if (data.updateId) {
      assertObjectId(data.updateId, 'update id');
      update = await Update.findOne({ _id: data.updateId, project: project._id });
      if (!update) throw notFound('Update not found in this project');
    }
    if (['question', 'change'].includes(data.type) && !data.message && !photos.length && !voiceNoteUrl) {
      throw badRequest('Write a message, or attach a photo or voice note');
    }
  } catch (err) {
    deleteUploads([...photos, voiceNoteUrl]);
    throw err;
  }

  const isApproval = data.type === 'approval';
  const request = await Request.create({
    project: project._id,
    engineer: project.engineer,
    client: req.actor.doc._id,
    update: update?._id,
    type: data.type,
    message: data.message || DEFAULT_MESSAGES[data.type] || '',
    photos,
    voiceNoteUrl,
    urgent: data.urgent,
    // An approval needs no action from the engineer, so it is resolved immediately.
    status: isApproval ? 'done' : 'new',
    resolvedAt: isApproval ? new Date() : undefined,
  });

  if (isApproval && update) {
    await Update.updateOne({ _id: update._id }, { $addToSet: { approvedBy: req.actor.doc._id } });
  }

  await notify(project.engineer, {
    type: 'request.new',
    title: `${data.urgent ? 'URGENT · ' : ''}${TYPE_LABEL[data.type]} from ${req.actor.doc.name}`,
    body: request.message.slice(0, 140),
    project: project._id,
    update: update?._id,
    request: request._id,
  });

  res.status(201).json({ request: (await populate(Request.findById(request._id))).toJSON() });
});

// ---------- Detail ----------

router.get('/:id', async (req, res) => {
  const request = await loadRequest(req.actor, req.params.id);
  // Opening a request in the contractor app marks it "Seen by contractor".
  if (req.actor.role === 'engineer' && !request.seenAt) {
    request.seenAt = new Date();
    await request.save();
  }
  res.json({ request: (await populate(Request.findById(request._id))).toJSON() });
});

// ---------- Status (engineer) ----------

async function applyStatus(request, status, actor) {
  if (!status || status === request.status) return false;
  request.status = status;
  request.resolvedAt = status === 'done' ? new Date() : undefined;
  request.seenAt = request.seenAt ?? new Date();
  await notify(request.client, {
    type: 'request.status',
    title: `Your ${TYPE_LABEL[request.type].toLowerCase()} is now ${STATUS_LABEL[status].toLowerCase()}`,
    body: `${actor.doc.name} updated the status`,
    project: request.project,
    update: request.update,
    request: request._id,
  });
  return true;
}

router.patch('/:id/status', requireRole('engineer'), async (req, res) => {
  const request = await loadRequest(req.actor, req.params.id);
  const { status } = validate(z.object({ status: z.enum(REQUEST_STATUSES) }), req.body);
  await applyStatus(request, status, req.actor);
  await request.save();
  res.json({ request: (await populate(Request.findById(request._id))).toJSON() });
});

// ---------- Replies (either side) ----------

router.post('/:id/replies', async (req, res) => {
  const request = await loadRequest(req.actor, req.params.id);
  const data = validate(
    z.object({
      message: z.string().trim().min(1, 'Write a reply').max(1000),
      status: z.enum(REQUEST_STATUSES).optional(),
    }),
    req.body,
  );
  request.replies.push({
    authorId: req.actor.doc._id,
    authorName: req.actor.doc.name,
    authorRole: req.actor.role,
    message: data.message,
  });

  if (req.actor.role === 'engineer') {
    // Replying implies the engineer has seen it and is working on it, unless a status is chosen.
    const statusChanged = await applyStatus(request, data.status ?? (request.status === 'new' ? 'in_progress' : undefined), req.actor);
    if (!statusChanged) {
      await notify(request.client, {
        type: 'request.reply',
        title: `${req.actor.doc.name} replied`,
        body: data.message.slice(0, 140),
        project: request.project,
        request: request._id,
      });
    }
  } else {
    if (request.status === 'done') request.status = 'new'; // client follow-up reopens it
    await notify(request.engineer, {
      type: 'request.reply',
      title: `${req.actor.doc.name} replied`,
      body: data.message.slice(0, 140),
      project: request.project,
      request: request._id,
    });
  }
  await request.save();
  res.status(201).json({ request: (await populate(Request.findById(request._id))).toJSON() });
});

router.delete('/:id', requireRole('client'), async (req, res) => {
  const request = await loadRequest(req.actor, req.params.id);
  if (request.status !== 'new' && request.type !== 'approval') {
    throw badRequest('Only requests the contractor has not started can be withdrawn');
  }
  deleteUploads([...request.photos, request.voiceNoteUrl]);
  if (request.type === 'approval' && request.update) {
    await Update.updateOne({ _id: request.update }, { $pull: { approvedBy: req.actor.doc._id } });
  }
  await request.deleteOne();
  res.json({ message: 'Request withdrawn' });
});


export default router;
