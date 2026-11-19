/** Mongoose plugin: expose `id` instead of `_id`, drop `__v` and any hidden fields. */
export function toJsonPlugin(schema) {
  const transform = (_doc, ret) => {
    ret.id = ret._id?.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash;
    delete ret.resetCode;
    delete ret.resetCodeExpires;
    return ret;
  };
  schema.set('toJSON', { virtuals: true, transform });
  schema.set('toObject', { virtuals: true, transform });
}
