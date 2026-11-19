import { Router } from 'express';
import { z } from 'zod';
import { Project, Update, Request } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { mediaUpload, filesFrom, deleteUploads } from '../middleware/upload.js';
import { loadProject, visibleProjectsFilter, assertObjectId, canView } from '../services/access.js';
import { refreshProjectStats } from '../services/projects.js';
import { notify } from '../services/notify.js';
import { validate, parseJsonField, badRequest, forbidden, notFound, startOfDay } from '../utils/http.js';

const router = Router();
// Mounted at /api, so only guard this router's own paths (not every /api/* request passing through).
router.use(['/updates', '/projects/:projectId/updates'], authenticate);

const laborerRow = z.object({ trade: z.string().trim().min(1).max(40), count: z.coerce.number().int().min(0).max(999) });

const updateBody = z.object({
  note: z.string().trim().max(2000).optional(),
  date: z.coerce.date().optional(),
  workTypes: z.array(z.string().trim().max(40)).max(20).optional(),
  laborers: z.array(laborerRow).max(30).optional(),
  totalLaborers: z.coerce.number().int().min(0).max(9999).optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
  removePhotos: z.array(z.string()).optional(),
  removeVoiceNote: z.boolean().optional(),
});

/** Multipart forms send arrays/objects as JSON strings. */
function parseBody(body) {
  return validate(updateBody, {
    ...body,
    workTypes: parseJsonField(body.workTypes, undefined),
    laborers: parseJsonField(body.laborers, undefined),
    removePhotos: parseJsonField(body.removePhotos, undefined),
    removeVoiceNote: body.removeVoiceNote === undefined ? undefined : String(body.removeVoiceNote) === 'true',
    date: body.date || undefined,
    progress: body.progress === '' ? undefined : body.progress,
    totalLaborers: body.totalLaborers === '' ? undefined : body.totalLaborers,
  });
}

function authorOf(actor) {
  return actor.role === 'laborer'
    ? { kind: 'laborer', id: actor.doc._id, name: actor.doc.name, trade: actor.doc.trade }
    : { kind: 'engineer', id: actor.doc._id, name: actor.doc.name };
}

function canEdit(actor, update, project) {
  if (actor.role === 'engineer') return project.engineer.toString() === actor.id;
  if (actor.role === 'laborer') return update.author.kind === 'laborer' && update.author.id.toString() === actor.id;
  return false;
}

/** Build a filter from common query params. */
function feedFilter(query) {
  const filter = {};
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [y, m] = query.month.split('-').map(Number);
    filter.date = { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) };
  }
  if (query.workType) filter.workTypes = query.workType;
  if (query.trade) filter['laborers.trade'] = query.trade;
  if (query.q) filter.note = { $regex: String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (query.before) filter.createdAt = { $lt: new Date(query.before) };
  return filter;
}

async function withRequestCounts(updates, actor) {
  if (!updates.length) return [];
  const match = { update: { $in: updates.map((u) => u._id) } };
  if (actor.role === 'client') match.client = actor.doc._id;
  const rows = await Request.aggregate([{ $match: match }, { $group: { _id: '$update', n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(rows.map((r) => [r._id.toString(), r.n]));
  return updates.map((u) => ({ ...u.toJSON(), requestCount: counts[u.id] ?? 0 }));
}

// ---------- Feeds ----------

/**
 * GET /api/updates — feed across every project the actor can see.
 * Query: projectId, month=YYYY-MM, workType, trade, q, mine=true, limit, before
 */
router.get('/updates', async (req, res) => {
  const filter = feedFilter(req.query);
  const projects = await Project.find(visibleProjectsFilter(req.actor)).select('_id name');
  let projectIds = projects.map((p) => p._id);
  if (req.query.projectId) {
    projectIds = projectIds.filter((id) => id.toString() === req.query.projectId);
  }
  filter.project = { $in: projectIds };
  if (req.query.mine === 'true') filter['author.id'] = req.actor.doc._id;

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const updates = await Update.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit);
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const rows = await withRequestCounts(updates, req.actor);
  res.json({ updates: rows.map((u) => ({ ...u, projectName: names[u.project.toString()] ?? '' })) });
});

router.get('/projects/:projectId/updates', async (req, res) => {
  const project = await loadProject(req.actor, req.params.projectId);
  const filter = { ...feedFilter(req.query), project: project._id };
  if (req.query.mine === 'true') filter['author.id'] = req.actor.doc._id;
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const updates = await Update.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit);
  const rows = await withRequestCounts(updates, req.actor);
  res.json({ updates: rows.map((u) => ({ ...u, projectName: project.name })) });
});

// ---------- Create ----------

router.post('/projects/:projectId/updates', mediaUpload, async (req, res) => {
  if (req.actor.role === 'client') throw forbidden('Clients cannot post site updates');
  const project = await loadProject(req.actor, req.params.projectId);
  const photos = filesFrom(req, 'photos');
  const [voiceNoteUrl = ''] = filesFrom(req, 'voiceNote');

  let data;
  try {
    data = parseBody(req.body);
    if (!photos.length && !data.note && !voiceNoteUrl) throw badRequest('Add at least one photo, a note or a voice note');
  } catch (err) {
    deleteUploads([...photos, voiceNoteUrl]);
    throw err;
  }

  const laborers = (data.laborers ?? []).filter((l) => l.count > 0);
  const total = data.totalLaborers ?? laborers.reduce((s, l) => s + l.count, 0);
  const update = await Update.create({
    project: project._id,
    author: authorOf(req.actor),
    date: startOfDay(data.date ?? new Date()),
    photos,
    note: data.note ?? '',
    voiceNoteUrl,
    workTypes: data.workTypes ?? [],
    laborers,
    totalLaborers: total,
    // Only the engineer moves the overall project progress.
    progress: req.actor.role === 'engineer' ? (data.progress ?? project.progress) : project.progress,
  });

  if (req.actor.role === 'engineer' && data.progress !== undefined) {
    project.progress = data.progress;
  }
  if (!project.coverImage && photos.length) project.coverImage = photos[0];
  await project.save();
  await refreshProjectStats(project._id);

  await notify(project.clients, {
    type: 'update.new',
    title: `New update on ${project.name}`,
    body: update.note ? update.note.slice(0, 120) : `${photos.length} new photo${photos.length === 1 ? '' : 's'}`,
    project: project._id,
    update: update._id,
  });
  if (req.actor.role === 'laborer') {
    await notify(project.engineer, {
      type: 'update.new',
      title: `${req.actor.doc.name} posted on ${project.name}`,
      body: update.note.slice(0, 120),
      project: project._id,
      update: update._id,
    });
  }

  res.status(201).json({ update: { ...update.toJSON(), projectName: project.name, requestCount: 0 } });
});

// ---------- Detail / edit / delete ----------

async function loadUpdate(actor, id) {
  assertObjectId(id, 'update id');
  const update = await Update.findById(id);
  if (!update) throw notFound('Update not found');
  const project = await Project.findById(update.project);
  if (!project || !canView(actor, project)) throw forbidden('You are not part of this project');
  return { update, project };
}

/** Detail includes position within the project timeline so apps can page "12 of 12". */
router.get('/updates/:id', async (req, res) => {
  const { update, project } = await loadUpdate(req.actor, req.params.id);
  const ordered = await Update.find({ project: project._id }).sort({ date: 1, createdAt: 1 }).select('_id');
  const index = ordered.findIndex((u) => u._id.equals(update._id));
  const reqFilter = { update: update._id };
  if (req.actor.role === 'client') reqFilter.client = req.actor.doc._id;
  const requestCount = req.actor.role === 'laborer' ? 0 : await Request.countDocuments(reqFilter);
  res.json({
    update: {
      ...update.toJSON(),
      projectName: project.name,
      requestCount,
      approvedByMe: req.actor.role === 'client' && update.approvedBy.some((u) => u.toString() === req.actor.id),
    },
    position: index + 1,
    total: ordered.length,
    prevId: index > 0 ? ordered[index - 1]._id.toString() : null,
    nextId: index >= 0 && index < ordered.length - 1 ? ordered[index + 1]._id.toString() : null,
  });
});

router.patch('/updates/:id', mediaUpload, async (req, res) => {
  const newPhotos = filesFrom(req, 'photos');
  const [newVoice] = filesFrom(req, 'voiceNote');
  let ctx;
  let data;
  try {
    ctx = await loadUpdate(req.actor, req.params.id);
    if (!canEdit(req.actor, ctx.update, ctx.project)) throw forbidden('You can only edit your own posts');
    data = parseBody(req.body);
  } catch (err) {
    deleteUploads([...newPhotos, newVoice]);
    throw err;
  }
  const { update, project } = ctx;

  const remove = new Set(data.removePhotos ?? []);
  const kept = update.photos.filter((p) => !remove.has(p));
  if (kept.length + newPhotos.length > 10) {
    deleteUploads([...newPhotos, newVoice]);
    throw badRequest('An update can have at most 10 photos');
  }
  deleteUploads(update.photos.filter((p) => remove.has(p)));
  update.photos = [...kept, ...newPhotos];
  if (newVoice || data.removeVoiceNote) {
    deleteUploads([update.voiceNoteUrl]);
    update.voiceNoteUrl = newVoice ?? '';
  }
  if (data.note !== undefined) update.note = data.note;
  if (data.date) update.date = startOfDay(data.date);
  if (data.workTypes) update.workTypes = data.workTypes;
  if (data.laborers) {
    update.laborers = data.laborers.filter((l) => l.count > 0);
    update.totalLaborers = data.totalLaborers ?? update.laborers.reduce((s, l) => s + l.count, 0);
  } else if (data.totalLaborers !== undefined) {
    update.totalLaborers = data.totalLaborers;
  }
  if (req.actor.role === 'engineer' && data.progress !== undefined) {
    update.progress = data.progress;
    project.progress = data.progress;
    await project.save();
  }
  await update.save();
  await refreshProjectStats(project._id);
  res.json({ update: { ...update.toJSON(), projectName: project.name } });
});

router.delete('/updates/:id', async (req, res) => {
  const { update, project } = await loadUpdate(req.actor, req.params.id);
  if (!canEdit(req.actor, update, project)) throw forbidden('You can only delete your own posts');
  deleteUploads([...update.photos, update.voiceNoteUrl]);
  await Request.updateMany({ update: update._id }, { $unset: { update: 1 } });
  await update.deleteOne();
  await refreshProjectStats(project._id);
  res.json({ message: 'Update deleted' });
});

export default router;
