// Image imports (*.png, *.webp, ...) get their types from Next. next-env.d.ts does the same but is written by `next dev` /
// `next build` and is not tracked, so a clean checkout (CI typecheck) needs this file.
/// <reference types="next/image-types/global" />
