// HC-T21 test support (not a test): throw-away PKI generated with `openssl` at test time, so no private key is ever
// committed (.gitleaks.toml has no allowlist, CV §12 gate 11). All names and keys are synthetic and live in a temp dir.
//
//   caA  = the "pinned" issuing CA (what C1 ships per environment, CR-C17-011)
//   caB  = a MITM proxy's CA. SAME subject DN as caA but a different key: pinning must be by certificate/key,
//          never by name.
//   serverA / serverB = loopback servers (SAN IP:127.0.0.1) whose leaf is signed by caA / caB.
//
// openssl lookup: $OPENSSL_BIN, then `openssl` on PATH, then Git for Windows' usr\bin (CI image and dev machines).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

typedef TestHandler = FutureOr<void> Function(HttpRequest request, List<int> body);

class TestPki {
  TestPki._(this.dir, this.caAPem, this.caBPem, this._leafA, this._leafB);

  final Directory dir;
  final String caAPem;
  final String caBPem;
  final _Leaf _leafA;
  final _Leaf _leafB;

  static const _gitOpenssl = r'C:\Program Files\Git\usr\bin\openssl.exe';

  static String _bin() {
    final env = Platform.environment['OPENSSL_BIN'];
    if (env != null && env.isNotEmpty) return env;
    final probe = Process.runSync('openssl', ['version'], runInShell: false);
    return probe.exitCode == 0 ? 'openssl' : _gitOpenssl;
  }

  static String _run(String bin, List<String> args, Directory cwd) {
    final r = Process.runSync(bin, args, workingDirectory: cwd.path);
    if (r.exitCode != 0) throw StateError('openssl ${args.take(2).join(' ')} failed: ${r.stderr}');
    return r.stdout as String;
  }

  static Future<TestPki> create() async {
    String bin;
    try {
      bin = _bin();
    } on ProcessException {
      bin = _gitOpenssl;
    }
    final dir = Directory.systemTemp.createTempSync('hc_t21_pki_');
    File('${dir.path}/ca.cnf').writeAsStringSync('''
[req]
distinguished_name=dn
x509_extensions=v3_ca
prompt=no
[dn]
O=LIMS Test
CN=LIMS Test Issuing CA
[v3_ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
''');
    File('${dir.path}/srv.cnf').writeAsStringSync('''
[req]
distinguished_name=dn
prompt=no
[dn]
CN=localhost
''');
    File('${dir.path}/ext.cnf').writeAsStringSync('''
[v3_leaf]
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
''');

    Future<(String, _Leaf)> issuer(String name) async {
      _run(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '$name-ca.key', '-out', '$name-ca.pem', '-days', '2', '-config', 'ca.cnf'], dir);
      _run(bin, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', '$name-srv.key', '-out', '$name-srv.csr', '-config', 'srv.cnf'], dir);
      _run(bin, ['x509', '-req', '-in', '$name-srv.csr', '-CA', '$name-ca.pem', '-CAkey', '$name-ca.key', '-CAcreateserial', '-out', '$name-srv.pem', '-days', '2', '-extfile', 'ext.cnf', '-extensions', 'v3_leaf'], dir);
      return (File('${dir.path}/$name-ca.pem').readAsStringSync(), _Leaf('${dir.path}/$name-srv.pem', '${dir.path}/$name-srv.key'));
    }

    final a = await issuer('a');
    final b = await issuer('b');
    return TestPki._(dir, a.$1, b.$1, a.$2, b.$2);
  }

  /// HTTPS server on 127.0.0.1:<ephemeral> whose leaf chains to caA (trusted/pinned) or caB (the MITM).
  Future<TestServer> serve({required bool signedByPinnedCa, required TestHandler handler}) =>
      TestServer._start(signedByPinnedCa ? _leafA : _leafB, handler);

  void dispose() => dir.deleteSync(recursive: true);
}

class _Leaf {
  const _Leaf(this.certPath, this.keyPath);
  final String certPath;
  final String keyPath;
}

class RecordedRequest {
  RecordedRequest(this.method, this.uri, this.headers, this.body);
  final String method;
  final Uri uri;
  final HttpHeaders headers;
  final String body;
  String? header(String name) => headers.value(name);
}

class TestServer {
  TestServer._(this._server, this.requests);

  final HttpServer _server;
  final List<RecordedRequest> requests;

  Uri get baseUrl => Uri.parse('https://127.0.0.1:${_server.port}');

  static Future<TestServer> _start(_Leaf leaf, TestHandler handler) async {
    final ctx = SecurityContext(withTrustedRoots: false)
      ..useCertificateChain(leaf.certPath)
      ..usePrivateKey(leaf.keyPath);
    final server = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
    final seen = <RecordedRequest>[];
    server.listen((req) async {
      final body = await req.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
      seen.add(RecordedRequest(req.method, req.uri, req.headers, utf8.decode(body)));
      try {
        await handler(req, body);
      } finally {
        await req.response.close();
      }
    }, onError: (_) {
      // a refused handshake surfaces here on the server side; the test asserts on the client side.
    });
    return TestServer._(server, seen);
  }

  Future<void> close() => _server.close(force: true);
}

/// Writes a JSON (or problem+json) response.
void respond(HttpRequest req, int status, Object? json, {String contentType = 'application/json', Map<String, String> headers = const {}}) {
  req.response
    ..statusCode = status
    ..headers.set('content-type', contentType);
  headers.forEach(req.response.headers.set);
  if (json != null) req.response.write(json is String ? json : jsonEncode(json));
}
