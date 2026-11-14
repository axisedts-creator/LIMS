// HC-T29 / REQ-SEC-107: behaviour of tool/ci/scan_apk.sh (CI job c17-release-binary-scan) with stub tools on PATH, so it runs
// without apktool/gitleaks installed. Proves: planted secret => fail, clean => pass, every missing input/tool => fail CLOSED.
// Runs the script with Git-for-Windows bash (override with LIMS_BASH). cwd = apps/phlebo_app.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

final _bash = Platform.environment['LIMS_BASH'] ?? (Platform.isWindows ? r'C:\Program Files\Git\bin\bash.exe' : 'bash');

String _posix(String p) {
  final s = p.replaceAll('\\', '/');
  final m = RegExp(r'^([A-Za-z]):/(.*)$').firstMatch(s);
  return m == null ? s : '/${m.group(1)!.toLowerCase()}/${m.group(2)}';
}

late Directory _tmp;
late Directory _stubs;

void _stub(String name, String body) => File('${_stubs.path}/$name').writeAsStringSync('#!/usr/bin/env bash\n$body\n');

void _allStubs({String gitleaks = 'exit 0', String apktool = ''}) {
  // fake apktool: `apktool d --no-src -f -o <dir> <apk>`; copies the APK bytes in as a lib .so so `strings` sees them
  _stub('apktool', apktool.isNotEmpty ? apktool : r'''
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { out="$2"; shift; }; apk="$1"; shift; done
mkdir -p "$out/lib/arm64-v8a"; cp "$apk" "$out/lib/arm64-v8a/libapp.so"; echo "res" > "$out/res.txt"''');
  _stub('strings', r'''[ "$1" = "-a" ] && shift; cat "$@"''');
  _stub('unzip', r'''grep -q "NOT-A-ZIP" "$2" && exit 9; exit 0''');
  _stub('gitleaks', gitleaks);
}

Future<ProcessResult> _run(List<String> args, {bool onlyStubs = true}) {
  final script = _posix(File('tool/ci/scan_apk.sh').absolute.path);
  final stubs = _posix(_stubs.path);
  final path = onlyStubs ? '$stubs:/usr/bin:/bin' : '$stubs:\$PATH';
  final a = args.map((x) => "'${_posix(x)}'").join(' ');
  return Process.run(_bash, ['-c', 'PATH="$path"; bash \'$script\' $a']);
}

File _apk(String name, String content) => File('${_tmp.path}/$name')..writeAsStringSync(content);

void main() {
  setUp(() {
    _tmp = Directory.systemTemp.createTempSync('scan_apk_test');
    _stubs = Directory('${_tmp.path}/stubs')..createSync();
  });
  tearDown(() => _tmp.deleteSync(recursive: true));

  test('script exists', () => expect(File('tool/ci/scan_apk.sh').existsSync(), isTrue));

  test('clean APK passes (exit 0)', () async {
    _allStubs();
    final r = await _run([_apk('ok.apk', 'https://api.example.test only endpoints').path]);
    expect(r.exitCode, 0, reason: '${r.stdout}${r.stderr}');
  });

  // A real APK is megabytes: `strings | grep -m1` makes strings die of SIGPIPE, which under `set -o pipefail` turns the match into a
  // non-zero pipeline status, so the `if` reads "no secret found". Padding after the secret makes that deterministic.
  final pad = '\n${List.filled(200000, 'filler line of ordinary text').join('\n')}\n';

  test('private key string inside a native library fails (exit 1), also in a large binary', () async {
    _allStubs();
    final r = await _run([_apk('pk.apk', 'x\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n$pad').path]);
    expect(r.exitCode, 1, reason: '${r.stdout}${r.stderr}');
  });

  test('AWS access key id fails (exit 1), also in a large binary', () async {
    _allStubs();
    final r = await _run([_apk('aws.apk', 'cfg AKIAABCDEFGHIJKLMNOP end$pad').path]);
    expect(r.exitCode, 1, reason: '${r.stdout}${r.stderr}');
  });

  test('gitleaks finding fails (exit 1) even when strings are clean', () async {
    _allStubs(gitleaks: 'echo leak >&2; exit 1');
    final r = await _run([_apk('gl.apk', 'clean').path]);
    expect(r.exitCode, 1, reason: '${r.stdout}${r.stderr}');
  });

  test('apktool failure fails closed (exit 1), never a pass', () async {
    _allStubs(apktool: 'exit 1');
    final r = await _run([_apk('at.apk', 'clean').path]);
    expect(r.exitCode, 1, reason: '${r.stdout}${r.stderr}');
  });

  test('not a zip fails (exit 1)', () async {
    _allStubs();
    final r = await _run([_apk('bad.apk', 'NOT-A-ZIP').path]);
    expect(r.exitCode, 1, reason: '${r.stdout}${r.stderr}');
  });

  test('missing argument => 2, missing file => 2', () async {
    _allStubs();
    expect((await _run([])).exitCode, 2);
    expect((await _run(['${_tmp.path}/nope.apk'])).exitCode, 2);
  });

  test('a missing required tool fails closed (exit 3)', () async {
    // unzip is not stubbed-out-able (Git bash ships it in /usr/bin), so it is not in this list.
    for (final missing in ['apktool', 'gitleaks', 'strings']) {
      _allStubs();
      File('${_stubs.path}/$missing').deleteSync();
      final r = await _run([_apk('t.apk', 'clean').path]);
      expect(r.exitCode, 3, reason: 'missing $missing: ${r.stdout}${r.stderr}');
    }
  });

  test('the shipped script scans for private keys and runs gitleaks over the unpacked APK (REQ-SEC-107, 07-SECURITY §5.11)', () {
    final s = File('tool/ci/scan_apk.sh').readAsStringSync();
    expect(s, contains('apktool'));
    expect(s, contains('strings'));
    expect(s, contains('gitleaks'));
    expect(s, contains('set -euo pipefail'));
  });
}
