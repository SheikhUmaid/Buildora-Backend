import mongoose from 'mongoose';
import { toJsonPlugin } from '../utils/serialize.js';

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // update.new | request.new | request.reply | request.status | project.status | project.joined
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    update: { type: mongoose.Schema.Types.ObjectId, ref: 'Update' },
    request: { type: mongoose.Schema.Types.ObjectId, ref: 'Request' },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

notificationSchema.plugin(toJsonPlugin);

export const Notification = mongoose.model('Notification', notificationSchema);
