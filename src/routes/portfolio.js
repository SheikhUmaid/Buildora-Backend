import { Router } from 'express';
import { z } from 'zod';
import { Project, Update, User } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { upload, fileUrl } from '../middleware/upload.js';
import { loadProject, assertObjectId } from '../services/access.js';
import { monthsBetween, PUBLIC_USER_FIELDS } from '../services/projects.js';
import { validate, notFound, forbidden, badRequest } from '../utils/http.js';

const MAX_HIGHLIGHTS = 12;

/** Stats + story shown on a portfolio case study. `audience` controls privacy filtering. */
async function caseStudy(project, { audience }) {
  await project.populate('clients', 'name');
  const isOwner = audience === 'owner';
  const pf = project.portfolio ?? {};
  const cover = pf.highlights?.[0] || project.coverImage;
  const json = {
    id: project.id,
    name: project.name,
    location: isOwner || pf.showExactLocation ? project.location : (project.location.split(',').pop() ?? '').trim(),
    status: project.status,
    progress: project.progress,
    startDate: project.startDate,
    completedAt: project.completedAt,
    coverImage: cover,
    stats: {
      durationMonths: monthsBetween(project.startDate, project.completedAt ?? new Date()),
      updates: project.updatesCount,
      photos: project.photosCount,
      peakLaborers: project.peakLaborers,
      progress: project.progress,
    },
    story: pf.story ?? '',
    highlights: pf.highlights ?? [],
    feedback: project.feedback
      .filter((f) => isOwner || f.showOnPortfolio)
      .map((f) => ({
        id: f.id,
        rating: f.rating,
        text: f.text,
        authorName: isOwner || pf.showClientName ? f.authorName : 'Client',
        showOnPortfolio: f.showOnPortfolio,
        createdAt: f.createdAt,
      })),
    clientName: isOwner || pf.showClientName ? project.clients.map((c) => c.name).join(', ') : null,
  };
  if (isOwner) {
    json.portfolio = {
      included: pf.included,
      hidden: pf.hidden,
      featured: pf.featured,
      visibleToClients: pf.visibleToClients,
      showExactLocation: pf.showExactLocation,
      showClientName: pf.showClientName,
    };
  }
  return json;
}

function card(project) {
  const pf = project.portfolio ?? {};
  return {
    id: project.id,
    name: project.name,
    location: pf.showExactLocation === false ? (project.location.split(',').pop() ?? '').trim() : project.location,
    status: project.status,
    progress: project.progress,
    coverImage: pf.highlights?.[0] || project.coverImage,
    completedAt: project.completedAt,
    startDate: project.startDate,
    lastUpdateAt: project.lastUpdateAt,
    featured: !!pf.featured,
    hidden: !!pf.hidden,
    visibleToClients: pf.visibleToClients !== false,
  };
}

// ======================= Engineer portfolio management =======================

export const portfolioRouter = Router();
portfolioRouter.use(authenticate, requireRole('engineer'));

portfolioRouter.get('/', async (req, res) => {
  const me = req.actor.doc;
  const projects = await Project.find({ engineer: me._id, 'portfolio.included': { $ne: false } }).sort({
    'portfolio.featured': -1,
    completedAt: -1,
    updatedAt: -1,
  });
  const updatesPosted = projects.reduce((s, p) => s + (p.updatesCount ?? 0), 0);
  res.json({
    stats: {
      activeProjects: projects.filter((p) => p.status !== 'completed').length,
      completedProjects: projects.filter((p) => p.status === 'completed').length,
      updatesPosted,
      yearsExperience: me.yearsExperience,
    },
    projects: projects.map(card),
  });
});

portfolioRouter.get('/:projectId', async (req, res) => {
  const project = await loadProject(req.actor, req.params.projectId, { owner: true });
  const updates = await Update.find({ project: project._id }).sort({ date: -1 }).select('photos');
  const allPhotos = [...new Set(updates.flatMap((u) => u.photos))];
  res.json({ project: { ...(await caseStudy(project, { audience: 'owner' })), allPhotos } });
});

const settingsSchema = z.object({
  story: z.string().trim().max(1500).optional(),
  highlights: z.array(z.string()).max(MAX_HIGHLIGHTS, `At most ${MAX_HIGHLIGHTS} highlights`).optional(),
  featured: z.boolean().optional(),
  hidden: z.boolean().optional(),
  included: z.boolean().optional(),
  visibleToClients: z.boolean().optional(),
  showExactLocation: z.boolean().optional(),
  showClientName: z.boolean().optional(),
});

portfolioRouter.patch('/:projectId', async (req, res) => {
  const project = await loadProject(req.actor, req.params.projectId, { owner: true });
  const data = validate(settingsSchema, req.body);
  if (data.highlights) {
    const bad = data.highlights.find((h) => typeof h !== 'string' || !h.startsWith('/uploads/'));
    if (bad) throw badRequest('Highlights must be uploaded photos');
  }
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) project.portfolio[k] = v;
  }
  project.markModified('portfolio');
  await project.save();
  res.json({ project: await caseStudy(project, { audience: 'owner' }) });
});

/** Upload extra photos (e.g. final handover shots) straight into highlights. */
portfolioRouter.post('/:projectId/photos', upload.array('photos', 10), async (req, res) => {
  const project = await loadProject(req.actor, req.params.projectId, { owner: true });
  const urls = (req.files ?? []).map(fileUrl);
  if (!urls.length) throw badRequest('Choose at least one photo');
  const highlights = [...(project.portfolio.highlights ?? []), ...urls];
  if (highlights.length > MAX_HIGHLIGHTS) throw badRequest(`At most ${MAX_HIGHLIGHTS} highlights`);
  project.portfolio.highlights = highlights;
  project.markModified('portfolio');
  await project.save();
  res.json({ project: await caseStudy(project, { audience: 'owner' }) });
});

portfolioRouter.patch('/:projectId/feedback/:feedbackId', async (req, res) => {
  const project = await loadProject(req.actor, req.params.projectId, { owner: true });
  const { showOnPortfolio } = validate(z.object({ showOnPortfolio: z.boolean() }), req.body);
  const fb = project.feedback.id(req.params.feedbackId);
  if (!fb) throw notFound('Feedback not found');
  fb.showOnPortfolio = showOnPortfolio;
  await project.save();
  res.json({ project: await caseStudy(project, { audience: 'owner' }) });
});

// ======================= Client view of an engineer =======================

export const engineersRouter = Router();
engineersRouter.use(authenticate);

/** A client may view an engineer they share at least one project with. */
async function assertRelated(actor, engineerId) {
  assertObjectId(engineerId, 'engineer id');
  if (actor.role === 'engineer' && actor.id === engineerId) return;
  if (actor.role !== 'client') throw forbidden();
  const shared = await Project.exists({ engineer: engineerId, clients: actor.doc._id });
  if (!shared) throw forbidden('You can only view contractors you work with');
}

engineersRouter.get('/:id', async (req, res) => {
  await assertRelated(req.actor, req.params.id);
  const engineer = await User.findOne({ _id: req.params.id, role: 'engineer' }).select(PUBLIC_USER_FIELDS);
  if (!engineer) throw notFound('Contractor not found');

  const [withYou, completed, totals] = await Promise.all([
    Project.find({ engineer: engineer._id, clients: req.actor.doc._id }).select('name status progress location coverImage'),
    Project.find({
      engineer: engineer._id,
      status: 'completed',
      'portfolio.included': { $ne: false },
      'portfolio.hidden': { $ne: true },
      'portfolio.visibleToClients': { $ne: false },
    }).sort({ 'portfolio.featured': -1, completedAt: -1 }),
    Project.aggregate([
      { $match: { engineer: engineer._id } },
      { $group: { _id: null, projects: { $sum: 1 }, updates: { $sum: '$updatesCount' } } },
    ]),
  ]);

  res.json({
    engineer: engineer.toJSON(),
    stats: { projects: totals[0]?.projects ?? 0, updates: totals[0]?.updates ?? 0 },
    projectsWithYou: withYou.map((p) => p.toJSON()),
    completedProjects: completed.map(card),
  });
});

engineersRouter.get('/:id/portfolio/:projectId', async (req, res) => {
  await assertRelated(req.actor, req.params.id);
  assertObjectId(req.params.projectId, 'project id');
  const project = await Project.findOne({ _id: req.params.projectId, engineer: req.params.id });
  const pf = project?.portfolio;
  const isMember = project?.clients.some((c) => c.toString() === req.actor.id);
  if (!project || (!isMember && (pf?.hidden || pf?.included === false || pf?.visibleToClients === false))) {
    throw notFound('Project not found');
  }
  res.json({ project: await caseStudy(project, { audience: 'client' }) });
});
