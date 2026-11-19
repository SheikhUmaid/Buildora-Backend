import mongoose from 'mongoose';
import { toJsonPlugin } from '../utils/serialize.js';

export const TRADES = ['Carpenter', 'Electrician', 'Plumber', 'Mason', 'Painter', 'Helper', 'Other'];

/**
 * Site worker created by an engineer. Logs in with phone + 4-digit PIN.
 * The PIN is stored readable so the engineer can show it again ("Login details") and
 * share it with the worker. It is only ever returned to the owning engineer.
 */
const laborerSchema = new mongoose.Schema(
  {
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true },
    pin: { type: String, required: true, select: false, match: /^\d{4}$/ },
    trade: { type: String, default: 'Helper', trim: true },
    projects: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Project' }],
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

// A phone number identifies exactly one laborer login across the system.
laborerSchema.index({ phone: 1 }, { unique: true });

laborerSchema.plugin(toJsonPlugin);

export const Laborer = mongoose.model('Laborer', laborerSchema);
