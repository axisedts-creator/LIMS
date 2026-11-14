// A13 Report viewer (04-UI-UX A13; 03-APP-FLOW §11 A13; US-EN-08.3, 08.6; REQ-SEC-103). Downloads E23 once on open, writes the bytes to ONE file inside secureTempFilesProvider.dir and hands its path to the viewer.
// The file dies on viewer close, system back / dispose; a logout wipe (SessionController) is covered by the same dir. Bytes that arrive after the screen is gone are dropped before anything is written.
// Save / Share only through the confirmation dialog (US-EN-08.6). LD-140: lims_ui components and token names only. REQ-SEC-109: LimsSecureScreen. Server detail never reaches the screen.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/providers.dart';
import '../../core/lifecycle/secure_temp_files.dart';
import 'reports_api.dart';
import 'reports_providers.dart';

const _saveWarning = "This saves the report outside the app. Anyone with access to your phone's files may see it.";

class ReportViewerScreen extends ConsumerStatefulWidget {
  const ReportViewerScreen({super.key, required this.reportId, required this.versionNo});

  final String reportId;
  final int versionNo;

  @override
  ConsumerState<ReportViewerScreen> createState() => _ReportViewerScreenState();
}

class _ReportViewerScreenState extends ConsumerState<ReportViewerScreen> {
  late final PatientReportsApi _api = ref.read(patientReportsApiProvider);
  late final SecureTempFiles _temp = ref.read(secureTempFilesProvider);
  late final ReportSharer _sharer = ref.read(reportSharerProvider);
  late final Widget Function(String, VoidCallback) _viewer = ref.read(reportViewerBuilderProvider);
  File? _file;
  String? _error; // LimsException code of the last failure
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _download();
  }

  @override
  void dispose() {
    _deleteFile(); // system back, close, route replaced
    super.dispose();
  }

  void _deleteFile() {
    final f = _file;
    _file = null;
    try {
      f?.deleteSync();
    } on FileSystemException {
      // already gone (logout wipe): nothing to remove
    }
  }

  Future<void> _download() async {
    if (_busy) return;
    _busy = true;
    if (_error != null) setState(() => _error = null);
    try {
      final Uint8List bytes = await _api.downloadReport(reportId: widget.reportId, versionNo: widget.versionNo);
      if (!mounted) return; // left before the bytes arrived: nothing is written
      // ponytail: sync write (one small PDF, no await between "still mounted?" and the file existing); isolate if PDFs get big.
      _temp.dir.createSync(recursive: true);
      final f = File('${_temp.dir.path}${Platform.pathSeparator}${uuidv7()}.pdf'); // the name carries no report id (visible on the device)
      f.writeAsBytesSync(bytes);
      setState(() => _file = f);
    } on Object catch (e) {
      if (mounted) setState(() => _error = e is LimsException ? e.code : LimsErrorCodes.commonInternal);
    } finally {
      _busy = false;
    }
  }

  void _close() {
    _deleteFile();
    if (mounted) Navigator.of(context).maybePop();
  }

  Future<void> _share() async {
    final path = _file?.path;
    if (path == null) return;
    final ok = await LimsConfirmDialog.show(context, title: 'Keep a copy outside the app?', message: _saveWarning, confirmLabel: 'Save');
    if (ok == null || !mounted || _file?.path != path) return; // Cancel / dismiss is not a confirmation
    try {
      await _sharer.share(path);
    } on Object {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('The report could not be saved.')));
    }
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        // The file dies the moment the screen starts to leave (back / close), not when the exit animation ends.
        child: PopScope(
          onPopInvokedWithResult: (didPop, _) => didPop ? _deleteFile() : null,
          child: Scaffold(
            appBar: AppBar(
              title: const Text('Report'),
              actions: [if (_file != null) IconButton(icon: const Icon(Icons.ios_share), tooltip: 'Share or save report', onPressed: _share)],
            ),
            body: _body(),
          ),
        ),
      );

  Widget _body() {
    final f = _file;
    if (f != null) return _viewer(f.path, _close);
    final e = _error;
    if (e == null) {
      return const Center(child: Column(mainAxisSize: MainAxisSize.min, children: [CircularProgressIndicator(), SizedBox(height: LimsTokens.space3), Text('Downloading report…')]));
    }
    return switch (e) {
      LimsErrorCodes.commonDependencyUnavailable => LimsErrorState(title: "The report can't be downloaded right now", message: 'Please check your connection.', onRetry: _download),
      LimsErrorCodes.commonRateLimited => LimsErrorState(title: 'Too many downloads', message: 'You have reached the hourly download limit. Please wait before downloading again.', onRetry: _download),
      LimsErrorCodes.commonNotFound => const LimsErrorState(title: 'Report not found', message: 'This report is no longer available.'),
      _ => LimsErrorState(title: 'Download failed', message: 'The report could not be downloaded.', onRetry: _download),
    };
  }
}
