// tools/generate-pdf-manual.mjs — Generate high-quality PDF manual from markdown
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../apps/web/node_modules/@playwright/test');

const MD_PATH = 'C:/Users/rauna/.gemini/antigravity/brain/f9b1ad05-5543-4490-9b6b-80019434a2e8/lims_baby_step_user_manual_registration_to_dispatch.md';
const OUT_ARTIFACT_PATH = 'C:/Users/rauna/.gemini/antigravity/brain/f9b1ad05-5543-4490-9b6b-80019434a2e8/lims_baby_step_user_manual_registration_to_dispatch.pdf';
const OUT_WORKSPACE_PATH = 'C:/LIMS/lims_baby_step_user_manual_registration_to_dispatch.pdf';

const markdownContent = readFileSync(MD_PATH, 'utf8');

const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>LIMS User Manual</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    @page {
      size: A4;
      margin: 18mm 15mm 20mm 15mm;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.6;
      color: #1e293b;
      margin: 0;
      padding: 0;
      background: #ffffff;
    }

    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      border-bottom: 2px solid #3b82f6;
      padding-bottom: 8px;
      margin-top: 24px;
      margin-bottom: 12px;
      page-break-after: avoid;
    }

    h2 {
      font-size: 18px;
      font-weight: 600;
      color: #1e3a8a;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 6px;
      margin-top: 20px;
      margin-bottom: 10px;
      page-break-after: avoid;
    }

    h3 {
      font-size: 15px;
      font-weight: 600;
      color: #1e293b;
      margin-top: 16px;
      margin-bottom: 8px;
      page-break-after: avoid;
    }

    h4 {
      font-size: 13.5px;
      font-weight: 600;
      color: #334155;
      margin-top: 12px;
      margin-bottom: 6px;
      page-break-after: avoid;
    }

    p, li {
      color: #334155;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 12px;
      page-break-inside: avoid;
    }

    th, td {
      border: 1px solid #cbd5e1;
      padding: 7px 10px;
      text-align: left;
    }

    th {
      background-color: #f1f5f9;
      font-weight: 600;
      color: #0f172a;
    }

    tr:nth-child(even) td {
      background-color: #f8fafc;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11.5px;
      background-color: #f1f5f9;
      color: #0f172a;
      padding: 2px 5px;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
    }

    pre {
      background-color: #0f172a;
      color: #f8fafc;
      padding: 12px 14px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 11.5px;
      line-height: 1.45;
      page-break-inside: avoid;
    }

    pre code {
      background-color: transparent;
      color: inherit;
      padding: 0;
      border: none;
    }

    .callout {
      border-left: 4px solid;
      padding: 10px 14px;
      margin: 14px 0;
      border-radius: 0 6px 6px 0;
      page-break-inside: avoid;
    }

    .callout-note {
      border-color: #3b82f6;
      background-color: #eff6ff;
      color: #1e40af;
    }

    .callout-tip {
      border-color: #10b981;
      background-color: #ecfdf5;
      color: #065f46;
    }

    .callout-important {
      border-color: #8b5cf6;
      background-color: #f5f3ff;
      color: #5b21b6;
    }

    .callout-warning {
      border-color: #f59e0b;
      background-color: #fffbeb;
      color: #92400e;
    }

    .callout-title {
      font-weight: 700;
      margin-bottom: 4px;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }

    .mermaid {
      margin: 16px 0;
      text-align: center;
      page-break-inside: avoid;
    }

    .page-break {
      page-break-before: always;
    }

    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }

    .badge-blue { background: #dbeafe; color: #1e40af; }
    .badge-green { background: #dcfce7; color: #166534; }
  </style>
</head>
<body>
  <div id="content"></div>

  <script>
    const rawMarkdown = ${JSON.stringify(markdownContent)};

    // Custom renderer for callouts and mermaid
    const renderer = new marked.Renderer();
    const originalBlockquote = renderer.blockquote.bind(renderer);

    renderer.blockquote = function(token) {
      const text = typeof token === 'string' ? token : (token.text || token.raw || '');
      if (text.includes('[!NOTE]')) {
        const body = text.replace(/\[!NOTE\]\s*/i, '');
        return '<div class="callout callout-note"><div class="callout-title">Note</div><p>' + body + '</p></div>';
      }
      if (text.includes('[!TIP]')) {
        const body = text.replace(/\[!TIP\]\s*/i, '');
        return '<div class="callout callout-tip"><div class="callout-title">Tip</div><p>' + body + '</p></div>';
      }
      if (text.includes('[!IMPORTANT]')) {
        const body = text.replace(/\[!IMPORTANT\]\s*/i, '');
        return '<div class="callout callout-important"><div class="callout-title">Important</div><p>' + body + '</p></div>';
      }
      if (text.includes('[!WARNING]')) {
        const body = text.replace(/\[!WARNING\]\s*/i, '');
        return '<div class="callout callout-warning"><div class="callout-title">Warning</div><p>' + body + '</p></div>';
      }
      return originalBlockquote(token);
    };

    const originalCode = renderer.code.bind(renderer);
    renderer.code = function(code, lang) {
      const src = typeof code === 'string' ? code : (code.text || code.raw || '');
      const language = typeof code === 'object' && code.lang ? code.lang : lang;
      if (language === 'mermaid') {
        return '<div class="mermaid">' + src + '</div>';
      }
      return originalCode(code, lang);
    };

    marked.setOptions({ renderer });
    document.getElementById('content').innerHTML = marked.parse(rawMarkdown);

    // Initialize mermaid
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
    mermaid.run().then(() => {
      window.renderComplete = true;
    }).catch((err) => {
      console.error(err);
      window.renderComplete = true;
    });
  </script>
</body>
</html>`;

async function main() {
  console.log('Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', (err) => console.error('PAGE ERROR:', err));

  console.log('Setting HTML content and rendering diagrams...');
  await page.setContent(htmlTemplate, { waitUntil: 'networkidle' });

  // Wait for mermaid and marked to finish rendering
  await page.waitForFunction(() => window.renderComplete === true, null, { timeout: 30000 });
  await page.waitForTimeout(1000); // Allow styles to settle

  console.log('Generating PDF...');
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: {
      top: '18mm',
      bottom: '20mm',
      left: '15mm',
      right: '15mm',
    },
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="font-size: 8px; color: #94a3b8; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between; font-family: sans-serif;">
        <span>LIMS Operations & Training Manual</span>
        <span>Standard & Solo Fast-Track Mode</span>
      </div>
    `,
    footerTemplate: `
      <div style="font-size: 8px; color: #94a3b8; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between; font-family: sans-serif;">
        <span>Confidential - For Internal Lab Training & Operational Verification</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `,
  });

  writeFileSync(OUT_ARTIFACT_PATH, pdfBuffer);
  console.log(`Saved PDF artifact to: ${OUT_ARTIFACT_PATH}`);

  writeFileSync(OUT_WORKSPACE_PATH, pdfBuffer);
  console.log(`Saved copy to workspace: ${OUT_WORKSPACE_PATH}`);

  await browser.close();
  console.log('PDF generation finished successfully!');
}

main().catch((err) => {
  console.error('PDF generation error:', err);
  process.exit(1);
});
