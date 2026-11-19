// POST /users/search (02-TRD §5.3). Body query/limit only; 200 UserPage.
import { bindUser, pick } from './user.http.js';
import { guarded } from './_guard.js';

export const searchUsers = guarded('identity.user.read', bindUser((s, ctx, req) => s.searchUsers(ctx, pick(req.body, { query: 'query', limit: 'limit' }))));
