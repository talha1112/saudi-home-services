import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';

Future<TestHsClient> _kit() async {
  final kit = TestHsClient(kind: AppKind.worker, user: fakeUser(role: 'WORKER'));
  await kit.client.auth.sendCode('+966551234567');
  await kit.client.auth.submitCode('123456');
  return kit;
}

void main() {
  test('loads the switch and the cities the worker serves', () async {
    final kit = await _kit();
    kit.api.workerOnline = false;
    kit.api.workerCities.addAll(['c1', 'c2']);
    kit.api.cityNames.addAll({'c1': 'Riyadh', 'c2': 'Jeddah'});
    final p = PresenceController(api: kit.api, auth: kit.client.auth);
    expect(p.loaded, isFalse);
    await p.load();
    expect(p.loaded, isTrue);
    expect(p.online, isFalse);
    expect(p.cities.map((c) => c.nameEn), ['Riyadh', 'Jeddah']);
  });

  test('switching goes to the server and is kept', () async {
    final kit = await _kit();
    final p = PresenceController(api: kit.api, auth: kit.client.auth);
    await p.load();
    expect(p.online, isTrue);
    await p.setOnline(false);
    expect(p.online, isFalse);
    expect(kit.api.workerOnline, isFalse);
    await p.setOnline(true);
    expect(kit.api.workerOnline, isTrue);
  });

  test('a refusal puts the switch back and says so', () async {
    final kit = await _kit();
    final p = PresenceController(api: kit.api, auth: kit.client.auth);
    await p.load();
    kit.api.onlineResult = const ApiException(status: 403, code: 'WORKER_NOT_APPROVED');
    await p.setOnline(false);
    expect(p.online, isTrue);
    expect(p.error?.code, 'WORKER_NOT_APPROVED');
    expect(p.busy, isFalse);
  });
}
