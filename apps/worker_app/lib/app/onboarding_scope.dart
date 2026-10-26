import 'package:flutter/widgets.dart';
import 'package:hs_client/hs_client.dart';

/// Makes the worker application (profile, documents, verification) available to the widget tree.
class OnboardingScope extends InheritedNotifier<WorkerOnboardingController> {
  const OnboardingScope({
    super.key,
    required WorkerOnboardingController controller,
    required super.child,
  }) : super(notifier: controller);

  static WorkerOnboardingController of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<OnboardingScope>();
    assert(scope != null, 'OnboardingScope not found in widget tree');
    return scope!.notifier!;
  }

  /// Reads the controller without subscribing to changes.
  static WorkerOnboardingController read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<OnboardingScope>();
    assert(scope != null, 'OnboardingScope not found in widget tree');
    return scope!.notifier!;
  }
}
