# Derived DB image (02-TRD s9.1): supabase/postgres 17.6.1.136 + pgBackRest 2.60.0.
# Base digest as recorded live in db/meta/decisions/SP-3.md. Base = Alpine 3.23 per upstream
# Dockerfile-17 (TRD s9.1 VERIFIED); the apk package names below are UNVERIFIED -> T-09 spike on CI.
# zz-lims.conf, pg_hba.conf, pgbackrest.conf and the cipher passes are mounted by compose
# (02-TRD s7.2), never baked in.

# ---- builder: pgBackRest from the release tarball, checksum-verified (TRD s9.1)
FROM supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00 AS build
ARG PGBACKREST_VERSION=2.60.0
# sha256 of release/2.60.0.tar.gz, computed with sha256sum on the tarball fetched by curl on 2026-11-07 (LD-34).
# The build still fails closed if it is emptied.
ARG PGBACKREST_TARBALL_SHA256=7409309d5b69365ecc21f3f9c377056a6a4cdc327ce062e41354a442989d22d0
RUN apk add --no-cache build-base meson ninja pkgconf curl \
        openssl-dev libpq-dev libxml2-dev zlib-dev lz4-dev zstd-dev bzip2-dev yaml-dev libssh2-dev
WORKDIR /src
RUN test -n "${PGBACKREST_TARBALL_SHA256}" \
    && curl -fsSL -o pgbackrest.tar.gz \
        "https://github.com/pgbackrest/pgbackrest/archive/release/2.60.0.tar.gz" \
    && echo "${PGBACKREST_TARBALL_SHA256}  pgbackrest.tar.gz" | sha256sum -c - \
    && tar xzf pgbackrest.tar.gz --strip-components=1 \
    && meson setup build \
    && ninja -C build \
    && build/src/pgbackrest version | grep -qx "pgBackRest ${PGBACKREST_VERSION}"

# ---- final: same pinned base + the binary and its runtime libraries
FROM supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00
RUN apk add --no-cache libssh2 lz4-libs zstd-libs libxml2 libbz2 yaml libpq openssl \
    && install -d -o postgres -g postgres -m 0750 \
        /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest /etc/pgbackrest
COPY --from=build /src/build/src/pgbackrest /usr/bin/pgbackrest
