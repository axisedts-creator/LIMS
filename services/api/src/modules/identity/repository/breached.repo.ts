// Breached-password lookup (AU-T4; 05-SCHEMA §6/§10.3): app.identity_is_breached is INVOKER over the class-G table. Fails closed:
// a malformed hash or an empty result is an error, never a silent "not breached".
import type { Tx } from '../../../core/db/tx.js';

const SQL = 'SELECT app.identity_is_breached($1::bytea) AS breached';

export function createBreachedRepo() {
  return {
    async isBreached(tx: Pick<Tx, 'query'>, sha1: Buffer): Promise<boolean> {
      if (!Buffer.isBuffer(sha1) || sha1.length !== 20) throw new Error('breached.repo: sha1 must be a 20-byte Buffer');
      const { rows } = await tx.query(SQL, [sha1]);
      const v = rows[0]?.breached;
      if (typeof v !== 'boolean') throw new Error('breached.repo: no result');
      return v;
    },
  };
}
