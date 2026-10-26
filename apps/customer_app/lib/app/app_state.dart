import 'package:flutter/material.dart';

import '../core/config/demo_data.dart';
import '../features/booking/logic/booking_schedule.dart';
import '../features/booking/logic/booking_submitter.dart';
import '../features/location/models/picked_location.dart';
import '../shared/models/mock_data.dart';
import '../shared/models/service.dart';

/// In-memory UI state: language, the tab shell, and the booking the customer is putting together (the choices only; sending it is
/// [BookingSubmitter]'s job). The quote / payment / tracking fields further down belong to the prototype screens, which only exist in
/// demo builds ([kDemoData]).
class AppState extends ChangeNotifier {
  // Language
  bool _arabic = false;
  bool get isArabic => _arabic;
  void setArabic(bool value) {
    if (_arabic == value) return;
    _arabic = value;
    notifyListeners();
  }

  // Sign-in (UI only)
  String phone = '';

  // Main tab shell
  int tab = 0;
  int bookingsTab = kDemoData ? 1 : 0;
  void showTab(int index, {int? bookings}) {
    tab = index;
    if (bookings != null) bookingsTab = bookings;
    notifyListeners();
  }

  // Selected service and booking draft
  /// The service being booked. In a real build this is always a catalog service (its id is the backend's UUID).
  Service? selectedService;
  String? get serviceId => selectedService?.id;

  /// Only the prototype screens (demo builds) read this without a selection.
  Service get service => selectedService ?? kServices.first;

  /// The city chosen for the booking (a backend city id).
  String? cityId;

  /// Index into the (prototype) saved addresses, or [customAddress] when the location chosen on the map is selected.
  int addressIndex = 0;
  static const customAddress = -1;

  /// The service location confirmed on the map for the booking in progress (not yet saved to the backend).
  PickedLocation? pickedLocation;
  bool asap = false;
  int dateIndex = 0;
  int slotIndex = -1;
  String description = '';

  BookingDraft get draft => BookingDraft(
    serviceId: serviceId,
    cityId: cityId,
    description: description,
    location: pickedLocation,
    asap: asap,
    dayIndex: dateIndex,
    slotIndex: slotIndex,
  );

  int quoteIndex = 0;
  final List<int> rejectedQuotes = [];
  Worker get worker => kWorkers[quoteIndex];

  String payMethod = 'mada';

  // Booking lifecycle (0..6, see tracking stages)
  int stage = 3;
  bool cancelled = false;
  bool showActiveBooking = kDemoData;
  bool get isDone => stage == 6;
  bool get hasActive => showActiveBooking && !cancelled && !isDone;

  /// Demo toggle: the first payment attempt fails when true.
  bool simulatePayFailure = false;

  // Pricing for the selected quote
  int get gross => worker.quote;
  int get discount => service.was != null ? (gross * 0.2).round() : 0;
  int get subtotal => gross - discount;
  int get vat => (subtotal * 0.15).round();
  int get total => subtotal + vat;
  int get cancellationFee => stage >= 3 ? kMinCharge : 0;

  void update(VoidCallback change) {
    change();
    notifyListeners();
  }

  /// Starts a fresh booking for [service]: nothing from an earlier one carries over (the city stays, as it rarely changes).
  void startBooking(Service service, {int? date, int? slot}) {
    selectedService = service;
    pickedLocation = null;
    addressIndex = AppState.customAddress;
    asap = false;
    dateIndex = date ?? 0;
    slotIndex = slot ?? -1;
    description = '';
    rejectedQuotes.clear();
    notifyListeners();
  }

  /// Forgets the booking in progress (on sign-out, so the next account starts clean).
  void clearDraft() {
    selectedService = null;
    cityId = null;
    pickedLocation = null;
    asap = false;
    dateIndex = 0;
    slotIndex = -1;
    description = '';
    rejectedQuotes.clear();
    notifyListeners();
  }

  /// Label for the selected date and time, e.g. "Today · 6:00 PM".
  String whenLabel(bool ar) => whenText(
    asap: asap,
    dayIndex: dateIndex,
    slotIndex: slotIndex,
    nowUtc: DateTime.now().toUtc(),
    arabic: ar,
  );
}
