# Overview

Smart Report adds a plain-language summary to a patient's report: a score, body-system tiles, the findings outside range, simple trends, general advice and follow-up suggestions, and a disclaimer.

## What patients see

Everything a patient reads comes from two places only: approved results (numbers, flags, reference ranges, history) and wording from the lab's approved library. The lab's named pathologist approves the library, and approves each patient summary before it is shown.

## Why nothing is free-generated

Nothing is generated freely. No sentence is made up when a report is built. The system only chooses between approved sentences by fixed rules and fills in values from the results. If a rule has no approved sentence, the item is simply left out. So every sentence a patient reads can be traced to a library version and a pathologist's approval (see [approval responsibilities](approval-responsibilities.md)).

## What it is not

The summary is non-diagnostic. It is not a diagnosis, it does not replace a doctor, and it never shows prices, booking links or products. The score uses a published formula, [hs-1](health-score.md).

## Where things are

The review queue is at `/smartreport/summaries` and each summary opens at `/smartreport/summaries/{summary_id}`. The library is at `/smartreport/library` and wording terms at `/smartreport/wording`. See the [index](README.md) for all pages.
