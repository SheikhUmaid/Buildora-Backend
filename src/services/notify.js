import { Notification, User } from '../models/index.js';

/**
 * Store in-app notifications. Apps poll GET /api/notifications.
 * This is the single place to plug in push delivery (FCM/APNs) later.
 */
export async function notify(userIds, payload) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
  if (!ids.length) return;
  const enabled = await User.find({ _id: { $in: ids }, notificationsEnabled: true }).select('_id');
  if (!enabled.length) return;
  try {
    await Notification.insertMany(enabled.map((u) => ({ ...payload, user: u._id })));
  } catch (err) {
    // Notifications are best effort; never fail the main request because of them.
    console.error('notify failed', err);
  }
}
