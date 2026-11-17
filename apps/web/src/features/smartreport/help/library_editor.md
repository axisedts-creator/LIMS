# Library editor

## Purpose

Write and check one library draft. Each tab has its own Save. Nothing here is visible to patients until the version is approved.

## Tabs and fields

- **Settings & score**: language (English or Nepali in Devanagari), change summary, the health score settings for formula hs-1 (credits, minimum body systems, Good and Fair limits, critical rule), borderline margin, trends, and the maximum number of advice and follow-up items. A card explains hs-1 in words.
- **Body systems**: the body-system groups (Groups) shown to the patient, with display names, weight (0 = shown but not scored), order and visibility.
- **Analyte mapping**: which analyte belongs to which group, and whether it counts in the score.
- **Texts**: findings, advice, follow-up, disclaimer and score explanation. Keys and kinds cannot change after creation. Nepali text fields use `lang="ne"`.
- **Rules**: when each text is chosen (trigger, direction, minimum severity, priority). Follow-up rules need a test and an interval in days.
- **Check & submit**: Run checks, Preview (synthetic example or a real order), then Submit for approval.

## Placeholders

Under each text, chips show the placeholders allowed for that kind. Click one to insert it. Digits, links and blocked words are rejected as you type, and again by the server.

## Locked versions

Only a draft can be edited. Other versions are read-only and show "This version is {status}; create a new draft to change it." Submit is disabled while checks report errors.
