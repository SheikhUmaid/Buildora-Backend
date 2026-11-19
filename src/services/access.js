import mongoose from 'mongoose';
import { Project } from '../models/index.js';
import { notFound, forbidden, badRequest } from '../utils/http.js';

export function assertObjectId(id, label = 'id') {
  if (!mongoose.isValidObjectId(id)) throw badRequest(`Invalid ${label}`);
}

/** Can this actor see the project at all? */
export function canView(actor, project) {
  const pid = project._id.toString();
  switch (actor.role) {
    case 'engineer':
      return project.engineer.toString() === actor.id;
    case 'client':
      return project.clients.some((c) => (c._id ?? c).toString() === actor.id);
    case 'laborer':
      return actor.doc.projects.some((p) => p.toString() === pid);
    default:
      return false;
  }
}

/** Mongo filter for all projects visible to the actor. */
export function visibleProjectsFilter(actor) {
  switch (actor.role) {
    case 'engineer':
      return { engineer: actor.id };
    case 'client':
      return { clients: actor.id };
    case 'laborer':
      return { _id: { $in: actor.doc.projects } };
    default:
      return { _id: null };
  }
}

/** Load a project and assert access. `owner: true` requires the owning engineer. */
export async function loadProject(actor, projectId, { owner = false } = {}) {
  assertObjectId(projectId, 'project id');
  const project = await Project.findById(projectId);
  if (!project) throw notFound('Project not found');
  if (owner) {
    if (actor.role !== 'engineer' || project.engineer.toString() !== actor.id) {
      throw forbidden('Only the project engineer can do this');
    }
  } else if (!canView(actor, project)) {
    throw forbidden('You are not part of this project');
  }
  return project;
}

/**
 * Clients must not see the budget when the engineer has hidden it.
 * Returns a plain object safe to send to this actor.
 */
export function projectForActor(actor, project) {
  const json = project.toJSON();
  if (actor.role !== 'engineer') {
    delete json.inviteCode;
    if (!project.budgetVisible) json.budget = null;
    if (actor.role === 'laborer') {
      json.budget = null;
      delete json.feedback;
    }
  }
  return json;
}
