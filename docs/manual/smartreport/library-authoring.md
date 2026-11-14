# Library authoring

The library is edited at `/smartreport/library`. Writing needs the permission smartreport.template.manage. Approving needs a different permission (see [approval responsibilities](approval-responsibilities.md)).

## Statuses

A version moves draft, then in review, then approved, then retired. Only a draft can be edited. A lab has one active approved version. Approving a new one retires the old one.

## Start a draft

Choose New draft: from the active version, from the starter draft (ready-made wording to edit), or from an older version. Only one draft or in-review version can exist at a time.

## The editor

Open a draft at `/smartreport/library/{library_version_id}`. Each tab saves on its own.

1. **Settings & score**: language (English or Nepali), health score settings, trends, limits.
2. **Body systems**: the groups shown to patients, their names and weights.
3. **Analyte mapping**: which analytes belong to which group.
4. **Texts**: the sentences. Use the placeholder chips to insert values. Only allowed placeholders for that kind of text are accepted.
5. **Rules**: which text appears for which finding, with direction, minimum severity and priority. Follow-up rules need an interval in days.
6. **Check & submit**: Run checks, then Preview with a synthetic example or a real order, then Submit for approval.

## Nepali

When the library language is Nepali, every text needs Nepali wording, written in Devanagari. Fields use `lang="ne"` so they display correctly.

## Checks

Checks look for unknown placeholders, digits and links in text, blocked wording terms (see `/smartreport/wording`), missing mappings and missing intervals. Submit is disabled while errors remain. A fresh starter draft only needs its analyte mappings added.
