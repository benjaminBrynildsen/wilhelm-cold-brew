// Resolves `pg` to the in-memory shim so the app's own db.js is what runs.
const SHIM = new URL('./pg-mem-shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'pg') return { url: SHIM, shortCircuit: true };
  return next(specifier, context);
}
