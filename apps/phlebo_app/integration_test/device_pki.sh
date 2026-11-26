#!/usr/bin/env bash
# Prints LIMS_TEST_PKI_B64 for a device run of integration_test/ (see __tests__/support/tls_fixture.dart): two throw-away CAs with the SAME
# subject and one loopback leaf each, valid 2 days. EC P-256 keys: the value must fit a Windows command line. Synthetic; never written into the repo.
#   flutter test integration_test --flavor dev -d <device> --dart-define=LIMS_TEST_PKI_B64="$(bash integration_test/device_pki.sh)"
set -euo pipefail
export MSYS_NO_PATHCONV=1
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT; cd "$d"
printf '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nO=LIMS Test\nCN=LIMS Test Issuing CA\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > ca.cnf
printf '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n' > srv.cnf
printf '[v3_leaf]\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n' > ext.cnf
for n in a b; do
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout $n-ca.key -out $n-ca.pem -days 2 -config ca.cnf 2>/dev/null
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout $n-srv.key -out $n-srv.csr -config srv.cnf 2>/dev/null
  openssl x509 -req -in $n-srv.csr -CA $n-ca.pem -CAkey $n-ca.key -CAcreateserial -out $n-srv.pem -days 2 -extfile ext.cnf -extensions v3_leaf 2>/dev/null
done
python -c "import json,base64,sys;print(base64.b64encode(json.dumps({f:open(f).read() for f in sys.argv[1:]}).encode()).decode())" a-ca.pem b-ca.pem a-srv.pem a-srv.key b-srv.pem b-srv.key
