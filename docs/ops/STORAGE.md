# Object storage (T0B-STORAGE-1, LD-316)

Founder decision (2026-11-17 08:48 NPT): Supabase Storage while testing, the lab own server later. The API speaks plain S3
(AWS Signature V4, `services/api/src/core/storage/s3.ts`), so moving changes only the endpoint and the keys, never the code.

No value is ever written into the repository. The names below are set in the host environment (Render dashboard, the server
service file); `.env.example` lists them with empty values.

| Name | Meaning |
|---|---|
| `STORAGE_PROVIDER` | `s3_compatible` or `none`. Unset or `none`: the API keeps streaming files through itself (today's behaviour). |
| `STORAGE_ENDPOINT` | S3 endpoint URL, `https://` (no user or password in it). |
| `STORAGE_REGION` | Region shown by the provider. |
| `STORAGE_BUCKET` | The one private bucket. Each logical bucket (`reports`, `frontdesk-trf`, ...) is a key prefix inside it. |
| `STORAGE_ACCESS_KEY_ID` | S3 access key id. |
| `STORAGE_SECRET_ACCESS_KEY` | S3 secret access key. Never pasted into chat, a ticket, a commit or a log. |
| `STORAGE_FORCE_PATH_STYLE` | `true` (endpoint/bucket/key) or `false` (bucket.endpoint/key). Supabase and MinIO: `true`. |

Start up refuses a half set configuration (for example a bucket without `STORAGE_PROVIDER`, or `s3_compatible` with a missing
key) with a `config:` message that names the missing keys and never a value.

## Testing: Supabase test project (founder steps)

Real patient data must not be uploaded to the free Supabase test project; use synthetic files only.

1. Supabase dashboard of the TEST project, Storage: create one private bucket (for example `lims-test`). Do not make it public.
2. Storage settings, S3 connection: enable the S3 protocol and copy the endpoint and region shown there.
3. Generate a new S3 access key pair there. The founder types the access key id and the secret access key directly into the host
   environment (Render dashboard, Environment). The lead never sees or types them.
4. Set `STORAGE_PROVIDER=s3_compatible`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`,
   `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_FORCE_PATH_STYLE=true`. Redeploy. A boot error starting with `config:` names what is missing.
5. To roll back, set `STORAGE_PROVIDER=none` (or remove all seven names) and redeploy.

## Later: the lab own server

1. Run any S3 compatible store on the server, for example MinIO, behind TLS. Create one private bucket and an access key limited
   to that bucket.
2. Copy the bucket contents from Supabase to the new store with an S3 copy tool (for example the MinIO client `mc mirror`),
   then compare object counts and a few sha256 values.
3. Change only the endpoint and the keys (`STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`,
   `STORAGE_SECRET_ACCESS_KEY`, and `STORAGE_BUCKET` if the name differs). No code change, no migration.

## Checking a file round trip

- Upload a small synthetic file with an S3 client using the same keys, read it back, and compare the sha256 of both copies.
- Every upload signed by the API stores its sha256 as `x-amz-meta-sha256`; a HEAD of the object must show the same value.
- After the direct routes are wired (P-2, below): upload a synthetic file above 256 KiB in the app, download it, compare sha256.

## Backup and restore

- Backup: a scheduled `mc mirror` (or equivalent) of the bucket to a second disk or location, at least daily, kept for the
  retention the lab needs; turn on bucket versioning on the own server so an overwrite or delete can be undone.
- Restore: mirror back into an empty bucket, then do the round trip check above. Run a restore drill before go live and after
  every storage change. Object storage and the database are backed up together, so a restored row never points at a missing file.

## Not done yet (P-2)

No route uses this adapter yet. Returning signed URLs to the browser needs the P-2 amendment (CR-C0-FILES-1,
`.orchestra/cr/T0B-FILES-1.nonblocking.md`): new `uploads:init` / `uploads:confirm` routes and a `mode=direct` download per module.
Until then every file still moves through the API.
