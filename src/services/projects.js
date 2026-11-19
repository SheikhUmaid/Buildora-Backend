import mongoose from 'mongoose';
import { Project, Update, Request } from '../models/index.js';
import { generateInviteCode } from '../utils/inviteCode.js';

export const PUBLIC_USER_FIELDS = 'name phone email role profession title company bio location yearsExperience avatarUrl';
export const CLIENT_FIELDS = 'name phone email avatarUrl';

export async function uniqueInviteCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateInviteCode();
    if (!(await Project.exists({ inviteCode: code }))) return code;
  }
  throw new Error('Could not generate a unique invite code');
}

/** Recalculate denormalised counters after updates are added, edited or removed. */
export async function refreshProjectStats(projectId) {
  const id = new mongoose.Types.ObjectId(String(projectId));
  const [agg] = await Update.aggregate([
    { $match: { project: id } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        photos: { $sum: { $size: '$photos' } },
        last: { $max: '$date' },
        peak: { $max: '$totalLaborers' },
      },
    },
  ]);
  await Project.updateOne(
    { _id: id },
    {
      updatesCount: agg?.count ?? 0,
      photosCount: agg?.photos ?? 0,
      lastUpdateAt: agg?.last ?? null,
      peakLaborers: agg?.peak ?? 0,
    },
  );
}

/** Count of open (not done) requests per project id. */
export async function openRequestCounts(projectIds, extraFilter = {}) {
  if (!projectIds.length) return {};
  const rows = await Request.aggregate([
    { $match: { project: { $in: projectIds.map((x) => new mongoose.Types.ObjectId(String(x))) }, status: { $ne: 'done' }, ...extraFilter } },
    { $group: { _id: '$project', n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id.toString(), r.n]));
}

/** Whole months between two dates, at least 1. */
export function monthsBetween(start, end = new Date()) {
  if (!start) return 0;
  const days = (new Date(end) - new Date(start)) / 86_400_000;
  return Math.max(1, Math.round(days / 30.44));
}
