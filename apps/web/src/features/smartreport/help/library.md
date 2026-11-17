# Smart report library

## Purpose

The library holds every sentence, rule and setting that smart summaries are built from. Patients only ever see wording that is in an approved library version.

## Statuses

- **Draft**: being written. Only a draft can be changed.
- **In review**: submitted and waiting for the named pathologist. Read-only.
- **Approved** (shown as Active): in use. There is only one active approved version per lab.
- **Retired**: replaced by a newer approved version. Kept for the record.

## Columns

Version, Status, Language (English or Nepali), Approved by, Approved on, Updated.

## Actions

- **New draft** menu: From active version, From starter draft, or From version. The starter draft gives you ready-made wording to edit and check. The button is disabled while a draft or a version in review already exists.
- Open a draft to edit it. Open any other version to read it. A version in review opens the review screen.

## Good to know

Approving a new version does not change summaries that are already approved. New summaries use the new version. Summaries still waiting for review can be rebuilt with it.
