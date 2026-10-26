import 'package:flutter/widgets.dart';
import 'package:hs_client/hs_client.dart';

import '../core/config/demo_data.dart';
import '../shared/models/mock_data.dart';
import '../shared/models/service.dart';
import '../features/booking/logic/booking_submitter.dart';
import '../features/bookings/logic/booking_detail_controller.dart';
import '../features/bookings/logic/worker_position_controller.dart';
import '../features/bookings/my_bookings_controller.dart';
import '../features/catalog/catalog_controller.dart';

/// The controllers behind the real booking flow, available to every screen.
class BookingServices {
  const BookingServices({
    required this.catalog,
    required this.submitter,
    required this.bookings,
    required this.detailFor,
    required this.positionFor,
    required this.notifications,
    required this.offers,
    required this.openFromNotification,
  });
  final CatalogController catalog;
  final BookingSubmitter submitter;
  final MyBookingsController bookings;

  /// A controller for one booking's details (quotes, choosing one, paying); the screen that asks owns and disposes it.
  final BookingDetailController Function(String bookingId) detailFor;

  /// The professional's live position for one booking, refreshed every `interval` once started; the widget that asks owns and disposes it.
  final WorkerPositionController Function(String bookingId, Duration interval)
  positionFor;

  /// The bell: the customer's notifications and how many are unread.
  final NotificationsController notifications;

  /// The offers published for customers.
  final OffersController offers;

  /// Opens what a notification is about (the booking, or its chat), the same way a tapped push does.
  final Future<void> Function(PushEvent event) openFromNotification;
}

class BookingScope extends InheritedWidget {
  const BookingScope({super.key, required this.services, required super.child});

  final BookingServices services;

  static BookingServices of(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<BookingScope>();
    assert(scope != null, 'BookingScope not found in widget tree');
    return scope!.services;
  }

  @override
  bool updateShouldNotify(BookingScope oldWidget) =>
      services != oldWidget.services;
}

/// The service for [id]: from the backend catalog, or (demo builds only) from the prototype fixtures. Null if it is neither, so a stale
/// or invented id can never start a booking.
Service? resolveService(BuildContext context, String id) {
  final fromCatalog = BookingScope.of(context).catalog.serviceById(id);
  if (fromCatalog != null) return fromCatalog;
  if (!kDemoData) return null;
  for (final s in kServices) {
    if (s.id == id) return s;
  }
  return null;
}
