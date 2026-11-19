import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, Laborer, Project, Update, Request, Notification } from '../models/index.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { deleteUploads } from '../middleware/upload.js';
import { validate, badRequest, unauthorized, forbidden, conflict } from '../utils/http.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in a few minutes' },
});

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email'));
const password = z.string().min(6, 'Password must be at least 6 characters').max(128);
const phone = z.string().trim().max(20).optional().default('');

/** What the apps receive as "the logged-in account". */
export async function accountJson(actor) {
  if (actor.kind === 'laborer') {
    const lab = actor.doc;
    const [engineer, projects] = await Promise.all([
      User.findById(lab.engineer),
      Project.find({ _id: { $in: lab.projects } }).select('name location coverImage status progress'),
    ]);
    return {
      id: lab._id.toString(),
      role: 'laborer',
      name: lab.name,
      phone: lab.phone,
      trade: lab.trade,
      engineer: engineer?.toPublic() ?? null,
      projects: projects.map((p) => p.toJSON()),
    };
  }
  return { ...actor.doc.toJSON(), role: actor.doc.role };
}

// ---------- Register / login ----------

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(80),
  email,
  password,
  phone,
  role: z.enum(['client', 'engineer']),
  profession: z.enum(['Engineer', 'Contractor', 'Builder']).optional(),
  company: z.string().trim().max(100).optional(),
});

router.post('/register', loginLimiter, async (req, res) => {
  const data = validate(registerSchema, req.body);
  if (await User.exists({ email: data.email })) throw conflict('An account with this email already exists');

  const user = new User({
    name: data.name,
    email: data.email,
    phone: data.phone,
    role: data.role,
    profession: data.profession ?? 'Engineer',
    title: data.role === 'engineer' ? (data.profession === 'Engineer' || !data.profession ? 'Civil Engineer' : data.profession) : '',
    company: data.company ?? '',
  });
  await user.setPassword(data.password);
  await user.save();

  const actor = { kind: 'user', role: user.role, id: user.id, doc: user };
  res.status(201).json({ token: signToken('user', user._id), user: await accountJson(actor) });
});

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
  // Each app passes its expected role so a client can't log into the engineer app by mistake.
  role: z.enum(['client', 'engineer']).optional(),
});

router.post('/login', loginLimiter, async (req, res) => {
  const data = validate(loginSchema, req.body);
  const user = await User.findOne({ email: data.email });
  if (!user || !(await user.checkPassword(data.password))) throw unauthorized('Incorrect email or password');
  if (data.role && user.role !== data.role) {
    throw forbidden(
      user.role === 'client'
        ? 'This is a client account. Please use the Buildora client app.'
        : 'This is a contractor account. Please use the Buildora contractor app.',
    );
  }
  const actor = { kind: 'user', role: user.role, id: user.id, doc: user };
  res.json({ token: signToken('user', user._id), user: await accountJson(actor) });
});

const labourLoginSchema = z.object({
  phone: z.string().trim().min(5, 'Enter your phone number'),
  pin: z.string().trim().regex(/^\d{4}$/, 'PIN must be 4 digits'),
});

router.post('/labour/login', loginLimiter, async (req, res) => {
  const data = validate(labourLoginSchema, req.body);
  const laborer = await Laborer.findOne({ phone: data.phone }).select('+pin');
  if (!laborer || laborer.pin !== data.pin) throw unauthorized('Incorrect phone or PIN');
  if (!laborer.active) throw forbidden('Your login has been deactivated by your contractor');
  laborer.lastLoginAt = new Date();
  await laborer.save();
  const actor = { kind: 'laborer', role: 'laborer', id: laborer.id, doc: laborer };
  res.json({ token: signToken('laborer', laborer._id), user: await accountJson(actor) });
});

// ---------- Password reset ----------
// No email provider is configured, so the 6-digit code is logged on the server
// (and returned as `devCode` outside production) to make the flow testable.

router.post('/forgot-password', loginLimiter, async (req, res) => {
  const { email: addr } = validate(z.object({ email }), req.body);
  const user = await User.findOne({ email: addr });
  let devCode;
  if (user) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    user.resetCode = code;
    user.resetCodeExpires = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();
    console.log(`[password reset] code for ${addr}: ${code}`);
    if (process.env.NODE_ENV !== 'production') devCode = code;
  }
  res.json({ message: 'If that email is registered, a reset code has been sent.', devCode });
});

router.post('/reset-password', loginLimiter, async (req, res) => {
  const data = validate(z.object({ email, code: z.string().trim().length(6), newPassword: password }), req.body);
  const user = await User.findOne({ email: data.email });
  if (!user || !user.resetCode || user.resetCode !== data.code || user.resetCodeExpires < new Date()) {
    throw badRequest('Invalid or expired reset code');
  }
  await user.setPassword(data.newPassword);
  user.resetCode = undefined;
  user.resetCodeExpires = undefined;
  await user.save();
  res.json({ message: 'Password updated. You can now log in.' });
});

// ---------- Current account ----------

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: await accountJson(req.actor) });
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().max(20).optional(),
  profession: z.enum(['Engineer', 'Contractor', 'Builder']).optional(),
  title: z.string().trim().max(60).optional(),
  company: z.string().trim().max(100).optional(),
  bio: z.string().trim().max(400).optional(),
  location: z.string().trim().max(80).optional(),
  yearsExperience: z.coerce.number().int().min(0).max(80).optional(),
  notificationsEnabled: z.boolean().optional(),
});

router.patch('/me', authenticate, async (req, res) => {
  if (req.actor.kind !== 'user') throw forbidden('Laborer profiles are managed by your contractor');
  const data = validate(profileSchema, req.body);
  Object.assign(req.actor.doc, data);
  await req.actor.doc.save();
  res.json({ user: await accountJson(req.actor) });
});

router.post('/change-password', authenticate, async (req, res) => {
  if (req.actor.kind !== 'user') throw forbidden('Ask your contractor to reset your PIN');
  const data = validate(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  if (!(await req.actor.doc.checkPassword(data.currentPassword))) throw badRequest('Current password is incorrect');
  await req.actor.doc.setPassword(data.newPassword);
  await req.actor.doc.save();
  res.json({ message: 'Password changed' });
});

/**
 * Delete account. Engineers lose all their projects (with updates, requests and laborers);
 * clients are removed from their projects and their requests are deleted.
 */
router.delete('/me', authenticate, async (req, res) => {
  if (req.actor.kind !== 'user') throw forbidden();
  const { password: pw } = validate(z.object({ password: z.string().min(1, 'Enter your password') }), req.body);
  const user = req.actor.doc;
  if (!(await user.checkPassword(pw))) throw badRequest('Password is incorrect');

  if (user.role === 'engineer') {
    const projects = await Project.find({ engineer: user._id });
    const projectIds = projects.map((p) => p._id);
    const updates = await Update.find({ project: { $in: projectIds } });
    deleteUploads(updates.flatMap((u) => [...u.photos, u.voiceNoteUrl]));
    deleteUploads(projects.map((p) => p.coverImage));
    await Promise.all([
      Update.deleteMany({ project: { $in: projectIds } }),
      Request.deleteMany({ project: { $in: projectIds } }),
      Laborer.deleteMany({ engineer: user._id }),
      Project.deleteMany({ engineer: user._id }),
    ]);
  } else {
    await Promise.all([
      Project.updateMany({ clients: user._id }, { $pull: { clients: user._id } }),
      Request.deleteMany({ client: user._id }),
    ]);
  }
  await Notification.deleteMany({ user: user._id });
  await user.deleteOne();
  res.json({ message: 'Account deleted' });
});

export default router;
