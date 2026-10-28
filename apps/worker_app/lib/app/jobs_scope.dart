import 'package:flutter/widgets.dart';
import 'package:hs_client/hs_client.dart';

import '../features/jobs/logic/position_sharer.dart';
import '../features/jobs/logic/worker_jobs_controller.dart';
import '../features/quotes/logic/quote_submitter.dart';

/// The controllers behind the real request / quote / job flow, available to every screen.
class JobsServices {
  const JobsServices({
    required this.jobs,
    required this.quotes,
    required this.sharer,
    required this.notifications,
    required this.reviews,
    required this.presence,
    required this.openFromNotification,
  });
  final WorkerJobsController jobs;

  /// Sends the worker's position to the customer of a paid job that is waiting or under way.
  final PositionSharer sharer;
  final QuoteSubmitter quotes;

  /// The worker's notifications and how many are unread.
  final NotificationsController notifications;

  /// The reviews customers wrote about this worker, with the average.
  final ReviewsController reviews;

  /// The online switch of the home tab, and the cities the worker serves.
  final PresenceController presence;

  /// Opens what a notification is about, the same way a tapped push does.
  final Future<void> Function(PushEvent event) openFromNotification;
}

class JobsScope extends InheritedWidget {
  const JobsScope({super.key, required this.services, required super.child});

  final JobsServices services;

  static JobsServices of(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<JobsScope>();
    assert(scope != null, 'JobsScope not found in widget tree');
    return scope!.services;
  }

  @override
  bool updateShouldNotify(JobsScope oldWidget) =>
      services != oldWidget.services;
}
