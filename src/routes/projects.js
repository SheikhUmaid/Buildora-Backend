import { Router } from 'express';
import { z } from 'zod';
import { Project, Update, Request, Laborer, User, PROJECT_STATUSES } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { upload, fileUrl, deleteUploads } from '../middleware/upload.js';
import { loadProject, projectForActor, visibleProjectsFilter, assertObjectId } from '../services/access.js';
import { notify } from '../services/notify.js';
import { uniqueInviteCode, openRequestCounts, PUBLIC_USER_FIELDS, CLIENT_FIELDS } from '../services/projects.js';
import { validate, toBool, badRequest, notFound, conflict } from '../utils/http.js';

const router = Router();
router.use(authenticate);

const optionalDate = z
  .union([z.string(), z.date(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date' });
      return z.NEVER;
    }
    return d;
  });

const projectFields = {
  name: z.string().trim().min(2, 'Project name is required').max(100),
  location: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1000).optional(),
  startDate: optionalDate,
  expectedFinish: optionalDate,
  budget: z.coerce.number().min(0).optional(),
  budgetVisible: z.preprocess((v) => (v === undefined ? undefined : toBool(v)), z.boolean().optional()),
};
const createSchema = z.object(projectFields);
const updateSchema = z.object({ ...projectFields, name: projectFields.name.optional() });

async function populated(projectQuery) {
  return projectQuery.populate('engineer', PUBLIC_USER_FIELDS).populate('clients', CLIENT_FIELDS);
}

// ---------- List / create ----------

router.get('/', async (req, res) => {
  const filter = visibleProjectsFilter(req.actor);
  if (req.query.status && PROJECT_STATUSES.includes(req.query.status)) filter.status = req.query.status;
  const projects = await populated(Project.find(filter).sort({ status: 1, updatedAt: -1 }));

  const clientFilter = req.actor.role === 'client' ? { client: req.actor.doc._id } : {};
  const counts = await openRequestCounts(projects.map((p) => p._id), clientFilter);
  res.json({
    projects: projects.map((p) => ({ ...projectForActor(req.actor, p), openRequests: counts[p.id] ?? 0 })),
  });
});

router.post('/', requireRole('engineer'), upload.single('cover'), async (req, res) => {
  const data = validate(createSchema, req.body);
  const project = await Project.create({
    ...data,
    startDate: data.startDate ?? new Date(),
    expectedFinish: data.expectedFinish ?? undefined,
    engineer: req.actor.id,
    coverImage: req.file ? fileUrl(req.file) : '',
    inviteCode: await uniqueInviteCode(),
  });
  res.status(201).json({ project: projectForActor(req.actor, await populated(Project.findById(project._id))) });
});

// ---------- Join by invite code (clients) ----------

router.post('/join', requireRole('client'), async (req, res) => {
  const { code } = validate(z.object({ code: z.string().trim().toUpperCase().length(6, 'Invite codes are 6 characters') }), req.body);
  const project = await Project.findOne({ inviteCode: code });
  if (!project) throw notFound('No project found for that code. Check it with your contractor.');
  if (project.clients.some((c) => c.toString() === req.actor.id)) throw conflict('You have already joined this project');
  project.clients.push(req.actor.doc._id);
  await project.save();
  await notify(project.engineer, {
    type: 'project.joined',
    title: `${req.actor.doc.name} joined ${project.name}`,
    body: 'They can now follow daily updates and send requests.',
    project: project._id,
  });
  res.json({ project: projectForActor(req.actor, await populated(Project.findById(project._id))) });
});

// ---------- Detail ----------

router.get('/:id', async (req, res) => {
  const base = await loadProject(req.actor, req.params.id);
  const project = await populated(Project.findById(base._id));
  const requestFilter = { project: project._id, status: { $ne: 'done' } };
  if (req.actor.role === 'client') requestFilter.client = req.actor.doc._id;
  const [openRequests, latestUpdate] = await Promise.all([
    req.actor.role === 'laborer' ? 0 : Request.countDocuments(requestFilter),
    Update.findOne({ project: project._id }).sort({ date: -1, createdAt: -1 }),
  ]);
  res.json({
    project: { ...projectForActor(req.actor, project), openRequests },
    latestUpdate: latestUpdate?.toJSON() ?? null,
  });
});

router.patch('/:id', upload.single('cover'), async (req, res) => {
  const project = await loadProject(req.actor, req.params.id, { owner: true });
  const data = validate(updateSchema, req.body);
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) project[k] = v;
  }
  if (req.file) {
    deleteUploads([project.coverImage]);
    project.coverImage = fileUrl(req.file);
  }
  await project.save();
  res.json({ project: projectForActor(req.actor, await populated(Project.findById(project._id))) });
});

router.delete('/:id', async (req, res) => {
  const project = await loadProject(req.actor, req.params.id, { owner: true });
  const updates = await Update.find({ project: project._id });
  deleteUploads([project.coverImage, ...updates.flatMap((u) => [...u.photos, u.voiceNoteUrl])]);
  await Promise.all([
    Update.deleteMany({ project: project._id }),
    Request.deleteMany({ project: project._id }),
    Laborer.updateMany({ projects: project._id }, { $pull: { projects: project._id } }),
  ]);
  await project.deleteOne();
  res.json({ message: 'Project deleted' });
});

// ---------- Status & progress ----------

router.patch('/:id/status', async (req, res) => {
  const project = await loadProject(req.actor, req.params.id, { owner: true });
  const { status } = validate(z.object({ status: z.enum(PROJECT_STATUSES) }), req.body);
  project.status = status;
  if (status === 'completed') {
    project.completedAt = project.completedAt ?? new Date();
    project.progress = 100;
  } else {
    project.completedAt = undefined;
  }
  await project.save();
  const label = { in_progress: 'In progress', on_hold: 'On hold', completed: 'Completed' }[status];
  await notify(project.clients, {
    type: 'project.status',
    title: `${project.name} is now ${label.toLowerCase()}`,
    body: status === 'completed' ? 'Congratulations! Your build has been marked complete.' : '',
    project: project._id,
  });
  res.json({ project: projectForActor(req.actor, await populated(Project.findById(project._id))) });
});

router.patch('/:id/progress', async (req, res) => {
  const project = await loadProject(req.actor, req.params.id, { owner: true });
  const { progress } = validate(z.object({ progress: z.coerce.number().int().min(0).max(100) }), req.body);
  project.progress = progress;
  await project.save();
  res.json({ project: projectForActor(req.actor, await populated(Project.findById(project._id))) });
});

// ---------- Invite code & members ----------

router.post('/:id/invite-code', async (req, res) => {
  const project = await loadProject(req.actor, req.params.id, { owner: true });
  project.inviteCode = await uniqueInviteCode();
  await project.save();
  res.json({ inviteCode: project.inviteCode });
});

router.delete('/:id/clients/:clientId', async (req, res) => {
  const project = await loadProject(req.actor, req.params.id, { owner: true });
  assertObjectId(req.params.clientId, 'client id');
  project.clients = project.clients.filter((c) => c.toString() !== req.params.clientId);
  await project.save();
  res.json({ project: projectForActor(req.actor, await populated(Project.findById(project._id))) });
});

router.post('/:id/leave', requireRole('client'), async (req, res) => {
  const project = await loadProject(req.actor, req.params.id);
  project.clients = project.clients.filter((c) => c.toString() !== req.actor.id);
  await project.save();
  res.json({ message: 'You have left the project' });
});

// ---------- Client feedback (completed projects) ----------

router.post('/:id/feedback', requireRole('client'), async (req, res) => {
  const project = await loadProject(req.actor, req.params.id);
  if (project.status !== 'completed') throw badRequest('You can leave a review once the project is completed');
  const data = validate(
    z.object({ rating: z.coerce.number().int().min(1).max(5), text: z.string().trim().max(600).optional().default('') }),
    req.body,
  );
  const existing = project.feedback.find((f) => f.client?.toString() === req.actor.id);
  if (existing) {
    existing.rating = data.rating;
    existing.text = data.text;
  } else {
    project.feedback.push({ client: req.actor.doc._id, authorName: req.actor.doc.name, ...data });
  }
  await project.save();
  await notify(project.engineer, {
    type: 'project.feedback',
    title: `${req.actor.doc.name} rated ${project.name} ${data.rating}★`,
    body: data.text,
    project: project._id,
  });
  res.json({ feedback: project.feedback.map((f) => f.toJSON()) });
});

// Engineer: list laborers assigned to this project
router.get('/:id/laborers', async (req, res) => {
  const project = await loadProject(req.actor, req.params.id, { owner: true });
  const laborers = await Laborer.find({ projects: project._id }).sort({ name: 1 });
  res.json({ laborers: laborers.map((l) => l.toJSON()) });
});

// Engineer: find the client user (for call / WhatsApp) — included in populated clients already,
// kept here for apps that want a light payload.
router.get('/:id/clients', async (req, res) => {
  const project = await loadProject(req.actor, req.params.id);
  const clients = await User.find({ _id: { $in: project.clients } }).select(CLIENT_FIELDS);
  res.json({ clients: clients.map((c) => c.toJSON()) });
});

export default router;
