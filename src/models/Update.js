import mongoose from 'mongoose';
import { toJsonPlugin } from '../utils/serialize.js';

export const WORK_TYPES = [
  'Excavation', 'Foundation', 'Shuttering', 'Rebar', 'Concrete pour', 'Brickwork',
  'Plastering', 'Electrical', 'Plumbing', 'Flooring', 'Painting', 'Finishing', 'Other',
];

/** A daily site post (photos + note) by the engineer or one of their laborers. */
const updateSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    author: {
      kind: { type: String, enum: ['engineer', 'laborer'], required: true },
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      name: { type: String, required: true },
      trade: String,
    },
    date: { type: Date, required: true, index: true }, // the site day this update covers
    photos: [{ type: String }],
    note: { type: String, trim: true, maxlength: 2000, default: '' },
    voiceNoteUrl: { type: String, default: '' },
    workTypes: [{ type: String }],
    laborers: [{ _id: false, trade: String, count: { type: Number, min: 0 } }],
    totalLaborers: { type: Number, min: 0, default: 0 },
    progress: { type: Number, min: 0, max: 100 }, // project progress recorded with this update
    approvedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);

updateSchema.index({ project: 1, date: -1 });
updateSchema.index({ note: 'text' });

updateSchema.plugin(toJsonPlugin);

export const Update = mongoose.model('Update', updateSchema);
