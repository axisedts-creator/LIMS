# AST entry and categories

Antimicrobial susceptibility testing (AST) results are stored as a category code together with the breakpoint standard and its version, plus the raw value exactly as measured or received. The category is not limited to three values.

## Entering a result

1. Select the isolate, then check the panel header: method (MIC or zone diameter), breakpoint standard and version.
2. Choose the breakpoint standard (CLSI, EUCAST or ECOFF). The version defaults to the active breakpoint table for that standard when one exists; otherwise type it in.
3. Enter the raw value, for example a MIC of <=0.25. If an active breakpoint table covers the organism and antibiotic, a category is suggested; accept or change it.
4. Choose the category. The list shows only the codes of the chosen standard.

A result without a standard and version cannot be reported.

## Categories by standard

- CLSI: S (susceptible), SDD (susceptible, dose dependent), I (intermediate), R (resistant), NS (non-susceptible).
- EUCAST: S, I, R.
- ECOFF: WT (wild type) and NWT (non-wild type). These describe the organism population, not treatment.

## "I" under CLSI and EUCAST

The letter I means different things. Under CLSI, I is Intermediate: a borderline result. Under EUCAST, I is "susceptible, increased exposure": the drug can work when the dose or the exposure at the site of infection is increased. Never compare an I from one standard with an I from another. SDD exists only under CLSI, and entering SDD with EUCAST is rejected.

## Colistin and polymyxin B

Under CLSI, colistin and polymyxin B accept only I and R. S is not offered, and a saved S is rejected.

## Changing the standard

Changing the standard or the version on a row means the category must be chosen again. Old report versions keep the standard and version they were sent with.
