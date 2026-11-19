import { Router } from 'express';
import { Project, Update, Request, Notification, WORK_TYPES, TRADES, PROJECT_STATUSES, REQUEST_TYPES } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { visibleProjectsFilter, assertObjectId } from '../services/access.js';
import { forbidden, startOfDay } from '../utils/http.js';

// ---------- Meta: option lists shared by both apps ----------

export const metaRouter = Router();
metaRouter.get('/', (_req, res) => {
  res.json({ workTypes: WORK_TYPES, trades: TRADES, projectStatuses: PROJECT_STATUSES, requestTypes: REQUEST_TYPES });
});

// ---------- Dashboard ----------

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

dashboardRouter.get('/', async (req, res) => {
  const actor = req.actor;
  const projects = await Project.find(visibleProjectsFilter(actor)).select('name location coverImage status progress lastUpdateAt');
  const ids = projects.map((p) => p._id);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const today = startOfDay();

  const [totalUpdates, updatesThisWeek] = await Promise.all([
    Update.countDocuments({ project: { $in: ids } }),
    Update.countDocuments({ project: { $in: ids }, createdAt: { $gte: weekAgo } }),
  ]);
  const base = {
    activeProjects: projects.filter((p) => p.status === 'in_progress').length,
    totalProjects: projects.length,
    totalUpdates,
    updatesThisWeek,
  };

  if (actor.role === 'engineer') {
    const [newRequests, openRequests] = await Promise.all([
      Request.countDocuments({ engineer: actor.doc._id, status: 'new' }),
      Request.countDocuments({ engineer: actor.doc._id, status: { $ne: 'done' } }),
    ]);
    const needsUpdate = projects
      .filter((p) => p.status === 'in_progress' && (!p.lastUpdateAt || p.lastUpdateAt < today))
      .map((p) => p.toJSON());
    return res.json({ ...base, newRequests, openRequests, needsUpdate });
  }
  if (actor.role === 'client') {
    const openRequests = await Request.countDocuments({ client: actor.doc._id, status: { $ne: 'done' } });
    return res.json({ ...base, openRequests });
  }
  res.json(base);
});

// ---------- Notifications ----------

export const notificationsRouter = Router();
notificationsRouter.use(authenticate, (req, _res, next) => {
  if (req.actor.kind !== 'user') throw forbidden();
  next();
});

notificationsRouter.get('/', async (req, res) => {
  const [items, unread] = await Promise.all([
    Notification.find({ user: req.actor.doc._id }).sort({ createdAt: -1 }).limit(50),
    Notification.countDocuments({ user: req.actor.doc._id, read: false }),
  ]);
  res.json({ notifications: items.map((n) => n.toJSON()), unread });
});

notificationsRouter.post('/read-all', async (req, res) => {
  await Notification.updateMany({ user: req.actor.doc._id, read: false }, { read: true });
  res.json({ unread: 0 });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  assertObjectId(req.params.id, 'notification id');
  await Notification.updateOne({ _id: req.params.id, user: req.actor.doc._id }, { read: true });
  const unread = await Notification.countDocuments({ user: req.actor.doc._id, read: false });
  res.json({ unread });
});
