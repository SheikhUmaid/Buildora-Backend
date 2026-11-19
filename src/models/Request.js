import mongoose from 'mongoose';
import { toJsonPlugin } from '../utils/serialize.js';

export const REQUEST_TYPES = ['question', 'change', 'approval', 'call'];
export const REQUEST_STATUSES = ['new', 'in_progress', 'done'];

const replySchema = new mongoose.Schema({
  authorId: { type: mongoose.Schema.Types.ObjectId, required: true },
  authorName: { type: String, required: true },
  authorRole: { type: String, enum: ['client', 'engineer'], required: true },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  createdAt: { type: Date, default: Date.now },
});

/** A client question / change request / approval / call-back request, optionally tied to an update. */
const requestSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    update: { type: mongoose.Schema.Types.ObjectId, ref: 'Update' },
    type: { type: String, enum: REQUEST_TYPES, required: true },
    message: { type: String, trim: true, maxlength: 300, default: '' },
    photos: [{ type: String }],
    voiceNoteUrl: { type: String, default: '' },
    urgent: { type: Boolean, default: false },
    status: { type: String, enum: REQUEST_STATUSES, default: 'new', index: true },
    seenAt: Date,
    resolvedAt: Date,
    replies: [replySchema],
  },
  { timestamps: true },
);

requestSchema.plugin(toJsonPlugin);

export const Request = mongoose.model('Request', requestSchema);
