import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User, Laborer } from '../models/index.js';
import { unauthorized, forbidden } from '../utils/http.js';

/**
 * Tokens carry { sub, kind } where kind is "user" (client/engineer) or "laborer".
 * After authentication `req.actor` is:
 *   { kind: 'user' | 'laborer', role: 'client' | 'engineer' | 'laborer', id: string, doc }
 */
export function signToken(kind, id) {
  return jwt.sign({ sub: id.toString(), kind }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export async function authenticate(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw unauthorized('Session expired, please log in again');
  }

  if (payload.kind === 'laborer') {
    const laborer = await Laborer.findById(payload.sub);
    if (!laborer) throw unauthorized('Account not found');
    if (!laborer.active) throw forbidden('Your login has been deactivated by your contractor');
    req.actor = { kind: 'laborer', role: 'laborer', id: laborer._id.toString(), doc: laborer };
  } else {
    const user = await User.findById(payload.sub);
    if (!user) throw unauthorized('Account not found');
    req.actor = { kind: 'user', role: user.role, id: user._id.toString(), doc: user };
  }
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.actor || !roles.includes(req.actor.role)) throw forbidden();
  next();
};
