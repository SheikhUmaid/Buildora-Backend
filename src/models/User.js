import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { toJsonPlugin } from '../utils/serialize.js';

/**
 * A person with an email/password account.
 * role "client"   -> home owner using the client app
 * role "engineer" -> engineer / contractor / builder using the worker app
 * (Laborers are a separate collection with phone + PIN logins managed by an engineer.)
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['client', 'engineer'], required: true },

    // Engineer profile fields (unused for clients)
    profession: { type: String, enum: ['Engineer', 'Contractor', 'Builder'], default: 'Engineer' },
    title: { type: String, trim: true, default: '' }, // e.g. "Civil Engineer"
    company: { type: String, trim: true, default: '' },
    bio: { type: String, trim: true, maxlength: 400, default: '' },
    location: { type: String, trim: true, default: '' },
    yearsExperience: { type: Number, min: 0, max: 80, default: 0 },

    avatarUrl: { type: String, default: '' },
    notificationsEnabled: { type: Boolean, default: true },

    resetCode: String,
    resetCodeExpires: Date,
  },
  { timestamps: true },
);

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

userSchema.methods.checkPassword = function checkPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

/** Public card used when embedding a user in other responses. */
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    name: this.name,
    phone: this.phone,
    email: this.email,
    role: this.role,
    profession: this.profession,
    title: this.title,
    company: this.company,
    bio: this.bio,
    location: this.location,
    yearsExperience: this.yearsExperience,
    avatarUrl: this.avatarUrl,
  };
};

userSchema.plugin(toJsonPlugin);

export const User = mongoose.model('User', userSchema);
