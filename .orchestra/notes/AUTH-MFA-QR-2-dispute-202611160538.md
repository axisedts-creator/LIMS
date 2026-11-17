# AUTH-MFA-QR-2 dispute (writer)
- Test: `mfa.qr.compact.test.ts` `expectCompactShape` (line 86) forbids `/https?:/` anywhere in the compact output.
- Problem: an SVG shown via `<img src="data:image/svg+xml;base64,...">` MUST carry `xmlns="http://www.w3.org/2000/svg"` or browsers refuse to draw it. That string contains `http:`, so every compacted output fails the shape check (57 of the compact tests fail on this one regex; nothing else fails: web tests 8/8 + t12.forms 35/35 pass).
- The test's own pass-through fixtures (PATH_SVG, web `small`) carry the same xmlns, so the intent was to forbid links (`href=`/`url()`), which UNSAFE already does.
- Fix wanted from tester/arbiter: change the regex `https?:` to `href\s*=\s*["']?https?:|url\(\s*["']?https?:` (or drop it; the UNSAFE patterns check the output separately at line 204).
- Not done (would be a dodge): writing the namespace as `&#104;ttp://...` to slip past the regex. Valid XML, but obscure; arbiter may choose it if the regex must stay.
- Impl is complete in `mfaQr.ts` with the plain xmlns; the test run will go green once the regex is fixed.
