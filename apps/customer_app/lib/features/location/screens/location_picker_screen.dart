import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/config/maps_config.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../models/picked_location.dart';
import '../services/device_location.dart';
import '../services/places_service.dart';

/// Riyadh, used when there is no starting point: a reasonable default, not an assumption that the customer is there.
const LatLng kDefaultCenter = LatLng(24.7136, 46.6753);

/// What the picker needs from a map widget. The real one is a GoogleMap; tests supply a fake (a platform view cannot run in widget tests).
class PickerMapArgs {
  const PickerMapArgs({
    required this.initial,
    required this.onMoved,
    required this.onIdle,
    required this.onReady,
  });
  final LatLng initial;
  final ValueChanged<LatLng> onMoved;
  final VoidCallback onIdle;
  final ValueChanged<PickerMapHandle> onReady;
}

abstract class PickerMapHandle {
  Future<void> moveTo(LatLng target);
}

typedef PickerMapBuilder = Widget Function(PickerMapArgs args);

class _GoogleHandle implements PickerMapHandle {
  _GoogleHandle(this.controller);
  final GoogleMapController controller;

  @override
  Future<void> moveTo(LatLng target) =>
      controller.animateCamera(CameraUpdate.newLatLngZoom(target, 17));
}

Widget googleMapBuilder(PickerMapArgs a) => GoogleMap(
  initialCameraPosition: CameraPosition(target: a.initial, zoom: 15),
  onMapCreated: (c) => a.onReady(_GoogleHandle(c)),
  onCameraMove: (p) => a.onMoved(p.target),
  onCameraIdle: a.onIdle,
  zoomControlsEnabled: false,
  myLocationButtonEnabled: false,
  mapToolbarEnabled: false,
  compassEnabled: false,
  rotateGesturesEnabled: false,
  tiltGesturesEnabled: false,
);

enum _AddressState { loading, found, none, failed }

/// Choose a service address on a map: move the map under a fixed pin, search for an address or landmark, or use the current location (only if
/// the person allows it). Pops a [PickedLocation] when confirmed, or null when cancelled.
class LocationPickerScreen extends StatefulWidget {
  const LocationPickerScreen({
    super.key,
    this.initial,
    this._places,
    this._device,
    this.mapBuilder = googleMapBuilder,
  });

  final PickedLocation? initial;
  final PlacesService? _places;
  final DeviceLocation? _device;
  final PickerMapBuilder mapBuilder;

  @override
  State<LocationPickerScreen> createState() => _LocationPickerScreenState();
}

class _LocationPickerScreenState extends State<LocationPickerScreen> {
  late final PlacesService _places = widget._places ?? GooglePlacesService();
  late final DeviceLocation _device =
      widget._device ?? const GeolocatorDeviceLocation();

  late LatLng _center = widget.initial != null
      ? LatLng(widget.initial!.latitude, widget.initial!.longitude)
      : kDefaultCenter;
  PickerMapHandle? _map;

  // address
  final _address = TextEditingController();
  // The default centre is not a choice: nothing counts until the person moves the map, searches or uses their location (or edits a saved one).
  late _AddressState _addressState = widget.initial != null
      ? _AddressState.found
      : _AddressState.none;
  late bool _placed = widget.initial != null;
  PlacesFailure? _addressFailure;
  String? _district;
  String? _city;
  String? _placeId;
  int _geocodeId = 0;
  Timer? _geocodeTimer;
  bool _skipNextGeocode = false;
  bool _firstIdle = true;
  final Map<String, ResolvedAddress?> _geocodeCache = {};

  // search
  final _search = TextEditingController();
  Timer? _searchTimer;
  String _sessionToken = newSessionToken();
  List<PlaceSuggestion> _suggestions = const [];
  bool _searching = false;
  PlacesFailure? _searchFailure;
  int _searchId = 0;

  // current location
  LocationAccess? _access;
  bool _locating = false;

  // details
  String? _labelChoice; // 'locLabelHome' | 'locLabelWork' | 'locLabelOther'
  final _labelCustom = TextEditingController();
  final _building = TextEditingController();
  final _unit = TextEditingController();
  final _floor = TextEditingController();
  final _notes = TextEditingController();

  @override
  void initState() {
    super.initState();
    final i = widget.initial;
    if (i != null) {
      _address.text = i.address;
      _district = i.district;
      _city = i.city;
      _placeId = i.placeId;
      _building.text = i.building ?? '';
      _unit.text = i.unit ?? '';
      _floor.text = i.floor ?? '';
      _notes.text = i.notes ?? '';
      _labelCustom.text = i.label ?? '';
    }
  }

  @override
  void dispose() {
    _geocodeTimer?.cancel();
    _searchTimer?.cancel();
    for (final c in [
      _address,
      _search,
      _labelCustom,
      _building,
      _unit,
      _floor,
      _notes,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  String get _lang => context.isAr ? 'ar' : 'en';

  // ---------------------------------------------------------------- map

  void _onMoved(LatLng p) {
    _center = p;
    _placed = true;
  }

  void _onIdle() {
    if (_firstIdle && !_placed) {
      _firstIdle =
          false; // the map's initial idle: the starting point is not a choice and needs no lookup
      return;
    }
    _firstIdle = false;
    if (_skipNextGeocode) {
      _skipNextGeocode = false;
      return;
    }
    _scheduleGeocode();
  }

  void _scheduleGeocode() {
    _geocodeTimer?.cancel();
    setState(() {
      _addressState = _AddressState.loading;
      _addressFailure = null;
    });
    _geocodeTimer = Timer(const Duration(milliseconds: 450), _geocode);
  }

  Future<void> _geocode() async {
    final id = ++_geocodeId;
    final at = _center;
    final key =
        '${at.latitude.toStringAsFixed(4)},${at.longitude.toStringAsFixed(4)},$_lang';
    try {
      final ResolvedAddress? found;
      if (_geocodeCache.containsKey(key)) {
        found = _geocodeCache[key];
      } else {
        found = await _places.reverseGeocode(
          at.latitude,
          at.longitude,
          languageCode: _lang,
        );
        _geocodeCache[key] = found;
      }
      if (!mounted || id != _geocodeId) {
        return; // a newer pin position superseded this answer
      }
      setState(() {
        if (found == null) {
          _addressState = _AddressState.none;
          _district = _city = _placeId = null;
        } else {
          _addressState = _AddressState.found;
          _address.text = found.address;
          _district = found.district;
          _city = found.city;
          _placeId = found.placeId;
        }
      });
    } on PlacesException catch (e) {
      if (!mounted || id != _geocodeId) return;
      setState(() {
        _addressState = _AddressState.failed;
        _addressFailure = e.failure;
      });
    }
  }

  // ---------------------------------------------------------------- search

  void _onSearchChanged(String value) {
    _searchTimer?.cancel();
    final q = value.trim();
    if (q.length < 3) {
      setState(() {
        _suggestions = const [];
        _searching = false;
        _searchFailure = null;
      });
      return;
    }
    setState(() {
      _searching = true;
      _searchFailure = null;
    });
    _searchTimer = Timer(
      const Duration(milliseconds: 350),
      () => _runSearch(q),
    );
  }

  Future<void> _runSearch(String q) async {
    final id = ++_searchId;
    try {
      final result = await _places.autocomplete(
        q,
        sessionToken: _sessionToken,
        languageCode: _lang,
        biasLatitude: _center.latitude,
        biasLongitude: _center.longitude,
      );
      if (!mounted || id != _searchId) return;
      setState(() {
        _suggestions = result;
        _searching = false;
        _searchFailure = null;
      });
    } on PlacesException catch (e) {
      if (!mounted || id != _searchId) return;
      setState(() {
        _suggestions = const [];
        _searching = false;
        _searchFailure = e.failure;
      });
    }
  }

  Future<void> _choose(PlaceSuggestion s) async {
    FocusScope.of(context).unfocus();
    setState(() {
      _suggestions = const [];
      _searching = false;
      _addressState = _AddressState.loading;
      _addressFailure = null;
    });
    final token = _sessionToken;
    _sessionToken = newSessionToken(); // the session ends with the details call
    try {
      final d = await _places.details(
        s.placeId,
        sessionToken: token,
        languageCode: _lang,
      );
      if (!mounted) return;
      final at = LatLng(d.latitude!, d.longitude!);
      _geocodeId++; // drop any pending reverse lookup for the old position
      _geocodeTimer?.cancel();
      setState(() {
        _center = at;
        _search.text = s.primary;
        _address.text = d.address;
        _district = d.district;
        _city = d.city;
        _placeId = d.placeId;
        _addressState = _AddressState.found;
        _placed = true;
        _skipNextGeocode = true;
      });
      await _map?.moveTo(at);
    } on PlacesException catch (e) {
      if (!mounted) return;
      setState(() {
        _addressState = _AddressState.failed;
        _addressFailure = e.failure;
      });
    }
  }

  // ---------------------------------------------------------------- current location

  Future<void> _useCurrent() async {
    if (_locating) return;
    setState(() => _locating = true);
    final access = await _device.request();
    if (!mounted) return;
    if (access != LocationAccess.granted) {
      setState(() {
        _access = access;
        _locating = false;
      });
      return;
    }
    final fix = await _device.current();
    if (!mounted) return;
    if (fix == null) {
      setState(() {
        _access = LocationAccess.unavailable;
        _locating = false;
      });
      return;
    }
    final at = LatLng(fix.latitude, fix.longitude);
    setState(() {
      _access = LocationAccess.granted;
      _locating = false;
      _center = at;
      _placed = true;
    });
    await _map?.moveTo(
      at,
    ); // the camera-idle callback then looks up the address
    if (mounted && _map == null) _scheduleGeocode();
  }

  // ---------------------------------------------------------------- confirm

  bool get _canConfirm =>
      _placed &&
      _address.text.trim().length >= 3 &&
      _addressState != _AddressState.loading;

  void _confirm() {
    if (!_canConfirm ||
        !PickedLocation.validCoordinates(_center.latitude, _center.longitude)) {
      return;
    }
    String? clean(TextEditingController c) =>
        c.text.trim().isEmpty ? null : c.text.trim();
    final label = _labelCustom.text.trim().isNotEmpty
        ? _labelCustom.text.trim()
        : (_labelChoice == null ? null : context.tr(_labelChoice!));
    Navigator.of(context).pop(
      PickedLocation(
        latitude: _center.latitude,
        longitude: _center.longitude,
        address: _address.text.trim(),
        placeId: _placeId,
        district: _district,
        city: _city,
        building: clean(_building),
        unit: clean(_unit),
        floor: clean(_floor),
        label: label,
        notes: clean(_notes),
      ),
    );
  }

  // ---------------------------------------------------------------- build

  String _failureText(PlacesFailure f) => context.tr(switch (f) {
    PlacesFailure.notConfigured => 'locNotSetUp',
    PlacesFailure.quota => 'locErrQuota',
    PlacesFailure.denied => 'locErrDenied',
    PlacesFailure.invalid => 'locErrUnavailable',
    PlacesFailure.network => 'locErrNetwork',
    PlacesFailure.unavailable => 'locErrUnavailable',
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Expanded(flex: 5, child: _mapArea()),
            Expanded(flex: 6, child: _panel()),
          ],
        ),
      ),
    );
  }

  Widget _mapArea() {
    return Directionality(
      textDirection: TextDirection.ltr, // maps are not mirrored
      child: Stack(
        children: [
          Positioned.fill(
            child: widget.mapBuilder(
              PickerMapArgs(
                initial: _center,
                onMoved: _onMoved,
                onIdle: _onIdle,
                onReady: (h) => _map = h,
              ),
            ),
          ),
          // The pin stays at the centre; the map moves under it. Its tip is the chosen point.
          const IgnorePointer(
            child: Center(
              child: Padding(
                padding: EdgeInsets.only(bottom: 34),
                child: Icon(
                  Icons.location_on,
                  size: 44,
                  color: AppColors.primary,
                  key: Key('picker-pin'),
                ),
              ),
            ),
          ),
          PositionedDirectional(
            top: 8,
            start: 12,
            end: 12,
            child: Directionality(
              textDirection: Directionality.of(context),
              child: _searchBar(),
            ),
          ),
          PositionedDirectional(
            end: 12,
            bottom: 12,
            child: Tap(
              onTap: _locating ? null : _useCurrent,
              child: Container(
                key: const Key('picker-locate'),
                height: 46,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(23),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x26172B35),
                      blurRadius: 10,
                      offset: Offset(0, 3),
                    ),
                  ],
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _locating
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2.2),
                          )
                        : const AppIcon(
                            'locate',
                            size: 18,
                            color: AppColors.primary,
                          ),
                    const SizedBox(width: 8),
                    Text(
                      context.tr('locUseCurrent'),
                      style: ts(13.5, w: 600, c: AppColors.primary),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _searchBar() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            SquareIconButton.back(
              context,
              onTap: () => Navigator.of(context).maybePop(),
              shadow: true,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Container(
                height: 44,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: const [
                    BoxShadow(
                      color: Color(0x1F172B35),
                      blurRadius: 8,
                      offset: Offset(0, 2),
                    ),
                  ],
                ),
                child: Row(
                  children: [
                    const AppIcon('search', size: 18, color: AppColors.slate),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        key: const Key('picker-search'),
                        controller: _search,
                        onChanged: _onSearchChanged,
                        textInputAction: TextInputAction.search,
                        style: ts(14.5),
                        decoration: InputDecoration.collapsed(
                          hintText: context.tr('locSearchHint'),
                          hintStyle: ts(14.5, c: AppColors.muted),
                        ),
                      ),
                    ),
                    if (_search.text.isNotEmpty)
                      Tap(
                        onTap: () {
                          _search.clear();
                          _onSearchChanged('');
                        },
                        child: const AppIcon(
                          'x',
                          size: 16,
                          color: AppColors.slate,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
        if (_searching ||
            _suggestions.isNotEmpty ||
            _searchFailure != null ||
            (_search.text.trim().length >= 3 && !_searching))
          Container(
            margin: const EdgeInsets.only(top: 8),
            constraints: const BoxConstraints(maxHeight: 220),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(14),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x26172B35),
                  blurRadius: 12,
                  offset: Offset(0, 4),
                ),
              ],
            ),
            child: _searchResults(),
          ),
      ],
    );
  }

  Widget _searchResults() {
    if (_searchFailure != null) {
      return Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Expanded(
              child: Text(
                _failureText(_searchFailure!),
                key: const Key('picker-search-error'),
                style: ts(13, c: AppColors.danger),
              ),
            ),
            Tap(
              onTap: () {
                setState(() {
                  _searching = true;
                  _searchFailure = null;
                });
                _runSearch(_search.text.trim());
              },
              child: Text(
                context.tr('locRetry'),
                style: ts(13, w: 600, c: AppColors.primary),
              ),
            ),
          ],
        ),
      );
    }
    if (_searching) {
      return Padding(
        padding: const EdgeInsets.all(14),
        child: Text(
          context.tr('locSearching'),
          style: ts(13, c: AppColors.slate),
        ),
      );
    }
    if (_suggestions.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(14),
        child: Text(
          context.tr('locNoResults'),
          style: ts(13, c: AppColors.slate),
        ),
      );
    }
    return ListView(
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      children: [
        for (final s in _suggestions)
          Tap(
            onTap: () => _choose(s),
            child: Padding(
              key: Key('suggestion-${s.placeId}'),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              child: Row(
                children: [
                  const AppIcon('pin', size: 18, color: AppColors.slate),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          s.primary,
                          style: ts(14, w: 600),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        if (s.secondary != null)
                          Text(
                            s.secondary!,
                            style: ts(12, c: AppColors.slate),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _panel() {
    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        boxShadow: [
          BoxShadow(
            color: Color(0x1F172B35),
            blurRadius: 16,
            offset: Offset(0, -4),
          ),
        ],
      ),
      child: Column(
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
              children: [
                Text(context.tr('locTitle'), style: ts(19, w: 700)),
                const SizedBox(height: 4),
                Text(
                  context.tr('locMoveHint'),
                  style: ts(13, c: AppColors.slate),
                ),
                if (!mapsConfigured && widget._places == null) ...[
                  const SizedBox(height: 12),
                  _Notice(
                    text: context.tr('locNotSetUp'),
                    key: const Key('picker-not-configured'),
                  ),
                ],
                if (_access != null && _access != LocationAccess.granted) ...[
                  const SizedBox(height: 12),
                  _accessNotice(),
                ],
                const SizedBox(height: 14),
                _addressBlock(),
                const SizedBox(height: 16),
                _labelBlock(),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: _field(
                        _building,
                        'locBuilding',
                        const Key('picker-building'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _field(_unit, 'locUnit', const Key('picker-unit')),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _field(
                        _floor,
                        'locFloor',
                        const Key('picker-floor'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _field(
                  _notes,
                  'locNotes',
                  const Key('picker-notes'),
                  maxLines: 2,
                ),
                const SizedBox(height: 10),
                Text(
                  context.tr('locAreaNote'),
                  style: ts(12, c: AppColors.slate, h: 1.4),
                ),
              ],
            ),
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(
              20,
              8,
              20,
              12 + MediaQuery.paddingOf(context).bottom,
            ),
            child: AppButton(
              label: context.tr('locConfirm'),
              enabled: _canConfirm,
              onPressed: _confirm,
            ),
          ),
        ],
      ),
    );
  }

  Widget _accessNotice() {
    final key = switch (_access!) {
      LocationAccess.denied => 'locDenied',
      LocationAccess.deniedForever => 'locDeniedForever',
      LocationAccess.serviceOff => 'locServiceOff',
      _ => 'locUnavailable',
    };
    final action = switch (_access!) {
      LocationAccess.deniedForever => _device.openAppSettings,
      LocationAccess.serviceOff => _device.openLocationSettings,
      _ => null,
    };
    return _Notice(
      key: const Key('picker-access-notice'),
      text: context.tr(key),
      actionLabel: action == null ? null : context.tr('locOpenSettings'),
      onAction: action == null ? null : () => action(),
    );
  }

  Widget _addressBlock() {
    final error =
        _addressState == _AddressState.failed && _addressFailure != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('locAddress'), style: ts(13, w: 600)),
        const SizedBox(height: 7),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.line, width: 1.5),
          ),
          child: TextField(
            key: const Key('picker-address'),
            controller: _address,
            onChanged: (_) => setState(() {}),
            minLines: 1,
            maxLines: 3,
            maxLength: 255,
            style: ts(15, w: 500),
            decoration: InputDecoration(
              border: InputBorder.none,
              counterText: '',
              hintText: context.tr('locAddressHint'),
              hintStyle: ts(15, c: AppColors.muted),
            ),
          ),
        ),
        const SizedBox(height: 8),
        if (_addressState == _AddressState.loading)
          Row(
            key: const Key('picker-address-loading'),
            children: [
              const SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 8),
              Text(
                context.tr('locFinding'),
                style: ts(12.5, c: AppColors.slate),
              ),
            ],
          ),
        if (_addressState == _AddressState.none && _placed)
          Text(
            context.tr('locNoAddress'),
            key: const Key('picker-address-none'),
            style: ts(12.5, c: AppColors.slate),
          ),
        if (error)
          Row(
            children: [
              Expanded(
                child: Text(
                  _failureText(_addressFailure!),
                  key: const Key('picker-address-error'),
                  style: ts(12.5, c: AppColors.danger),
                ),
              ),
              if (_addressFailure != PlacesFailure.notConfigured)
                Tap(
                  onTap: _scheduleGeocode,
                  child: Text(
                    context.tr('locRetry'),
                    key: const Key('picker-address-retry'),
                    style: ts(12.5, w: 600, c: AppColors.primary),
                  ),
                ),
            ],
          ),
      ],
    );
  }

  Widget _labelBlock() {
    const choices = ['locLabelHome', 'locLabelWork', 'locLabelOther'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(context.tr('locLabel'), style: ts(13, w: 600)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (final c in choices)
              Tap(
                onTap: () =>
                    setState(() => _labelChoice = _labelChoice == c ? null : c),
                child: Container(
                  key: Key('picker-$c'),
                  height: 36,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: _labelChoice == c
                        ? AppColors.tealTint
                        : Colors.white,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(
                      color: _labelChoice == c
                          ? AppColors.tealBorder
                          : AppColors.line,
                      width: 1.5,
                    ),
                  ),
                  child: Text(
                    context.tr(c),
                    style: ts(
                      13.5,
                      w: 500,
                      c: _labelChoice == c ? AppColors.primary : AppColors.text,
                    ),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 10),
        _field(
          _labelCustom,
          'locLabelCustom',
          const Key('picker-label-custom'),
        ),
      ],
    );
  }

  Widget _field(
    TextEditingController c,
    String hintKey,
    Key key, {
    int maxLines = 1,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.line, width: 1.5),
      ),
      child: TextField(
        key: key,
        controller: c,
        maxLines: maxLines,
        maxLength: maxLines > 1 ? 500 : 60,
        style: ts(14),
        decoration: InputDecoration(
          border: InputBorder.none,
          counterText: '',
          hintText: context.tr(hintKey),
          hintStyle: ts(13, c: AppColors.muted),
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    super.key,
    required this.text,
    this.actionLabel,
    this.onAction,
  });

  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.cream,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.creamBorder),
      ),
      child: Row(
        children: [
          const AppIcon('info', size: 18, color: AppColors.creamDeep),
          const SizedBox(width: 10),
          Expanded(
            child: Text(text, style: ts(12.5, c: AppColors.creamDeep, h: 1.4)),
          ),
          if (actionLabel != null)
            Tap(
              onTap: onAction,
              child: Padding(
                padding: const EdgeInsetsDirectional.only(start: 10),
                child: Text(
                  actionLabel!,
                  style: ts(12.5, w: 700, c: AppColors.primary),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
