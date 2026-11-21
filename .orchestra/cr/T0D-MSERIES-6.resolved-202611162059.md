Title: CR-C0-0D-MSERIES-6: writer sandbox cannot read the hero photo source C:\LIMS-state\assets\auth-lab-hero.webp
From chunk: C0-0D            To owner: lead (orchestra / LD-287)
Type: ui-kit
Blocking? yes — T0D-MSERIES-6 step (1) ASSET, and therefore every photo test (asset exists, size, sha256, HERO_PHOTO static import).
Problem: the brief (LD-287) makes the writer copy C:\LIMS-state\assets\auth-lab-hero.webp to packages/ui/assets/brand/lab-hero.webp with a shell copy. In this writer session the sandbox allows only C:\LIMS-lanes\C0-0D; `cp /c/LIMS-state/assets/auth-lab-hero.webp ...` and `ls /c/LIMS-state/assets/` were refused ("path is outside the working directories for this session"). The brief says: if the source file cannot be read, write a change request and stop. No download was attempted, no other image used, no code changed.
Proposed change (exact): one of
  (a) the lead/orchestrator copies the file into the lane before the writer runs: `copy C:\LIMS-state\assets\auth-lab-hero.webp C:\LIMS-lanes\C0-0D\packages\ui\assets\brand\lab-hero.webp` (expect 52418 bytes, sha256 da79c2154ec250618107a02c1faa5602d86af7839f3227afc042b118a9f5149a), and tells the tester stage not to delete it; or
  (b) re-run the writer with C:\LIMS-state\assets added as a readable directory (e.g. `--add-dir C:\LIMS-state\assets`).
Backward compatible? yes — new file only.
Tenant/security impact: none from the CR itself (same asset, same origin, CSP img-src self unchanged). LD-287 lead concern about Metro Labs staff/logo on the shared sign-in page stands.
IRD/regulatory impact: none.
Alternatives considered: downloading from myhealthnow.live (forbidden by brief); placeholder image (forbidden: "use no other image").
Tests that will prove it: .orchestra/notes/T0D-MSERIES-6-verify.cmd (entry-hero-photo.test.tsx asset size/sha256 cases, m6.photo.test.tsx HERO_PHOTO cases).
