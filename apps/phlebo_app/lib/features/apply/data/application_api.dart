// PHLEBO-UI-FULL-1: sends an application to the lab. Not signed in: the lab is named by the build's tenant code
// (X-Lims-Applicant-PreAuth: t.<code>). Documents go up in pieces of at most 512 KB through the normal JSON channel.
// Nothing is stored on the phone and nothing is logged.
import 'dart:convert';
import 'dart:math';

import 'package:lims_shared/lims_shared.dart';

import '../../../core/net/api_factory.dart';
import '../domain/application.dart';

const _pieceBytes = 512 * 1024;
const _base = '/v1/homecollection/applications';

const applicationSendFailed = "Couldn't send. Check your connection and try again.";

/// Null on success, else the sentence to show.
Future<String?> sendApplication(ApiClient api, String tenantCode, ApplicationDraft draft, {String Function()? newId}) async {
  final id = newId ?? uuidv7;
  final lab = {'X-Lims-Applicant-PreAuth': 't.$tenantCode'};
  try {
    final created = await api.postJson(_base, draft.toJson(), headers: lab);
    final applicationId = created['application_id'], token = created['upload_token'];
    if (applicationId is! String || token is! String) return applicationSendFailed;
    final auth = {...lab, 'X-Lims-Application-Token': token};
    for (final kind in DocKind.values) {
      for (final file in draft.documents[kind]!) {
        final documentId = id();
        final pieces = max(1, (file.bytes.length / _pieceBytes).ceil());
        for (var i = 0; i < pieces; i++) {
          final part = file.bytes.sublist(i * _pieceBytes, min(file.bytes.length, (i + 1) * _pieceBytes));
          await api.postJson('$_base/$applicationId/documents/$documentId/chunks', {
            'kind': docCodes[kind],
            'file_name': file.name.length > 120 ? file.name.substring(file.name.length - 120) : file.name,
            'content_type': file.contentType,
            'index': i,
            'last': i == pieces - 1,
            'data': base64.encode(part),
          }, headers: auth);
        }
      }
    }
    await api.postJson('$_base/$applicationId/submit', const {}, headers: auth);
    return null;
  } on ApiTransportException {
    return applicationSendFailed;
  } on LimsException catch (e) {
    return switch (e.code) {
      'common.immutable_record' => 'An application for this mobile number is already waiting for review.',
      LimsErrorCodes.commonRateLimited => 'Too many tries for this number. Wait an hour, then try again.',
      'common.payload_too_large' => 'A file is larger than 2 MB. Remove it and add a smaller one.',
      'common.unsupported_media_type' => 'A file is not a real JPG, PNG or PDF. Remove it and add another.',
      LimsErrorCodes.commonValidationFailed => 'Some details were not accepted. Check them and try again.',
      _ => applicationSendFailed,
    };
  } catch (_) {
    return applicationSendFailed;
  }
}
