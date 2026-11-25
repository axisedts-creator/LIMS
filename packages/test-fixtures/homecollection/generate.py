# Writes mutation-payload-cases.json: shared shape cases for the C17 mutation payload check.
# Run from the repo root: python packages/test-fixtures/homecollection/generate.py
import json
import os

U = '0195f3a0-0000-4000-8000-000000000001'
U7 = '0195f3a0-0000-7000-8000-000000000001'
OFF = {'status': 'off'}
OK = {
    'visit.arrived': {'gps': {'status': 'ok', 'latitude': '27.700000', 'longitude': '85.300000', 'accuracy_m': 12}},
    'visit.identity_checked': {'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'mismatch'},
    'visit.consent_recorded': {'consent_text_version': 'v1', 'given': True},
    'specimen.collected': {'specimen_id': U, 'scanned_barcode': 'E2600000042', 'scan_method': 'camera', 'specimen_type_code': 'EDTA_WB', 'gps': OFF},
    'specimen.not_collected': {'specimen_id': U, 'reason_code': 'patient_refused', 'reason_text': 'synthetic note'},
    'payment.captured': {'order_id': U, 'payment_method_code': 'cash', 'amount': {'amount_paisa': 150000, 'currency': 'NPR'}, 'reference': 'REF-1'},
    'visit.completed': {'outcome': 'partial'},
    'visit.failed': {'reason_code': 'other', 'gps': OFF, 'reason_text': 'synthetic note'},
    'handover.recorded': {'handover_id': U7, 'to_centre_id': U, 'specimen_ids': [U]},
}
OPTIONAL = {'reason_text', 'reference'}
cases = []


def add(name, type_, payload, valid):
    cases.append({'name': name, 'type': type_, 'payload': payload, 'valid': valid})


for t, p in OK.items():
    add(f'{t}: valid', t, p, True)
    add(f'{t}: extra key', t, {**p, 'extra': 1}, False)
    for k in p:
        add(f'{t}: without {k}', t, {x: y for x, y in p.items() if x != k}, k in OPTIONAL)

add('unknown type', 'visit.deleted', {}, False)
for name, p in [('string', 'collected'), ('array', []), ('number', 1)]:
    add(f'payload is a {name}', 'visit.completed', p, False)

c = OK['specimen.collected']
BAD_BARCODES = ['', 'e2600000042', 'E26 00000042', 'E2600000042\n', 'A' * 21, "E26';DROP TABLE x;--", 'https://example.invalid/x', 'ई२६', 42]
for b in BAD_BARCODES:
    add(f'barcode {json.dumps(b)}', 'specimen.collected', {**c, 'scanned_barcode': b}, False)
add('barcode 20 chars', 'specimen.collected', {**c, 'scanned_barcode': 'A' * 20}, True)
for m in ['hid', 'manual']:
    add(f'scan_method {m}', 'specimen.collected', {**c, 'scan_method': m}, True)
add('scan_method nfc', 'specimen.collected', {**c, 'scan_method': 'nfc'}, False)
add('specimen_id upper case', 'specimen.collected', {**c, 'specimen_id': U.upper()}, False)
add('specimen_type_code leading dash', 'specimen.collected', {**c, 'specimen_type_code': '-EDTA'}, False)
add('specimen_type_code 101 chars', 'specimen.collected', {**c, 'specimen_type_code': 'A' * 101}, False)


def gps(name, g, valid):
    add(f'gps {name}', 'visit.arrived', {'gps': g}, valid)


POS = {'status': 'ok', 'latitude': '27.7', 'longitude': '85.3'}
gps('denied', {'status': 'denied'}, True)
gps('unavailable', {'status': 'unavailable'}, True)
gps('off with latitude', {'status': 'off', 'latitude': '27.7'}, False)
gps('off with accuracy', {'status': 'off', 'accuracy_m': 1}, False)
gps('unknown status', {'status': 'moon'}, False)
gps('extra key', {'status': 'off', 'extra': 1}, False)
gps('numeric latitude', {**POS, 'latitude': 27.7}, False)
gps('exponent latitude', {**POS, 'latitude': '1e1'}, False)
gps('accuracy 10000', {**POS, 'accuracy_m': 10000}, True)
gps('accuracy 10001', {**POS, 'accuracy_m': 10001}, False)
gps('accuracy negative', {**POS, 'accuracy_m': -1}, False)
gps('accuracy fractional', {**POS, 'accuracy_m': 1.5}, False)

p = OK['payment.captured']


def pay(name, amount, valid, **over):
    add(f'payment {name}', 'payment.captured', {**p, 'amount': amount, **over}, valid)


NPR = {'amount_paisa': 100, 'currency': 'NPR'}
pay('1 paisa', {**NPR, 'amount_paisa': 1}, True)
pay('max', {**NPR, 'amount_paisa': 50000000}, True)
pay('zero', {**NPR, 'amount_paisa': 0}, False)
pay('negative', {**NPR, 'amount_paisa': -5}, False)
pay('over max', {**NPR, 'amount_paisa': 50000001}, False)
pay('fractional', {**NPR, 'amount_paisa': 1.5}, False)
pay('string amount', {**NPR, 'amount_paisa': '100'}, False)
pay('USD', {**NPR, 'currency': 'USD'}, False)
pay('amount extra key', {**NPR, 'x': 1}, False)
pay('reference 100', NPR, True, reference='R' * 100)
pay('reference 101', NPR, False, reference='R' * 101)
pay('reference empty', NPR, False, reference='')

add('reason_text 200', 'visit.failed', {'reason_code': 'other', 'gps': OFF, 'reason_text': 'x' * 200}, True)
add('reason_text 201', 'visit.failed', {'reason_code': 'other', 'gps': OFF, 'reason_text': 'x' * 201}, False)
add('reason_code with space', 'visit.failed', {'reason_code': 'Other Reason', 'gps': OFF}, False)
add('consent given as string', 'visit.consent_recorded', {'consent_text_version': 'v1', 'given': 'true'}, False)
add('consent version 41 chars', 'visit.consent_recorded', {'consent_text_version': 'v' * 41, 'given': True}, False)
add('outcome collected', 'visit.completed', {'outcome': 'collected'}, True)
add('outcome none', 'visit.completed', {'outcome': 'none'}, False)

h = OK['handover.recorded']
add('handover no specimens', 'handover.recorded', {**h, 'specimen_ids': []}, False)
add('handover 50 specimens', 'handover.recorded', {**h, 'specimen_ids': [U] * 50}, True)
add('handover 51 specimens', 'handover.recorded', {**h, 'specimen_ids': [U] * 51}, False)
add('handover bad specimen id', 'handover.recorded', {**h, 'specimen_ids': [U, 'nope']}, False)
add('handover id not v7', 'handover.recorded', {**h, 'handover_id': U}, False)
add('handover specimen_ids not a list', 'handover.recorded', {**h, 'specimen_ids': U}, False)

doc = {
    '_comment': 'Shared cases for the C17 mutation payload shape check. Run by BOTH the server validator '
                '(services/api homecollection domain/mutation.ts) and the phlebo app mirror (mutation_payload.dart) '
                'so the two cannot drift. Shape only: the GPS coordinate range is checked elsewhere on the server '
                '(sync.service.ts parseGps). Synthetic data only. Generated by generate.py.',
    'cases': cases,
}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mutation-payload-cases.json')
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    f.write(json.dumps(doc, indent=1, ensure_ascii=True) + '\n')
print(len(cases), 'cases,', sum(x['valid'] for x in cases), 'valid')
