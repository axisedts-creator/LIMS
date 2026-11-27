import subprocess

files = [
    'apps/web/src/core/shell/Rail.tsx',
    'apps/web/src/core/shell/ShellFrame.tsx',
    'apps/web/src/features/lab/components/grid/ResultGrid.tsx',
    'apps/web/src/features/lab/server/read.server.ts',
    'packages/ui/src/components/EditableGrid/EditableGrid.tsx',
]

cmd = ['git', 'diff', '--no-color', 'HEAD', '--'] + files
res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=r'C:\LIMS')
if res.returncode != 0:
    print("Error:", res.stderr)
else:
    # Ensure unix LF line endings
    patch_text = res.stdout.replace('\r\n', '\n')
    with open(r'C:\LIMS\ui.patch', 'wb') as f:
        f.write(patch_text.encode('utf-8'))
    print("ui.patch written successfully, size:", len(patch_text), "bytes")
