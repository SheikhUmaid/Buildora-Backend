import mongoose from 'mongoose';
import { toJsonPlugin } from '../utils/serialize.js';

export const PROJECT_STATUSES = ['in_progress', 'on_hold', 'completed'];

const feedbackSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName: String,
  rating: { type: Number, min: 1, max: 5 },
  text: { type: String, maxlength: 600 },
  showOnPortfolio: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

const portfolioSchema = new mongoose.Schema(
  {
    included: { type: Boolean, default: true }, // "Remove" sets this to false
    hidden: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    story: { type: String, maxlength: 1500, default: '' },
    highlights: [{ type: String }], // photo URLs; the first is the cover
    visibleToClients: { type: Boolean, default: true },
    showExactLocation: { type: Boolean, default: true },
    showClientName: { type: Boolean, default: false },
  },
  { _id: false },
);

const projectSchema = new mongoose.Schema(
  {
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
    name: { type: String, required: true, trim: true, maxlength: 100 },
    location: { type: String, trim: true, default: '' }, // short, e.g. "Whitefield, Bengaluru"
    address: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    coverImage: { type: String, default: '' },
    status: { type: String, enum: PROJECT_STATUSES, default: 'in_progress', index: true },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    startDate: { type: Date, default: Date.now },
    expectedFinish: Date,
    completedAt: Date,
    budget: { type: Number, min: 0, default: 0 }, // rupees
    budgetVisible: { type: Boolean, default: true },
    inviteCode: { type: String, required: true, unique: true },
    lastUpdateAt: Date,
    updatesCount: { type: Number, default: 0 },
    photosCount: { type: Number, default: 0 },
    peakLaborers: { type: Number, default: 0 },
    portfolio: { type: portfolioSchema, default: () => ({}) },
    feedback: [feedbackSchema],
  },
  { timestamps: true },
);

projectSchema.plugin(toJsonPlugin);

export const Project = mongoose.model('Project', projectSchema);
