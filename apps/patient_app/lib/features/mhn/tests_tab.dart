// All Tests tab: connected to LIMS E30 listMyBookableItems API (with preview fallback).
// Supports search (synchronous local match + server query), booking_kind (home_collection / centre_visit),
// pagination (cursor), loading, empty, unauthorized, feature-disabled, offline/error and retry states.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../bookings/bookings_providers.dart';
import '../orders/orders_format.dart';
import 'category_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_test_card.dart';
import 'mhn_theme.dart';

enum _CatalogViewStatus {
  ready,
  unauthorized,
  disabled,
  error,
}

class MhnTestsTab extends ConsumerStatefulWidget {
  const MhnTestsTab({super.key});

  @override
  ConsumerState<MhnTestsTab> createState() => _MhnTestsTabState();
}

class _MhnTestsTabState extends ConsumerState<MhnTestsTab> {
  final _q = TextEditingController();
  Timer? _debounce;

  String _bookingKind = 'home_collection';
  _CatalogViewStatus _status = _CatalogViewStatus.ready;
  String _errorMessage = '';

  List<MhnTest> _items = kTests;
  List<MhnTest> _serverItems = [];
  bool _usingServerData = false;
  bool _isDemoMode = false;
  String? _nextCursor;
  bool _loading = false;
  bool _loadingMore = false;
  int _fetchToken = 0;

  @override
  void initState() {
    super.initState();
    _loadFromApi();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _loadFromApi({bool more = false}) async {
    final token = ++_fetchToken;
    final queryText = _q.text.trim();

    setState(() {
      if (more) {
        _loadingMore = true;
      } else {
        _loading = true;
        _nextCursor = null;
      }
    });

    try {
      final api = ref.read(patientBookingsApiProvider);
      final raw = await api.listBookableItems(
        bookingKind: _bookingKind,
        query: queryText.isEmpty ? null : (queryText.length > 40 ? queryText.substring(0, 40) : queryText),
        cursor: more ? _nextCursor : null,
      );

      if (!mounted || token != _fetchToken) return;

      final body = asMap(raw);
      final dataList = mapList(body?['data']);
      final pageMap = asMap(body?['page']);
      final next = pageMap?['next_cursor'];

      final loaded = [
        for (final m in dataList) MhnTest.fromBookable(m),
      ];

      setState(() {
        _usingServerData = true;
        _isDemoMode = false;
        _serverItems = more ? [..._serverItems, ...loaded] : loaded;
        _items = _serverItems;
        _nextCursor = next is String ? next : null;
        _loading = false;
        _loadingMore = false;
        _status = _CatalogViewStatus.ready;
      });
    } on LimsException catch (e) {
      if (!mounted || token != _fetchToken) return;
      setState(() {
        _loading = false;
        _loadingMore = false;
        if (e.code == LimsErrorCodes.authUnauthenticated) {
          _status = _CatalogViewStatus.unauthorized;
          _errorMessage = 'Please sign in to view available tests.';
        } else if (e.code == LimsErrorCodes.commonFeatureDisabled) {
          _status = _CatalogViewStatus.disabled;
          _errorMessage = 'Test bookings are currently unavailable in your region.';
        } else {
          _status = _CatalogViewStatus.error;
          _errorMessage = 'Unable to load tests from server. Please try again.';
        }
      });
    } on UnimplementedError {
      // Offline preview harness / ungenerated transport fallback
      if (!mounted || token != _fetchToken) return;
      if (!kReleaseMode) {
        setState(() {
          _usingServerData = false;
          _isDemoMode = true;
          _items = kTests;
          _loading = false;
          _loadingMore = false;
          _status = _CatalogViewStatus.ready;
        });
      } else {
        setState(() {
          _loading = false;
          _loadingMore = false;
          _status = _CatalogViewStatus.error;
          _errorMessage = 'Catalog service is currently unavailable.';
        });
      }
    } catch (_) {
      if (!mounted || token != _fetchToken) return;
      setState(() {
        _loading = false;
        _loadingMore = false;
        _status = _CatalogViewStatus.error;
        _errorMessage = 'Network error. Please check your connection and retry.';
      });
    }
  }

  void _onSearchChanged(String val) {
    setState(() {}); // Synchronous local update for immediate UI response
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) {
        _loadFromApi();
      }
    });
  }

  void _setBookingKind(String kind) {
    if (_bookingKind == kind) return;
    setState(() {
      _bookingKind = kind;
    });
    _loadFromApi();
  }

  List<MhnTest> _filteredResults() {
    final q = _q.text.trim().toLowerCase();
    if (q.isEmpty) return const [];
    return [
      for (final t in _items)
        if ('${t.name} ${t.desc} ${kCategories.where((c) => c.id == t.cat).firstOrNull?.name ?? ''}'.toLowerCase().contains(q))
          t,
    ];
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.text.trim();
    final results = _filteredResults();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
      children: [
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          runSpacing: 8,
          children: [
            Text('All tests', style: Mhn.h1),
            Container(
              decoration: BoxDecoration(
                color: Mhn.tint,
                borderRadius: BorderRadius.circular(20),
              ),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _kindPill('Home collection', 'home_collection'),
                    _kindPill('Centre visit', 'centre_visit'),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        Semantics(
          label: 'Search tests',
          child: Container(
            height: 54,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
              color: Mhn.white,
              borderRadius: BorderRadius.circular(Mhn.rField),
              border: Border.all(color: Mhn.line),
              boxShadow: const [BoxShadow(color: Mhn.shadow, blurRadius: 18, offset: Offset(0, 6))],
            ),
            child: Row(
              children: [
                const Icon(Icons.search, size: 22, color: Mhn.green),
                const SizedBox(width: 12),
                Expanded(
                  child: LimsTextField(
                    label: 'Search for ‘Thyroid profile’',
                    maxLength: 100,
                    controller: _q,
                    onChanged: _onSearchChanged,
                    textInputAction: TextInputAction.search,
                    style: Mhn.t(15, w: FontWeight.w600),
                    decoration: InputDecoration(
                      border: InputBorder.none,
                      counterText: '',
                      hintText: 'Search for ‘Thyroid profile’',
                      hintStyle: Mhn.t(15, c: Mhn.muted),
                      isCollapsed: true,
                    ),
                  ),
                ),
                if (_loading)
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Mhn.green),
                  )
                else if (q.isNotEmpty)
                  IconButton(
                    tooltip: 'Clear search',
                    onPressed: () {
                      _q.clear();
                      setState(() {});
                      _loadFromApi();
                    },
                    icon: const Icon(Icons.close, size: 18, color: Mhn.muted),
                  ),
              ],
            ),
          ),
        ),
        if (_isDemoMode)
          Container(
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Mhn.warnBg,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Mhn.warnFg.withValues(alpha: 0.3)),
            ),
            child: Row(
              children: [
                const Icon(Icons.info_outline, size: 16, color: Mhn.warnFg),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Demo mode: Showing local sample tests. Prices are indicative only.',
                    style: Mhn.t(11, w: FontWeight.w600, c: Mhn.warnFg),
                  ),
                ),
              ],
            ),
          ),
        const SizedBox(height: 6),
        Text('Catalog prices are indicative estimates. Final quote is confirmed during booking review.', style: Mhn.t(11, c: Mhn.mutedSoft)),
        const SizedBox(height: 14),
        _buildBody(q, results),
      ],
    );
  }

  Widget _kindPill(String label, String kind) {
    final active = _bookingKind == kind;
    return GestureDetector(
      onTap: () => _setBookingKind(kind),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: active ? Mhn.green : Colors.transparent,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Text(
          label,
          style: Mhn.t(11, w: FontWeight.w700, c: active ? Mhn.white : Mhn.green),
        ),
      ),
    );
  }

  Widget _buildBody(String q, List<MhnTest> results) {
    switch (_status) {
      case _CatalogViewStatus.unauthorized:
        return MhnCard(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Icon(Icons.lock_outline, size: 40, color: Mhn.muted),
              const SizedBox(height: 12),
              Text('Sign in required', style: Mhn.t(16, w: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(_errorMessage, textAlign: TextAlign.center, style: Mhn.body),
            ],
          ),
        );

      case _CatalogViewStatus.disabled:
        return MhnCard(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Icon(Icons.info_outline, size: 40, color: Mhn.mutedSoft),
              const SizedBox(height: 12),
              Text('Service Unavailable', style: Mhn.t(16, w: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(_errorMessage, textAlign: TextAlign.center, style: Mhn.body),
            ],
          ),
        );

      case _CatalogViewStatus.error:
        return MhnCard(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Icon(Icons.cloud_off_outlined, size: 40, color: Mhn.dangerFg),
              const SizedBox(height: 12),
              Text('Unable to load tests', style: Mhn.t(16, w: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(_errorMessage, textAlign: TextAlign.center, style: Mhn.body),
              const SizedBox(height: 16),
              MhnButton(label: 'Retry', onPressed: () => _loadFromApi()),
            ],
          ),
        );

      case _CatalogViewStatus.ready:
        if (q.isEmpty) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Browse by category', style: Mhn.h2),
              const SizedBox(height: 12),
              LayoutBuilder(builder: (context, c) {
                final w = (c.maxWidth - 12) / 2;
                return Wrap(spacing: 12, runSpacing: 12, children: [
                  for (final cat in kCategories)
                    Container(
                      width: w,
                      constraints: const BoxConstraints(minHeight: 142),
                      child: Material(
                        color: Mhn.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Mhn.rCard), side: const BorderSide(color: Mhn.line)),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(Mhn.rCard),
                          onTap: () => mhnPush<void>(context, MhnCategoryScreen(category: cat)),
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                MhnIconTile(cat.icon),
                                const SizedBox(height: 8),
                                Text(cat.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: Mhn.t(14, w: FontWeight.w700, h: 1.2)),
                                const SizedBox(height: 2),
                                Text(() {
                                  final n = kTests.where((t) => t.cat == cat.id).length;
                                  return '$n ${n == 1 ? 'test' : 'tests'}';
                                }(), style: Mhn.t(12, c: Mhn.muted)),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                ]);
              }),
              if (_usingServerData && _serverItems.isNotEmpty) ...[
                const SizedBox(height: 24),
                Text('Available tests', style: Mhn.h2),
                const SizedBox(height: 12),
                for (final t in _serverItems)
                  Padding(padding: const EdgeInsets.only(bottom: 12), child: MhnTestCard(test: t, showCategory: true)),
                if (_nextCursor != null) ...[
                  const SizedBox(height: 8),
                  if (_loadingMore)
                    const Center(child: Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator(color: Mhn.green)))
                  else
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton(
                        onPressed: () => _loadFromApi(more: true),
                        style: OutlinedButton.styleFrom(
                          side: const BorderSide(color: Mhn.green),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                        child: Text('Load more tests', style: Mhn.t(14, w: FontWeight.w700, c: Mhn.green)),
                      ),
                    ),
                ],
              ],
            ],
          );
        } else {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${results.length} ${results.length == 1 ? 'test' : 'tests'} found', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.muted)),
              const SizedBox(height: 10),
              if (results.isEmpty)
                MhnCard(
                  child: Column(children: [
                    const Icon(Icons.search_off, size: 32, color: Mhn.mutedSoft),
                    const SizedBox(height: 8),
                    Text('No tests found', style: Mhn.t(15, w: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Text('Check the spelling, or browse the categories below.', textAlign: TextAlign.center, style: Mhn.body),
                  ]),
                ),
              for (final t in results) Padding(padding: const EdgeInsets.only(bottom: 12), child: MhnTestCard(test: t, showCategory: true)),
            ],
          );
        }
    }
  }
}
