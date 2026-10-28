import 'package:customer_app/app/app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/testing.dart';

import 'location_picker_test.dart' show FakeDevice;

void main() {
  testWidgets(
    'asks the phone for location permission once the customer is signed in, not before and not twice',
    (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final kit = TestHsClient();
      final device = FakeDevice();
      await kit.client.auth.restore(); // nobody saved: signed out
      await tester.pumpWidget(App(client: kit.client, deviceLocation: device));
      await tester.pump(const Duration(milliseconds: 300));
      expect(device.requests, 0);

      await kit.client.auth.sendCode('+966501234567');
      await kit.client.auth.submitCode('123456');
      await tester.pump(const Duration(milliseconds: 300));
      expect(device.requests, 1);

      await kit.client.auth.signOut();
      await kit.client.auth.sendCode('+966501234567');
      await kit.client.auth.submitCode('123456');
      await tester.pump(const Duration(milliseconds: 300));
      expect(device.requests, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      kit.client.auth.dispose();
    },
  );
}
