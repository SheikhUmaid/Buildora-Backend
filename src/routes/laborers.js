import { Router } from 'express';
import { z } from 'zod';
import { Laborer, Project } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { assertObjectId } from '../services/access.js';
import { generatePin } from '../utils/inviteCode.js';
import { validate, badRequest, notFound, conflict } from '../utils/http.js';

const router = Router();
router.use(authenticate, requireRole('engineer'));

const pin = z.string().trim().regex(/^\d{4}$/, 'PIN must be 4 digits');

const baseSchema = {
  name: z.string().trim().min(2, 'Enter the manager name').max(80),
  phone: z.string().trim().min(5, 'Enter a valid phone number').max(20),
  trade: z.string().trim().min(1).max(40).optional(),
  projects: z.array(z.string()).optional(),
  active: z.boolean().optional(),
};
const createSchema = z.object({ ...baseSchema, pin: pin.optional() });
const updateSchema = z.object({
  name: baseSchema.name.optional(),
  phone: baseSchema.phone.optional(),
  trade: baseSchema.trade,
  projects: baseSchema.projects,
  active: baseSchema.active,
});

/** Only allow assigning projects the engineer owns. */
async function ownedProjectIds(engineerId, ids = []) {
  ids.forEach((id) => assertObjectId(id, 'project id'));
  const owned = await Project.find({ _id: { $in: ids }, engineer: engineerId }).select('_id');
  if (owned.length !== new Set(ids).size) throw badRequest('One or more projects are not yours');
  return owned.map((p) => p._id);
}

async function loadOwn(actor, id) {
  assertObjectId(id, 'laborer id');
  const laborer = await Laborer.findOne({ _id: id, engineer: actor.doc._id }).select('+pin');
  if (!laborer) throw notFound('Manager not found');
  return laborer;
}

const withProjects = (q) => q.populate('projects', 'name location status');

router.get('/', async (req, res) => {
  const filter = { engineer: req.actor.doc._id };
  if (req.query.projectId) {
    assertObjectId(req.query.projectId, 'project id');
    filter.projects = req.query.projectId;
  }
  const laborers = await withProjects(Laborer.find(filter).select('+pin').sort({ active: -1, name: 1 }));
  res.json({ laborers: laborers.map((l) => l.toJSON()) });
});

router.post('/', async (req, res) => {
  const data = validate(createSchema, req.body);
  if (await Laborer.exists({ phone: data.phone })) throw conflict('A manager with this phone number already exists');
  const laborer = await Laborer.create({
    engineer: req.actor.doc._id,
    name: data.name,
    phone: data.phone,
    trade: data.trade ?? 'Helper',
    projects: await ownedProjectIds(req.actor.doc._id, data.projects),
    pin: data.pin ?? generatePin(),
    active: data.active ?? true,
  });
  const full = await withProjects(Laborer.findById(laborer._id).select('+pin'));
  res.status(201).json({ laborer: full.toJSON() });
});

router.get('/:id', async (req, res) => {
  const laborer = await loadOwn(req.actor, req.params.id);
  await laborer.populate('projects', 'name location status');
  res.json({ laborer: laborer.toJSON() });
});

router.patch('/:id', async (req, res) => {
  const laborer = await loadOwn(req.actor, req.params.id);
  const data = validate(updateSchema, req.body);
  if (data.phone && data.phone !== laborer.phone && (await Laborer.exists({ phone: data.phone }))) {
    throw conflict('A manager with this phone number already exists');
  }
  if (data.projects) laborer.projects = await ownedProjectIds(req.actor.doc._id, data.projects);
  for (const key of ['name', 'phone', 'trade', 'active']) {
    if (data[key] !== undefined) laborer[key] = data[key];
  }
  await laborer.save();
  await laborer.populate('projects', 'name location status');
  res.json({ laborer: laborer.toJSON() });
});

router.post('/:id/reset-pin', async (req, res) => {
  const laborer = await loadOwn(req.actor, req.params.id);
  const body = validate(z.object({ pin: pin.optional() }), req.body);
  laborer.pin = body.pin ?? generatePin();
  await laborer.save();
  await laborer.populate('projects', 'name location status');
  res.json({ laborer: laborer.toJSON() });
});

router.delete('/:id', async (req, res) => {
  const laborer = await loadOwn(req.actor, req.params.id);
  await laborer.deleteOne();
  res.json({ message: 'Manager removed' });
});

export default router;
