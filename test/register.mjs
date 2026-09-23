// Entry point for `node --import ./test/register.mjs`.
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
