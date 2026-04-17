// Minimal Flutter app used by the issue #423 live integration suite.
//
// Every interactive widget is wrapped in `Semantics(identifier:, label:)`
// so the opensafari accessibility bridge can locate it without relying on
// implementation-detail labels Flutter generates for raw widgets. The
// `status_label` Text is the canonical signal each test reads back to
// confirm a tap or keystroke actually landed on the right element — most
// other on-screen state is derivable from it.

import 'package:flutter/material.dart';

void main() => runApp(const OsfTestApp());

class OsfTestApp extends StatelessWidget {
  const OsfTestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OSF Test',
      theme: ThemeData(primarySwatch: Colors.blue),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _emailCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  int _taps = 0;
  String _status = 'idle';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Semantics(
          identifier: 'home_title',
          label: 'Home Title',
          child: const Text('OSF Test'),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Semantics(
              identifier: 'status_label',
              label: 'Status',
              child: Text('Status: $_status'),
            ),
            const SizedBox(height: 12),
            // Bare GestureDetector — intentionally NOT wrapped in Semantics so
            // it exposes a coordinate-only tap surface for the PointerService
            // live test (#590 Phase 1, `tests/integration/pointer-service.live.test.ts`).
            // Tap lands are observable via the `status_label` Semantics node
            // above: onTap sets _status = 'bare:<count>'.
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() {
                _taps++;
                _status = 'bare:$_taps';
              }),
              child: Container(
                height: 120,
                color: Colors.amber.shade200,
                alignment: Alignment.center,
                child: const Text(
                  'Bare tap region (no Semantics)',
                  style: TextStyle(fontWeight: FontWeight.w500),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Semantics(
              identifier: 'tap_count',
              label: 'Tap Count',
              child: Text('Taps: $_taps'),
            ),
            const SizedBox(height: 12),
            Semantics(
              identifier: 'email_field',
              label: 'Email',
              textField: true,
              child: TextField(
                controller: _emailCtrl,
                decoration: const InputDecoration(
                  labelText: 'Email',
                  border: OutlineInputBorder(),
                ),
                onChanged: (v) => setState(() => _status = 'email:$v'),
              ),
            ),
            const SizedBox(height: 12),
            Semantics(
              identifier: 'password_field',
              label: 'Password',
              textField: true,
              child: TextField(
                controller: _passCtrl,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'Password',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              identifier: 'login_btn',
              label: 'Login',
              button: true,
              child: ElevatedButton(
                onPressed: () => setState(() {
                  _taps++;
                  _status = 'login:${_emailCtrl.text}';
                }),
                child: const Text('Login'),
              ),
            ),
            const SizedBox(height: 12),
            Semantics(
              identifier: 'continue_btn',
              label: 'Continue',
              button: true,
              child: ElevatedButton(
                onPressed: () => setState(() {
                  _taps++;
                  _status = 'continue';
                }),
                child: const Text('Continue'),
              ),
            ),
            const SizedBox(height: 12),
            Semantics(
              identifier: 'next_btn',
              label: 'Next',
              button: true,
              child: ElevatedButton(
                onPressed: () {
                  Navigator.push(
                    context,
                    MaterialPageRoute(builder: (_) => const SecondScreen()),
                  );
                },
                child: const Text('Next'),
              ),
            ),
            const SizedBox(height: 24),
            // Many similarly-labeled rows — exercises ListView/ScrollView
            // taps and the index-based disambiguation path.
            for (int i = 0; i < 8; i++)
              Semantics(
                identifier: 'row_item',
                label: 'Row Item',
                button: true,
                child: ListTile(
                  title: Text('Row Item #$i'),
                  onTap: () => setState(() => _status = 'row:$i'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class SecondScreen extends StatefulWidget {
  const SecondScreen({super.key});

  @override
  State<SecondScreen> createState() => _SecondScreenState();
}

class _SecondScreenState extends State<SecondScreen> {
  String _msg = 'second_idle';
  final _nameCtrl = TextEditingController();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Second')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              identifier: 'second_status',
              label: 'Second Status',
              child: Text('Status: $_msg'),
            ),
            const SizedBox(height: 12),
            Semantics(
              identifier: 'name_field',
              label: 'Name',
              textField: true,
              child: TextField(
                controller: _nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  border: OutlineInputBorder(),
                ),
                onChanged: (v) => setState(() => _msg = 'name:$v'),
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              identifier: 'finish_btn',
              label: 'Finish',
              button: true,
              child: ElevatedButton(
                onPressed: () => setState(() => _msg = 'finished'),
                child: const Text('Finish'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
