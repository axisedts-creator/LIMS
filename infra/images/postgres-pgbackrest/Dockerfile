# Derived DB image (02-TRD s9.1). T-04 skeleton: base image only.
# Base = supabase/postgres:17.6.1.136, digest as recorded live in db/meta/decisions/SP-3.md.
# The WAL archiving tool is added by T-09.
# zz-lims.conf and pg_hba.conf are mounted by compose (02-TRD s7.2), never baked in.
FROM supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00
