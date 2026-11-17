# Breakpoint import

Breakpoint tables are loaded from a CSV file at /micro/breakpoint-sets. Each table belongs to one standard (CLSI, EUCAST or ECOFF) and one version.

## Licence responsibility

The file must contain only breakpoint data your laboratory is licensed to use. You are responsible for holding the licence for every standard and version you import. The system does not supply breakpoint data.

## File format

- UTF-8 text. A byte order mark is removed. Invalid UTF-8 or a NUL byte is rejected with file.encoding_invalid.
- RFC 4180 quoting, comma separator, LF or CRLF line ends. Blank lines are ignored. Lines starting with # are comments.
- The first line must be exactly this header, in this order:

```
organism_scope,organism_code,antibiotic_code,method,specimen_site_code,qualifier_code,category_code,lower_value,lower_inclusive,upper_value,upper_inclusive,note
```

- One line is one band. Lines that share the first six columns form one row; band numbers follow the order of appearance, at most six bands.
- organism_scope is organism, group or any. With any, leave organism_code empty.
- method is mic or zone_diameter. An empty specimen_site_code or qualifier_code means any.
- Values are numbers with up to 8 digits and up to 6 decimals, or empty for unbounded. lower_inclusive and upper_inclusive are true or false; empty means true.
- note is up to 200 characters.

A template with the header and a licence reminder is available in the import dialog.

## Checking the import

The file is checked in the background. Open the set to see the status and the list of issues. Errors block activation; warnings do not. A wrong header gives file.header_mismatch. Two bands of the same row that cover the same values give row.bands_overlap. Each issue names the field and row.

## Activation

Preview the set, then activate it. Activation needs a second person. The previous table for the same standard is closed on the activation date.
