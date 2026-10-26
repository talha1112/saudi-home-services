import 'package:flutter/material.dart';

import 'package:hs_client/hs_client.dart';

import '../../core/extensions/context_extensions.dart';
import '../booking_scope.dart';
import '../../features/authentication/screens/login_screen.dart';
import '../../features/authentication/screens/otp_screen.dart';
import '../../features/booking/screens/booking_screen.dart';
import '../../features/booking/screens/booking_sent_screen.dart';
import '../../features/bookings/screens/booking_detail_screen.dart';
import '../../features/bookings/screens/invoice_screen.dart';
import '../../features/home/screens/main_shell.dart';
import '../../features/location/models/picked_location.dart';
import '../../features/location/screens/location_picker_screen.dart';
import '../../features/messages/screens/chat_screen.dart';
import '../../features/notifications/screens/notifications_screen.dart';
import '../../features/messages/widgets/chat_target.dart';
import '../../features/onboarding/screens/onboarding_screen.dart';
import '../../features/payments/screens/confirm_screen.dart';
import '../../features/payments/screens/pay_screen.dart';
import '../../features/reviews/screens/rate_screen.dart';
import '../../features/services/screens/service_details_screen.dart';
import '../../features/services/screens/services_screen.dart';
import '../../features/tracking/screens/track_screen.dart';

/// Navigation helpers. Screens are pushed on a single [Navigator]; the main
/// tab shell is the route named [home].
abstract final class AppRouter {
  static const home = '/home';

  static Future<T?> _push<T>(BuildContext context, Widget page, String name) {
    return Navigator.of(context).push<T>(
      MaterialPageRoute<T>(
        builder: (_) => page,
        settings: RouteSettings(name: name),
      ),
    );
  }

  static void toOnboarding(BuildContext context, {bool showLanguage = false}) {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => OnboardingScreen(showLanguage: showLanguage),
        settings: const RouteSettings(name: '/onboarding'),
      ),
    );
  }

  static void toLogin(BuildContext context) {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => const LoginScreen(),
        settings: const RouteSettings(name: '/login'),
      ),
    );
  }

  /// Logout: back to the login screen with an empty history.
  static void toLoginReset(BuildContext context) {
    final app = context.appRead;
    final booking = BookingScope.of(context);
    booking.bookings.clear();
    booking.notifications.clear();
    booking.offers.clear();
    booking.submitter.reset();
    app.clearDraft();
    app.update(() {
      app.tab = 0;
      app.phone = '';
    });
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(
        builder: (_) => const LoginScreen(),
        settings: const RouteSettings(name: '/login'),
      ),
      (_) => false,
    );
  }

  static void toOtp(BuildContext context) =>
      _push(context, const OtpScreen(), '/otp');

  static void toHome(BuildContext context) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(
        builder: (_) => const MainShell(),
        settings: const RouteSettings(name: home),
      ),
      (_) => false,
    );
  }

  static void toServices(BuildContext context, {String category = 'all'}) =>
      _push(context, ServicesScreen(initialCategory: category), '/services');

  static void toDetails(BuildContext context, String serviceId) {
    final service = resolveService(context, serviceId);
    if (service == null) return;
    context.appRead.update(() => context.appRead.selectedService = service);
    _push(context, const ServiceDetailsScreen(), '/details');
  }

  static void toBooking(
    BuildContext context, {
    required String serviceId,
    int step = 1,
    int? date,
    int? slot,
  }) {
    final service = resolveService(context, serviceId);
    if (service == null) return;
    context.appRead.startBooking(service, date: date, slot: slot);
    BookingScope.of(context).submitter.reset();
    _push(context, BookingScreen(initialStep: step), '/booking');
  }

  /// After the backend created the request: drop the booking flow from the stack and show what it answered.
  static void toBookingSent(BuildContext context, BookingView booking) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(
        builder: (_) => BookingSentScreen(booking: booking),
        settings: const RouteSettings(name: '/booking-sent'),
      ),
      (route) => route.settings.name == home,
    );
  }

  /// Opens the map picker. Completes with the confirmed location, or null if the customer backed out.
  static Future<PickedLocation?> toLocationPicker(
    BuildContext context, {
    PickedLocation? initial,
  }) => _push<PickedLocation>(
    context,
    LocationPickerScreen(initial: initial),
    '/location-picker',
  );

  static void toPay(BuildContext context) =>
      _push(context, const PayScreen(), '/pay');

  /// After a successful payment: drop the booking flow from the stack.
  static void toConfirm(BuildContext context) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute<void>(
        builder: (_) => const ConfirmScreen(),
        settings: const RouteSettings(name: '/confirm'),
      ),
      (route) => route.settings.name == home,
    );
  }

  /// The customer's own booking in full: quotes to choose from, paying, and the confirmed booking.
  static void toBookingDetail(BuildContext context, String bookingId) => _push(
    context,
    BookingDetailScreen(bookingId: bookingId),
    '/booking-detail',
  );

  static Future<void> toNotifications(BuildContext context) =>
      _push(context, const NotificationsScreen(), '/notifications');

  static void toTrack(BuildContext context) =>
      _push(context, const TrackScreen(), '/track');

  /// The conversation of a booking with its assigned professional (without a target: the prototype chat, demo builds only).
  static void toChat(BuildContext context, {ChatTarget? target}) =>
      _push(context, ChatScreen(target: target), '/chat');

  static void toInvoice(BuildContext context) =>
      _push(context, const InvoiceScreen(), '/invoice');

  static void toRate(BuildContext context) =>
      _push(context, const RateScreen(), '/rate');

  /// Returns to the tab shell showing the bookings tab on [tab].
  static void toBookingsTab(BuildContext context, {required int tab}) {
    context.appRead.showTab(1, bookings: tab);
    Navigator.of(context).popUntil((route) => route.settings.name == home);
  }

  static void toHomeTab(BuildContext context) {
    context.appRead.showTab(0);
    Navigator.of(context).popUntil((route) => route.settings.name == home);
  }
}
