# T0D-12b dispute (writer)

Tests: phase1-display.test.tsx
- `CodeBlock > default shows a Copy button that writes the exact value to the clipboard`
- `SecretRevealOnce > Copy writes the exact secret to the clipboard`

Why they are wrong: each test installs `navigator.clipboard = { writeText: vi.fn() }` and *then* calls `user()` (= `userEvent.setup()`).
`setup()` always runs `attachClipboardStubToView(window)` (user-event 14.6.8 dist/esm/setup/setup.js:56), which
replaces `navigator.clipboard` with its own stub. The component's `navigator.clipboard.writeText(value)` therefore hits
the user-event stub, never the `vi.fn()`. No natural implementation can pass; only capturing `navigator.clipboard`
at render time would, which is test-shaped code.

Fix proposal (tester): either call `const u = user()` before `defineProperty`, or follow the existing IdText test
(data-display.test.tsx:166) and assert `expect(await navigator.clipboard.readText()).toBe(value)`.
Both components call `navigator.clipboard.writeText(value)` with the exact value on press.
