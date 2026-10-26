import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../core/extensions/context_extensions.dart';
import '../jobs_scope.dart';
import '../../features/authentication/screens/otp_screen.dart';
import '../../features/dashboard/screens/main_shell.dart';
import '../../features/jobs/screens/active_job_screen.dart';
import '../../features/jobs/screens/demo_active_job_screen.dart';
import '../../features/messages/screens/chat_screen.dart';
import '../../features/messages/widgets/chat_target.dart';
import '../../features/notifications/screens/notifications_screen.dart';
import '../../features/onboarding/screens/welcome_screen.dart';
import '../../features/quotes/screens/quote_screen.dart';
import '../../features/quotes/screens/quote_status_screen.dart';
import '../../features/quotes/screens/send_quote_screen.dart';
import '../../features/requests/screens/request_detail_screen.dart';
import '../../features/requests/screens/request_screen.dart';
import '../../features/subscriptions/screens/subscription_screen.dart';
import '../../features/verification/screens/apply_screen.dart';
import '../../features/verification/screens/status_screen.dart';

/// Navigation helpers. Screens are pushed on a single [Navigator]; the main
/// tab shell is the route named [home].
abstract final class AppRouter {
  static const home = '/home';

  static MaterialPageRoute<T> _route<T>(Widget page, String name) =>
      MaterialPageRoute<T>(
        builder: (_) => page,
        settings: RouteSettings(name: name),
      );

  static Future<T?> _push<T>(BuildContext context, Widget page, String name) =>
      Navigator.of(context).push<T>(_route<T>(page, name));

  static void toOtp(BuildContext context) =>
      _push(context, const OtpScreen(), '/otp');

  /// After the code is entered: the application replaces the sign-in screens.
  static void toApply(BuildContext context) {
    Navigator.of(context).pushAndRemoveUntil(
      _route<void>(const ApplyScreen(), '/apply'),
      (_) => false,
    );
  }

  /// The status screen replaces everything before it (after submitting, or when the server says the application is pending).
  static void toStatusReset(BuildContext context) {
    Navigator.of(context).pushAndRemoveUntil(
      _route<void>(const StatusScreen(), '/status'),
      (_) => false,
    );
  }

  /// Where a signed-in worker belongs, from the approval status the server reports. Only an approved worker reaches the dashboard.
  static void afterSignIn(BuildContext context, AuthUser user) {
    switch (user.workerVerificationStatus) {
      case 'APPROVED':
        toHome(context);
      case 'SUBMITTED' ||
          'UNDER_REVIEW' ||
          'INFO_REQUIRED' ||
          'REJECTED' ||
          'SUSPENDED':
        Navigator.of(context).pushAndRemoveUntil(
          _route<void>(const StatusScreen(), '/status'),
          (_) => false,
        );
      default: // NOT_SUBMITTED, or nothing known yet: start (or finish) the application
        toApply(context);
    }
  }

  static void toStatus(BuildContext context) =>
      _push(context, const StatusScreen(), '/status');

  /// Dashboard with an empty history (after approval).
  static void toHome(BuildContext context) {
    context.appRead.showTab(0);
    Navigator.of(
      context,
    ).pushAndRemoveUntil(_route<void>(const MainShell(), home), (_) => false);
  }

  /// Log out: back to the welcome screen with an empty history.
  static void toWelcomeReset(BuildContext context) {
    final app = context.appRead;
    final jobs = JobsScope.of(context);
    jobs.jobs.clear();
    jobs.quotes.reset();
    jobs.notifications.clear();
    jobs.reviews.clear();
    app.update(() {
      app.tab = 0;
      app.phone = '';
    });
    Navigator.of(context).pushAndRemoveUntil(
      _route<void>(const WelcomeScreen(), '/welcome'),
      (_) => false,
    );
  }

  static void toNotifications(BuildContext context) =>
      _push(context, const NotificationsScreen(), '/notifications');

  /// An open request from the backend (the area only; the street address is never part of it).
  static void toRequestDetail(BuildContext context, WorkerRequest request) =>
      _push(context, RequestDetailScreen(request: request), '/request');

  static void toSendQuote(BuildContext context, WorkerRequest request) {
    JobsScope.of(context).quotes.clearFailure();
    _push(context, SendQuoteScreen(request: request), '/send-quote');
  }

  /// A job assigned to this worker.
  static void toJob(BuildContext context, String jobId) =>
      _push(context, ActiveJobScreen(jobId: jobId), '/job');

  /// PROTOTYPE screens (demo builds only).
  static void toRequest(BuildContext context) =>
      _push(context, const RequestScreen(), '/request');

  static void toQuote(BuildContext context) =>
      _push(context, const QuoteScreen(), '/quote');

  static void toQuoteStatus(BuildContext context, {bool replace = false}) {
    final route = _route<void>(const QuoteStatusScreen(), '/quote-status');
    if (replace) {
      Navigator.of(context).pushReplacement(route);
    } else {
      Navigator.of(context).push(route);
    }
  }

  static void toActive(BuildContext context) =>
      _push(context, const DemoActiveJobScreen(), '/active');

  /// The conversation of a booking with its customer (without a target: the prototype chat, demo builds only).
  static void toChat(BuildContext context, {ChatTarget? target}) =>
      _push(context, ChatScreen(target: target), '/chat');

  /// The worker's conversation with the administrators. Open to every worker, approved or not.
  static void toSupport(BuildContext context) => _push(
    context,
    ChatScreen(
      target: ChatTarget.support(
        peerName: context.tr('supTitle'),
        subtitle: context.tr('supSub'),
      ),
    ),
    '/support',
  );

  static void toSubscription(BuildContext context) =>
      _push(context, const SubscriptionScreen(), '/subscription');

  static void _toTab(BuildContext context, int tab, {int? jobs}) {
    context.appRead.showTab(tab, jobs: jobs);
    final nav = Navigator.of(context);
    if (nav.canPop()) {
      nav.popUntil((route) => route.settings.name == home || route.isFirst);
    }
  }

  static void toHomeTab(BuildContext context) => _toTab(context, 0);

  static void toJobsTab(BuildContext context, {required int tab}) =>
      _toTab(context, 1, jobs: tab);

  static void toProfileTab(BuildContext context) => _toTab(context, 3);
}
