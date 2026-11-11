// CI job `supabase-pin` (02-TRD §15.1, DoD §1.7, 08 A25 D-208): image digests in tools/devstack/compose.yaml
// must equal infra/compose/supabase/upstream/UPSTREAM.lock.
// Usage: node tools/lint/check-supabase-pin.ts --compose <compose.yaml> --lock <UPSTREAM.lock>
// Lock entries are tokens `<repo>@sha256:<64 hex>`; every lock image must appear in compose (`image:`) with that
// digest, and no compose service may name a lock repo by tag or another digest. Compose images not in the lock are ignored.
// Exit 0 equal, 1 differ, 2 bad usage / unreadable file / lock without digests (fail closed).
import { readFileSync } from 'node:fs';

class Usage extends Error {}
const TOKEN = /([A-Za-z0-9][\w.\/:-]*?)@sha256:([0-9a-f]{64})\b/g;

function repoOf(ref: string): string {
  const noDigest = ref.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  return colon > slash ? noDigest.slice(0, colon) : noDigest; // strip :tag, keep registry:port
}

function main(argv: string[]): number {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--compose', '--lock'].includes(argv[i]) || argv[i + 1] === undefined) throw new Usage(`bad argument ${argv[i]}`);
    a[argv[i]] = argv[i + 1];
  }
  if (!a['--compose'] || !a['--lock']) throw new Usage('need --compose and --lock');
  let compose: string, lockText: string;
  try {
    compose = readFileSync(a['--compose'], 'utf8');
    lockText = readFileSync(a['--lock'], 'utf8');
  } catch (e) {
    throw new Usage(`cannot read input: ${(e as Error).message}`);
  }
  const lock = new Map<string, string>();
  for (const m of lockText.matchAll(TOKEN)) {
    // key by repo (tag stripped) so a canonical `repo:tag@sha256:<d>` lock line matches compose (review r1 item 4)
    const repo = repoOf(m[1]);
    const prev = lock.get(repo);
    if (prev && prev !== m[2]) throw new Usage(`lock pins ${repo} to two digests`);
    lock.set(repo, m[2]);
  }
  if (!lock.size) throw new Usage('lock contains no <repo>@sha256:<digest> entries');

  const images = [...compose.matchAll(/^\s*-?\s*image:\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]);
  const errs: string[] = [];
  for (const [repo, digest] of lock) {
    const uses = images.filter((i) => repoOf(i) === repo);
    if (!uses.length) errs.push(`${repo}: pinned in lock but not used in compose`);
    for (const u of uses) {
      const d = /@sha256:([0-9a-f]{64})$/.exec(u)?.[1];
      if (d !== digest) errs.push(`${repo}: compose has ${u}, lock pins sha256:${digest}`);
    }
  }
  for (const e of errs) console.error(`supabase-pin: ${e}`);
  return errs.length ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`supabase-pin: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
